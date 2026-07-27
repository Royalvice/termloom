import { access, stat as localStat } from "node:fs/promises";
import { basename, dirname, extname, join, posix } from "node:path";
import { z } from "zod";
import { TermLoomError, errorMessage } from "../core/errors.js";
import { redactText, runProcess } from "../process/process-runner.js";
import type { SshClient } from "../ssh/client.js";
import { TransferQueue, type TransferHandle, type TransferProgress } from "./transfer-queue.js";

const RcloneEntrySchema = z
  .object({
    Path: z.string(),
    Name: z.string(),
    Size: z.number(),
    MimeType: z.string().optional(),
    ModTime: z.string().optional(),
    IsDir: z.boolean(),
    Hashes: z.record(z.string(), z.string()).optional(),
  })
  .passthrough();

export type ConflictPolicy = "error" | "overwrite" | "skip" | "rename";

export interface RemoteFileEntry {
  name: string;
  path: string;
  size: number;
  isDirectory: boolean;
  mimeType?: string;
  modifiedAt?: Date;
  hashes: Readonly<Record<string, string>>;
}

export interface DirectoryPage {
  path: string;
  entries: readonly RemoteFileEntry[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface FileOperationResult {
  status: "completed" | "skipped";
  destination: string;
}

export interface RcloneSftpOptions {
  binary?: string;
  configFile?: string;
  operationTimeoutMs?: number;
  transferBandwidthLimit?: string;
  queue?: TransferQueue;
  debug?: boolean;
}

export class RcloneSftpService {
  public readonly queue: TransferQueue;
  public readonly binary: string;
  private readonly configFile: string;
  private readonly operationTimeoutMs: number;
  private readonly transferBandwidthLimit: string | undefined;
  private readonly debug: boolean;

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
    this.queue = options.queue ?? new TransferQueue(2);
  }

  public async version(): Promise<string> {
    const result = await runProcess(this.binary, ["version"], { timeoutMs: 5_000 });
    return result.stdout.split(/\r?\n/)[0]?.trim() ?? "";
  }

  public async list(
    hostId: string,
    path: string,
    options: { page?: number; pageSize?: number; query?: string } = {},
  ): Promise<DirectoryPage> {
    const result = await this.execute(hostId, ["lsjson", remote(path), "--max-depth", "1"]);
    const parsed = z.array(RcloneEntrySchema).parse(JSON.parse(result.stdout));
    const query = options.query?.trim().toLocaleLowerCase();
    const entries = parsed
      .map((entry) => toEntry(path, entry))
      .filter((entry) => !query || entry.name.toLocaleLowerCase().includes(query))
      .sort(compareEntries);
    const pageSize = clampInteger(options.pageSize ?? 100, 1, 1_000);
    const totalPages = Math.max(1, Math.ceil(entries.length / pageSize));
    const page = clampInteger(options.page ?? 1, 1, totalPages);
    const offset = (page - 1) * pageSize;
    return {
      path,
      entries: entries.slice(offset, offset + pageSize),
      page,
      pageSize,
      total: entries.length,
      totalPages,
    };
  }

  public async stat(hostId: string, path: string): Promise<RemoteFileEntry> {
    const result = await this.execute(hostId, ["lsjson", remote(path), "--stat"]);
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

  public async delete(hostId: string, path: string): Promise<void> {
    const entry = await this.stat(hostId, path);
    await this.execute(hostId, [entry.isDirectory ? "purge" : "deletefile", remote(path)]);
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

  private async statIfExists(hostId: string, path: string): Promise<RemoteFileEntry | null> {
    const result = await this.execute(hostId, ["lsjson", remote(path), "--stat"], true);
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
}

function toEntry(
  base: string,
  value: z.infer<typeof RcloneEntrySchema>,
  exactPath?: string,
): RemoteFileEntry {
  const modifiedAt = value.ModTime ? new Date(value.ModTime) : undefined;
  return {
    name: exactPath ? posix.basename(exactPath) : value.Name,
    path: exactPath ?? posix.join(base, value.Path),
    size: value.Size,
    isDirectory: value.IsDir,
    mimeType: value.MimeType || undefined,
    modifiedAt: modifiedAt && !Number.isNaN(modifiedAt.valueOf()) ? modifiedAt : undefined,
    hashes: value.Hashes ?? {},
  };
}

function compareEntries(left: RemoteFileEntry, right: RemoteFileEntry): number {
  if (left.isDirectory !== right.isDirectory) return left.isDirectory ? -1 : 1;
  return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" });
}

function remote(path: string): string {
  if (/[\0\r\n]/.test(path)) throw new Error("Remote path contains a control character");
  return `:sftp:${path}`;
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, Math.floor(value)));
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

function cancelled(): TermLoomError {
  return new TermLoomError({ code: "PROCESS_CANCELLED", message: "rclone transfer was cancelled" });
}

export function describeRcloneError(error: unknown): string {
  return redactText(errorMessage(error));
}
