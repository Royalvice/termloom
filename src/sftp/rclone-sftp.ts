import { access, stat as localStat } from "node:fs/promises";
import { basename, dirname, extname, join, posix } from "node:path";
import { z } from "zod";
import { errorMessage, TermLoomError } from "../core/errors.js";
import {
  type ConflictPolicy,
  type DirectoryPage,
  type DirectoryQuery,
  type FileEntry,
  type FileOperationResult,
  type FileProvider,
  paginateEntries,
} from "../files/file-provider.js";
import type { SftpProviderFactory } from "../files/file-provider-router.js";
import { redactText, runProcess } from "../process/process-runner.js";
import type { SshClient } from "../ssh/client.js";
import type { HostConnectionCoordinator } from "../ssh/connection-coordinator.js";
import { type TransferHandle, type TransferProgress, TransferQueue } from "./transfer-queue.js";

const RcloneEntrySchema = z
  .object({
    Path: z.string(),
    Name: z.string(),
    Size: z.number(),
    MimeType: z.string().optional(),
    ModTime: z.string().optional(),
    IsDir: z.boolean(),
    Hashes: z.record(z.string(), z.string()).optional(),
    Metadata: z.record(z.string(), z.string()).optional(),
  })
  .passthrough();

export interface RcloneSftpOptions {
  binary?: string;
  configFile?: string;
  operationTimeoutMs?: number;
  transferBandwidthLimit?: string;
  queue?: TransferQueue;
  debug?: boolean;
  connections?: HostConnectionCoordinator;
}

export class RcloneSftpService implements SftpProviderFactory {
  public readonly queue: TransferQueue;
  public readonly binary: string;
  private readonly configFile: string;
  private readonly operationTimeoutMs: number;
  private readonly transferBandwidthLimit: string | undefined;
  private readonly debug: boolean;
  private readonly connections: HostConnectionCoordinator | undefined;
  private readonly providers = new Map<string, FileProvider>();

  public constructor(
    private readonly ssh: SshClient,
    options: RcloneSftpOptions = {},
  ) {
    const binary = options.binary ?? Bun.which("rclone");
    if (!binary) {
      throw new TermLoomError({
        code: "DEPENDENCY_MISSING",
        message: "rclone was not found",
        hint: "Install rclone and run termloom doctor again.",
        details: { dependency: "rclone" },
      });
    }
    this.binary = binary;
    this.configFile = options.configFile ?? "/dev/null";
    this.operationTimeoutMs = options.operationTimeoutMs ?? 30_000;
    this.transferBandwidthLimit = options.transferBandwidthLimit;
    this.debug = options.debug ?? false;
    this.connections = options.connections;
    this.queue = options.queue ?? new TransferQueue(2);
  }

  public async version(): Promise<string> {
    const result = await runProcess(this.binary, ["version"], { timeoutMs: 5_000 });
    return result.stdout.split(/\r?\n/)[0]?.trim() ?? "";
  }

  public async list(
    hostId: string,
    path: string,
    options: DirectoryQuery = {},
  ): Promise<DirectoryPage> {
    const result = await this.execute(hostId, [
      "lsjson",
      remote(path),
      "--max-depth",
      "1",
      "--metadata",
    ]);
    const parsed = z.array(RcloneEntrySchema).parse(JSON.parse(result.stdout));
    return paginateEntries(
      path,
      parsed.map((entry) => toEntry(path, entry)),
      options,
    );
  }

  public async stat(hostId: string, path: string): Promise<FileEntry> {
    const result = await this.execute(hostId, ["lsjson", remote(path), "--stat", "--metadata"]);
    return toEntry(posix.dirname(path), RcloneEntrySchema.parse(JSON.parse(result.stdout)), path);
  }

  public async mkdir(hostId: string, path: string): Promise<void> {
    await this.execute(hostId, ["mkdir", remote(path)]);
  }

  public async touch(hostId: string, path: string): Promise<void> {
    await this.execute(hostId, ["touch", remote(path)]);
  }

  public async rename(
    hostId: string,
    source: string,
    destination: string,
    policy: ConflictPolicy = "error",
  ): Promise<FileOperationResult> {
    return this.move(hostId, source, destination, policy);
  }

