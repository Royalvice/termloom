import { once } from "node:events";
import { posix } from "node:path";
import { parse } from "csv-parse";
import { z } from "zod";
import { errorMessage, TermLoomError } from "../core/errors.js";
import {
  type DirectoryPage,
  type DirectoryQuery,
  type FileEntry,
  type FileProvider,
  type FileStatOptions,
  paginateEntries,
} from "../files/file-provider.js";
import type { SftpProviderFactory } from "../files/file-provider-router.js";
import { redactText, runProcess } from "../process/process-runner.js";
import type { SshClient } from "../ssh/client.js";
import type { HostConnectionCoordinator } from "../ssh/connection-coordinator.js";
import type {
  RemoteDirectoryManifest,
  RemoteDownloadTransport,
  RemoteDownloadTransportContext,
} from "./remote-download-service.js";
import type {
  RemoteMaterializeOptions,
  RemoteReadOptions,
  RemoteResourceReader,
} from "./remote-resource-reader.js";
import type { DownloadProgress } from "./transfer-queue.js";

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

interface DirectorySnapshot {
  entries: readonly FileEntry[];
  expiresAt: number;
}

export interface RcloneSftpOptions {
  binary?: string;
  configFile?: string;
  operationTimeoutMs?: number;
  transferBandwidthLimit?: string;
  debug?: boolean;
  connections?: HostConnectionCoordinator;
  directoryCacheTtlMs?: number;
  directoryCacheLimit?: number;
  directoryCacheEntryLimit?: number;
  listingEntryLimit?: number;
  listingByteLimit?: number;
  now?: () => number;
}

const DEFAULT_DIRECTORY_CACHE_TTL_MS = 5_000;
const DEFAULT_DIRECTORY_CACHE_LIMIT = 16;
const DEFAULT_DIRECTORY_CACHE_ENTRY_LIMIT = 100_000;
const DEFAULT_LISTING_ENTRY_LIMIT = 100_000;
const DEFAULT_LISTING_BYTE_LIMIT = 64 * 1024 * 1024;
const MAX_SEGMENT_BYTES = 8 * 1024 * 1024;

/**
 * Read-only SFTP catalog/resource transport. The only copy direction exposed by this class is
 * remote source -> explicitly supplied local path.
 */
export class RcloneSftpService
  implements SftpProviderFactory, RemoteResourceReader, RemoteDownloadTransport
{
  public readonly binary: string;
  private readonly configFile: string;
  private readonly operationTimeoutMs: number;
  private readonly transferBandwidthLimit: string | undefined;
  private readonly debug: boolean;
  private readonly connections: HostConnectionCoordinator | undefined;
  private readonly providers = new Map<string, FileProvider>();
  private readonly directoryCache = new Map<string, DirectorySnapshot>();
  private readonly directoryCacheTtlMs: number;
  private readonly directoryCacheLimit: number;
  private readonly directoryCacheEntryLimit: number;
  private readonly listingEntryLimit: number;
  private readonly listingByteLimit: number;
  private readonly now: () => number;

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
    this.directoryCacheTtlMs = options.directoryCacheTtlMs ?? DEFAULT_DIRECTORY_CACHE_TTL_MS;
    this.directoryCacheLimit = options.directoryCacheLimit ?? DEFAULT_DIRECTORY_CACHE_LIMIT;
    this.directoryCacheEntryLimit =
      options.directoryCacheEntryLimit ?? DEFAULT_DIRECTORY_CACHE_ENTRY_LIMIT;
    this.listingEntryLimit = options.listingEntryLimit ?? DEFAULT_LISTING_ENTRY_LIMIT;
    this.listingByteLimit = options.listingByteLimit ?? DEFAULT_LISTING_BYTE_LIMIT;
    this.now = options.now ?? Date.now;
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
    const normalized = normalizeRemotePath(path);
    const key = cacheKey(hostId, normalized);
    if (options.refresh) this.directoryCache.delete(key);
    let snapshot = this.getCachedDirectory(key);
    if (!snapshot) {
      const entries = await this.streamDirectory(hostId, normalized, options.signal);
      snapshot = { entries, expiresAt: this.now() + this.directoryCacheTtlMs };
      this.putCachedDirectory(key, snapshot);
    }
    options.signal?.throwIfAborted();
    return paginateEntries(normalized, snapshot.entries, options);
  }

  public async stat(
    hostId: string,
    path: string,
    options: FileStatOptions = {},
  ): Promise<FileEntry> {
    const normalized = normalizeRemotePath(path);
    const result = await this.execute(
      hostId,
      ["lsjson", remote(normalized), "--stat", "--metadata"],
      { signal: options.signal },
    );
    return toEntry(
      posix.dirname(normalized),
      RcloneEntrySchema.parse(JSON.parse(result.stdout)),
      normalized,
    );
  }

  public async read(
    hostId: string,
    path: string,
    options: RemoteReadOptions = {},
  ): Promise<Uint8Array> {
    const offset = integerInRange(options.offset ?? 0, 0, Number.MAX_SAFE_INTEGER, "offset");
    const length = integerInRange(options.length ?? 512 * 1024, 1, MAX_SEGMENT_BYTES, "length");
    return this.readLimitedBytes(
      hostId,
      [
        "cat",
        remote(normalizeRemotePath(path)),
        "--offset",
        String(offset),
        "--count",
        String(length),
      ],
      length,
      options.signal,
    );
  }

  public async materialize(
    hostId: string,
    path: string,
    localCachePath: string,
    options: RemoteMaterializeOptions,
  ): Promise<void> {
    const source = await this.stat(hostId, path, { signal: options.signal });
    if (source.isDirectory || source.isSymbolicLink) {
      throw new TermLoomError({
        code: "RESOURCE_INVALID",
        message: "Only regular remote files can be materialized for preview",
      });
    }
    if (source.size > options.maxBytes) {
      throw resourceTooLarge(source.size, options.maxBytes);
    }
    await this.runTransfer(
      hostId,
      ["copyto", remote(path), localCachePath, "--sftp-skip-links"],
      options.signal ?? new AbortController().signal,
      (progress) => options.report?.(progress.bytes, progress.totalBytes),
    );
  }

  public async manifestDirectory(
    hostId: string,
    path: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<RemoteDirectoryManifest> {
    const records = await this.streamCsv(
      hostId,
      [
        "lsf",
        remote(normalizeRemotePath(path)),
        "--recursive",
        "--csv",
        "--format",
        "p",
        "--sftp-skip-links",
      ],
      options.signal,
    );
    const expectedPaths = new Set<string>();
    for (const record of records) {
      const value = record[0];
      if (typeof value === "string" && value) expectedPaths.add(value);
    }
    return { expectedPaths, skippedSymbolicLinks: 0 };
  }

  public async downloadFile(
    hostId: string,
    remotePath: string,
    localPartialPath: string,
    context: RemoteDownloadTransportContext,
  ): Promise<{ skippedSymbolicLinks: number }> {
    return this.runTransfer(
      hostId,
      ["copyto", remote(remotePath), localPartialPath, "--sftp-skip-links"],
      context.signal,
      context.report,
    );
  }

  public async downloadDirectory(
    hostId: string,
    remotePath: string,
    localDirectory: string,
    context: RemoteDownloadTransportContext,
  ): Promise<{ skippedSymbolicLinks: number }> {
    return this.runTransfer(
      hostId,
      [
        "copy",
        remote(remotePath),
        localDirectory,
        "--create-empty-src-dirs",
        "--immutable",
        "--sftp-skip-links",
      ],
      context.signal,
      context.report,
    );
  }

  public invalidate(hostId: string, path: string): void {
    this.directoryCache.delete(cacheKey(hostId, normalizeRemotePath(path)));
  }

  public forHost(hostId: string): FileProvider {
    const existing = this.providers.get(hostId);
    if (existing) return existing;
    const provider = new RcloneHostFileProvider(this, hostId);
    this.providers.set(hostId, provider);
    return provider;
  }

  private async streamDirectory(
    hostId: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<readonly FileEntry[]> {
    const records = await this.streamCsv(
      hostId,
      [
        "lsf",
        remote(path),
        "--csv",
        "--format",
        "stmp",
        "--time-format",
        "RFC3339",
        "--sftp-skip-links",
      ],
      signal,
    );
    return records.map((record) => lightEntry(path, record));
  }

  private async streamCsv(
    hostId: string,
    args: readonly string[],
    signal?: AbortSignal,
  ): Promise<readonly string[][]> {
    await this.requireMaster(hostId);
    signal?.throwIfAborted();
    const fullArgs = [...args, ...(this.debug ? ["-vv"] : []), ...this.connectionFlags(hostId)];
    const subprocess = Bun.spawn([this.binary, ...fullArgs], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      detached: process.platform !== "win32",
    });
    let diagnostics = "";
    let outputBytes = 0;
    const records: string[][] = [];
    let timedOut = false;
    let aborted = false;
    const terminate = () => terminateSubprocess(subprocess);
    const abort = () => {
      aborted = true;
      terminate();
    };
    signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, this.operationTimeoutMs);
    const parser = parse({ bom: true, relax_column_count: false });
    const parseRecords = (async () => {
      for await (const record of parser) {
        if (!Array.isArray(record)) throw new Error("rclone CSV record is not an array");
        records.push(record.map((value) => String(value)));
        if (records.length > this.listingEntryLimit) {
          throw listingLimit("entries", this.listingEntryLimit);
        }
      }
    })();
    const pumpOutput = (async () => {
      const reader = subprocess.stdout.getReader();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          outputBytes += value.byteLength;
          if (outputBytes > this.listingByteLimit) {
            throw listingLimit("bytes", this.listingByteLimit);
          }
          if (!parser.write(value)) await once(parser, "drain");
        }
        parser.end();
      } finally {
        reader.releaseLock();
      }
      await parseRecords;
    })();
    const stderr = consumeLines(subprocess.stderr, (line) => {
      diagnostics = `${diagnostics}${line}\n`.slice(-16_384);
    });
    try {
      const [exitCode] = await Promise.all([subprocess.exited, pumpOutput, stderr]);
      if (aborted) throw cancelled();
      if (timedOut) {
        throw new TermLoomError({
          code: "PROCESS_TIMEOUT",
          message: `rclone listing timed out after ${this.operationTimeoutMs} ms`,
        });
      }
      if (exitCode !== 0) throw rcloneFailure("listing", hostId, exitCode, diagnostics);
      return records;
    } catch (error) {
      parser.destroy();
      terminate();
      await Promise.allSettled([subprocess.exited, pumpOutput, stderr, parseRecords]);
      if (signal?.aborted || aborted) throw cancelled();
      throw error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    }
  }

  private async readLimitedBytes(
    hostId: string,
    args: readonly string[],
    limit: number,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    await this.requireMaster(hostId);
    signal?.throwIfAborted();
    const subprocess = Bun.spawn(
      [this.binary, ...args, ...(this.debug ? ["-vv"] : []), ...this.connectionFlags(hostId)],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: process.platform !== "win32" },
    );
    const chunks: Uint8Array[] = [];
    let size = 0;
    let diagnostics = "";
    let timedOut = false;
    let aborted = false;
    const terminate = () => terminateSubprocess(subprocess);
    const abort = () => {
      aborted = true;
      terminate();
    };
    signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, this.operationTimeoutMs);
    try {
      const stdout = (async () => {
        for await (const chunk of subprocess.stdout) {
          size += chunk.byteLength;
          if (size > limit) throw resourceTooLarge(size, limit);
          chunks.push(chunk.slice());
        }
      })();
      const stderr = consumeLines(subprocess.stderr, (line) => {
        diagnostics = `${diagnostics}${line}\n`.slice(-16_384);
      });
      const [exitCode] = await Promise.all([subprocess.exited, stdout, stderr]);
      if (aborted) throw cancelled();
      if (timedOut) {
        throw new TermLoomError({
          code: "PROCESS_TIMEOUT",
          message: `rclone read timed out after ${this.operationTimeoutMs} ms`,
        });
      }
      if (exitCode !== 0) throw rcloneFailure("read", hostId, exitCode, diagnostics);
      const output = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        output.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return output;
    } catch (error) {
      terminate();
      await subprocess.exited.catch(() => undefined);
      if (signal?.aborted || aborted) throw cancelled();
      throw error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    }
  }

  private async execute(
    hostId: string,
    args: readonly string[],
    options: { signal?: AbortSignal; allowNonZero?: boolean } = {},
  ) {
    await this.requireMaster(hostId);
    return runProcess(
      this.binary,
      [...args, ...(this.debug ? ["-vv"] : []), ...this.connectionFlags(hostId)],
      {
        timeoutMs: this.operationTimeoutMs,
        signal: options.signal,
        allowNonZero: options.allowNonZero,
      },
    );
  }

  private async requireMaster(hostId: string): Promise<void> {
    await this.connections?.ensureConnected(hostId);
    if (await this.ssh.checkMaster(hostId)) return;
    throw new TermLoomError({
      code: "PROCESS_FAILED",
      message: `No authenticated OpenSSH ControlMaster for ${hostId}`,
      hint: "Connect to the host before using SFTP.",
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
    report: (progress: DownloadProgress) => void,
  ): Promise<{ skippedSymbolicLinks: number }> {
    await this.requireMaster(hostId);
    signal.throwIfAborted();
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
      detached: process.platform !== "win32",
    });
    const abort = () => terminateSubprocess(subprocess);
    signal.addEventListener("abort", abort, { once: true });
    let diagnostics = "";
    let skippedSymbolicLinks = 0;
    try {
      const stdout = new Response(subprocess.stdout).text();
      const stderr = consumeLines(subprocess.stderr, (line) => {
        diagnostics = `${diagnostics}${line}\n`.slice(-16_384);
        const progress = parseProgress(line);
        if (progress) report(progress);
        if (/symbolic link|symlink/iu.test(line)) skippedSymbolicLinks += 1;
      });
      const [exitCode] = await Promise.all([subprocess.exited, stdout, stderr]);
      if (signal.aborted) throw cancelled();
      if (exitCode !== 0) throw rcloneFailure("download", hostId, exitCode, diagnostics);
      return { skippedSymbolicLinks };
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }

  private getCachedDirectory(key: string): DirectorySnapshot | undefined {
    const value = this.directoryCache.get(key);
    if (!value) return undefined;
    if (value.expiresAt <= this.now()) {
      this.directoryCache.delete(key);
      return undefined;
    }
    this.directoryCache.delete(key);
    this.directoryCache.set(key, value);
    return value;
  }

  private putCachedDirectory(key: string, snapshot: DirectorySnapshot): void {
    if (snapshot.entries.length > this.directoryCacheEntryLimit) return;
    this.directoryCache.delete(key);
    this.directoryCache.set(key, snapshot);
    let totalEntries = [...this.directoryCache.values()].reduce(
      (total, value) => total + value.entries.length,
      0,
    );
    while (
      this.directoryCache.size > this.directoryCacheLimit ||
      totalEntries > this.directoryCacheEntryLimit
    ) {
      const oldest = this.directoryCache.entries().next().value as
        | [string, DirectorySnapshot]
        | undefined;
      if (!oldest) break;
      this.directoryCache.delete(oldest[0]);
      totalEntries -= oldest[1].entries.length;
    }
  }
}