  public async copy(
    hostId: string,
    source: string,
    destination: string,
    policy: ConflictPolicy = "error",
  ): Promise<FileOperationResult> {
    return this.copyOrMove("copyto", hostId, source, destination, policy);
  }

  public async move(
    hostId: string,
    source: string,
    destination: string,
    policy: ConflictPolicy = "error",
  ): Promise<FileOperationResult> {
    return this.copyOrMove("moveto", hostId, source, destination, policy);
  }

  public upload(
    hostId: string,
    localPath: string,
    remotePath: string,
    policy: ConflictPolicy = "error",
  ): TransferHandle {
    return this.queue.enqueue(
      { direction: "upload", source: localPath, destination: remotePath },
      async ({ signal, report }) => {
        await access(localPath);
        const resolved = await this.resolveRemoteDestination(hostId, remotePath, policy);
        if (resolved === null) return { destination: remotePath, skipped: true };
        const source = await localStat(localPath);
        report({ bytes: 0, totalBytes: source.size });
        await this.runTransfer(hostId, ["copyto", localPath, remote(resolved)], signal, report);
        return { destination: resolved };
      },
    );
  }

  public download(
    hostId: string,
    remotePath: string,
    localPath: string,
    policy: ConflictPolicy = "error",
  ): TransferHandle {
    return this.queue.enqueue(
      { direction: "download", source: remotePath, destination: localPath },
      async ({ signal, report }) => {
        const source = await this.stat(hostId, remotePath);
        if (source.isDirectory) {
          throw new TermLoomError({
            code: "PROCESS_FAILED",
            message: `Download source is a directory: ${remotePath}`,
          });
        }
        const resolved = await resolveLocalDestination(localPath, policy);
        if (resolved === null) return { destination: localPath, skipped: true };
        report({ bytes: 0, totalBytes: source.size });
        await this.runTransfer(hostId, ["copyto", remote(remotePath), resolved], signal, report);
        return { destination: resolved };
      },
    );
  }

  private async copyOrMove(
    command: "copyto" | "moveto",
    hostId: string,
    source: string,
    destination: string,
    policy: ConflictPolicy,
  ): Promise<FileOperationResult> {
    const resolved = await this.resolveRemoteDestination(hostId, destination, policy);
    if (resolved === null) return { status: "skipped", destination };
    await this.execute(hostId, [command, remote(source), remote(resolved)]);
    return { status: "completed", destination: resolved };
  }

  private async resolveRemoteDestination(
    hostId: string,
    path: string,
    policy: ConflictPolicy,
  ): Promise<string | null> {
    const existing = await this.statIfExists(hostId, path);
    if (!existing || policy === "overwrite") return path;
    if (policy === "skip") return null;
    if (policy === "error") throw conflict(path);
    for (let index = 1; index <= 10_000; index += 1) {
      const candidate = numberedRemotePath(path, index);
      if (!(await this.statIfExists(hostId, candidate))) return candidate;
    }
    throw new TermLoomError({
      code: "TRANSFER_CONFLICT",
      message: `Unable to find a free destination name for ${path}`,
    });
  }