class RcloneHostFileProvider implements FileProvider {
  public readonly kind = "sftp" as const;

  public constructor(
    private readonly service: RcloneSftpService,
    private readonly hostId: string,
  ) {}

  public list(path: string, options?: DirectoryQuery): Promise<DirectoryPage> {
    return this.service.list(this.hostId, path, options);
  }

  public stat(path: string, options?: FileStatOptions): Promise<FileEntry> {
    return this.service.stat(this.hostId, path, options);
  }
}

function lightEntry(base: string, record: readonly string[]): FileEntry {
  if (record.length !== 4) {
    throw new TermLoomError({
      code: "PROCESS_FAILED",
      message: `rclone returned an invalid ${record.length}-column directory record`,
    });
  }
  const [rawSize = "", rawTime = "", mimeType = "", rawPath = ""] = record;
  if (!rawPath) {
    throw new TermLoomError({ code: "PROCESS_FAILED", message: "rclone returned an empty path" });
  }
  const isDirectory = rawPath.endsWith("/");
  const relativePath = isDirectory ? rawPath.slice(0, -1) : rawPath;
  const modifiedAt = rawTime ? new Date(rawTime) : undefined;
  const size = Number(rawSize);
  return {
    name: posix.basename(relativePath),
    path: posix.join(base, relativePath),
    size: Number.isFinite(size) && size >= 0 ? size : 0,
    isDirectory,
    isSymbolicLink: false,
    mimeType: mimeType || undefined,
    modifiedAt: modifiedAt && !Number.isNaN(modifiedAt.valueOf()) ? modifiedAt : undefined,
    hashes: {},
  };
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
  if (path.includes("\0")) throw new Error("Remote path contains NUL");
  return `:sftp:${path}`;
}

function normalizeRemotePath(path: string): string {
  if (path.includes("\0")) throw new Error("Remote path contains NUL");
  return posix.normalize(path || ".");
}

function cacheKey(hostId: string, path: string): string {
  return `${hostId}\0${path}`;
}

async function consumeLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffered += decoder.decode(value, { stream: !done });
      const lines = buffered.split(/\r?\n/);
      buffered = lines.pop() ?? "";
      for (const line of lines) onLine(line);
      if (done) break;
    }
    if (buffered) onLine(buffered);
  } finally {
    reader.releaseLock();
  }
}

function parseProgress(line: string): DownloadProgress | null {
  try {
    const parsed = JSON.parse(line) as {
      stats?: { bytes?: unknown; totalBytes?: unknown; speed?: unknown; eta?: unknown };
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

function integerInRange(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function listingLimit(kind: "entries" | "bytes", limit: number): TermLoomError {
  return new TermLoomError({
    code: "RESOURCE_TOO_LARGE",
    message: `Remote directory listing exceeds the ${limit.toLocaleString()} ${kind} limit`,
    details: { kind, limit },
  });
}

function resourceTooLarge(size: number, maximum: number): TermLoomError {
  return new TermLoomError({
    code: "RESOURCE_TOO_LARGE",
    message: `Remote resource exceeds the ${maximum}-byte preview limit`,
    details: { size, maxBytes: maximum },
  });
}

function rcloneFailure(
  operation: string,
  hostId: string,
  exitCode: number,
  diagnostics: string,
): TermLoomError {
  return new TermLoomError({
    code: "PROCESS_FAILED",
    message: `rclone ${operation} failed with status ${exitCode}: ${redactText(diagnostics.trim())}`,
    details: { hostId, exitCode },
  });
}

function cancelled(): TermLoomError {
  return new TermLoomError({
    code: "PROCESS_CANCELLED",
    message: "rclone operation was cancelled",
  });
}

function terminateSubprocess(subprocess: Bun.Subprocess): void {
  if (process.platform !== "win32") {
    try {
      process.kill(-subprocess.pid, "SIGTERM");
      return;
    } catch {
      // Fall through when the process group is already gone.
    }
  }
  if (subprocess.exitCode === null) subprocess.kill("SIGTERM");
}

export function describeRcloneError(error: unknown): string {
  return redactText(errorMessage(error));
}