  private async statIfExists(hostId: string, path: string): Promise<FileEntry | null> {
    const result = await this.execute(
      hostId,
      ["lsjson", remote(path), "--stat", "--metadata"],
      true,
    );
    if (result.exitCode === 0) {
      return toEntry(posix.dirname(path), RcloneEntrySchema.parse(JSON.parse(result.stdout)), path);
    }
    if (/not found|doesn't exist|directory not found|object not found/i.test(result.stderr))
      return null;
    throw new TermLoomError({
      code: "PROCESS_FAILED",
      message: `rclone stat failed: ${redactText(result.stderr.trim())}`,
      details: { hostId, path, exitCode: result.exitCode },
    });
  }

  private async execute(hostId: string, args: readonly string[], allowNonZero = false) {
    await this.requireMaster(hostId);
    return runProcess(
      this.binary,
      [...args, ...(this.debug ? ["-vv"] : []), ...this.connectionFlags(hostId)],
      {
        timeoutMs: this.operationTimeoutMs,
        allowNonZero,
      },
    );
  }

  private async requireMaster(hostId: string): Promise<void> {
    await this.connections?.ensureConnected(hostId);
    if (await this.ssh.checkMaster(hostId)) return;
    throw new TermLoomError({
      code: "PROCESS_FAILED",
      message: `No authenticated OpenSSH ControlMaster for ${hostId}`,
      hint: "Connect to the host in a terminal pane before using SFTP.",
      details: { hostId },
    });
  }

  private connectionFlags(hostId: string): string[] {
    return ["--config", this.configFile, "--sftp-ssh", this.ssh.externalCommand(hostId)];
  }

  private async runTransfer(
    hostId: string,
    args: readonly string[],
    signal: AbortSignal,
    report: (progress: TransferProgress) => void,
  ): Promise<void> {
    await this.requireMaster(hostId);
    if (signal.aborted) throw cancelled();
    const transferArgs = [
      ...args,
      "--use-json-log",
      "--stats",
      "100ms",
      "--stats-log-level",
      "NOTICE",
      "--log-level",
      "INFO",
      "--retries",
      "1",
      "--low-level-retries",
      "1",
      ...(this.transferBandwidthLimit ? ["--bwlimit", this.transferBandwidthLimit] : []),
      ...this.connectionFlags(hostId),
    ];
    const subprocess = Bun.spawn([this.binary, ...transferArgs], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const abort = () => subprocess.kill("SIGTERM");
    signal.addEventListener("abort", abort, { once: true });
    let diagnostics = "";
    try {
      const stdout = new Response(subprocess.stdout).text();
      const stderr = consumeLines(subprocess.stderr, (line) => {
        diagnostics = `${diagnostics}${line}\n`.slice(-16_384);
        const progress = parseProgress(line);
        if (progress) report(progress);
      });
      const [exitCode] = await Promise.all([subprocess.exited, stdout, stderr]);
      if (signal.aborted) throw cancelled();
      if (exitCode !== 0) {
        throw new TermLoomError({
          code: "PROCESS_FAILED",
          message: `rclone transfer failed with status ${exitCode}: ${redactText(diagnostics.trim())}`,
          details: { hostId, exitCode },
        });
      }
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }

  public forHost(hostId: string): FileProvider {
    const existing = this.providers.get(hostId);
    if (existing) return existing;
    const provider = new RcloneHostFileProvider(this, hostId);
    this.providers.set(hostId, provider);
    return provider;
  }
}

class RcloneHostFileProvider implements FileProvider {
  public readonly kind = "sftp" as const;
  public readonly queue: TransferQueue;

  public constructor(
    private readonly service: RcloneSftpService,
    private readonly hostId: string,
  ) {
    this.queue = service.queue;
  }

  public list(path: string, options?: DirectoryQuery): Promise<DirectoryPage> {
    return this.service.list(this.hostId, path, options);
  }

  public stat(path: string): Promise<FileEntry> {
    return this.service.stat(this.hostId, path);
  }

  public createDirectory(path: string): Promise<void> {
    return this.service.mkdir(this.hostId, path);
  }

  public createFile(path: string): Promise<void> {
    return this.service.touch(this.hostId, path);
  }

  public rename(
    source: string,
    destination: string,
    policy?: ConflictPolicy,
  ): Promise<FileOperationResult> {
    return this.service.rename(this.hostId, source, destination, policy);
  }

  public copy(
    source: string,
    destination: string,
    policy?: ConflictPolicy,
  ): Promise<FileOperationResult> {
    return this.service.copy(this.hostId, source, destination, policy);
  }

  public move(
    source: string,
    destination: string,
    policy?: ConflictPolicy,
  ): Promise<FileOperationResult> {
    return this.service.move(this.hostId, source, destination, policy);
  }

  public upload(localPath: string, remotePath: string, policy?: ConflictPolicy): TransferHandle {
    return this.service.upload(this.hostId, localPath, remotePath, policy);
  }

  public download(remotePath: string, localPath: string, policy?: ConflictPolicy): TransferHandle {
    return this.service.download(this.hostId, remotePath, localPath, policy);
  }
}

function toEntry(
  base: string,
  value: z.infer<typeof RcloneEntrySchema>,
  exactPath?: string,
): FileEntry {
  const modifiedAt = value.ModTime ? new Date(value.ModTime) : undefined;
  const metadata = value.Metadata ?? {};
  const { mode, type, uid, gid } = metadata;
  return {
    name: exactPath ? posix.basename(exactPath) : value.Name,
    path: exactPath ?? posix.join(base, value.Path),
    size: value.Size,
    isDirectory: value.IsDir,
    isSymbolicLink: /^l/i.test(mode ?? "") || type === "symlink",
    mimeType: value.MimeType || undefined,
    modifiedAt: modifiedAt && !Number.isNaN(modifiedAt.valueOf()) ? modifiedAt : undefined,
    mode: parseMode(mode),
    uid: parseInteger(uid),
    gid: parseInteger(gid),
    hashes: value.Hashes ?? {},
  };
}

function remote(path: string): string {
  if (/[\0\r\n]/.test(path)) throw new Error("Remote path contains a control character");
  return `:sftp:${path}`;
}

function numberedRemotePath(path: string, index: number): string {
  const extension = posix.extname(path);
  const stem = extension ? path.slice(0, -extension.length) : path;
  return `${stem} (${index})${extension}`;
}

async function resolveLocalDestination(
  path: string,
  policy: ConflictPolicy,
): Promise<string | null> {
  if (!(await localExists(path)) || policy === "overwrite") return path;
  if (policy === "skip") return null;
  if (policy === "error") throw conflict(path);
  const extension = extname(path);
  const stem = extension ? basename(path, extension) : basename(path);
  for (let index = 1; index <= 10_000; index += 1) {
    const candidate = join(dirname(path), `${stem} (${index})${extension}`);
    if (!(await localExists(candidate))) return candidate;
  }
  throw new TermLoomError({
    code: "TRANSFER_CONFLICT",
    message: `Unable to find a free destination name for ${path}`,
  });
}

async function localExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function conflict(path: string): TermLoomError {
  return new TermLoomError({
    code: "TRANSFER_CONFLICT",
    message: `Destination already exists: ${path}`,
    hint: "Choose overwrite, skip, or rename explicitly.",
    details: { path },
  });
}

async function consumeLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  while (true) {
    const { value, done } = await reader.read();
    buffered += decoder.decode(value, { stream: !done });
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop() ?? "";
    for (const line of lines) onLine(line);
    if (done) break;
  }
  if (buffered) onLine(buffered);
}

function parseProgress(line: string): TransferProgress | null {
  try {
    const parsed = JSON.parse(line) as {
      stats?: {
        bytes?: unknown;
        totalBytes?: unknown;
        speed?: unknown;
        eta?: unknown;
      };
    };
    const stats = parsed.stats;
    if (!stats) return null;
    return {
      bytes: numeric(stats.bytes) ?? 0,
      totalBytes: numeric(stats.totalBytes),
      speedBytesPerSecond: numeric(stats.speed),
      etaSeconds: numeric(stats.eta),
    };
  } catch {
    return null;
  }
}

function numeric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseInteger(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function parseMode(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const octal = value.match(/(?:^|\s)([0-7]{3,4})$/)?.[1];
  if (octal) return Number.parseInt(octal, 8);
  const symbolic = value.match(/^[dl-]?([rwxstST-]{9})$/)?.[1];
  if (!symbolic) return undefined;
  let mode = 0;
  const weights = [0o400, 0o200, 0o100, 0o040, 0o020, 0o010, 0o004, 0o002, 0o001];
  for (let index = 0; index < symbolic.length; index += 1) {
    if (symbolic[index] !== "-") mode |= weights[index] ?? 0;
  }
  return mode;
}

function cancelled(): TermLoomError {
  return new TermLoomError({ code: "PROCESS_CANCELLED", message: "rclone transfer was cancelled" });
}

export function describeRcloneError(error: unknown): string {
  return redactText(errorMessage(error));
}
