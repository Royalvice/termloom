import { constants } from "node:fs";
import type { Stats } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  link,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, normalize, relative } from "node:path";
import { TermLoomError, errorMessage } from "../core/errors.js";
import type { FileEntry } from "../files/file-provider.js";
import {
  type DownloadHandle,
  type DownloadProgress,
  type DownloadResult,
  type RemoteDownloadRequest,
  TransferQueue,
} from "./transfer-queue.js";

export interface RemoteDownloadTransportContext {
  signal: AbortSignal;
  report(progress: DownloadProgress): void;
}

export interface RemoteDirectoryManifest {
  expectedPaths: ReadonlySet<string>;
  skippedSymbolicLinks: number;
}

/** A read-only remote source transport. Every write target is a local path supplied by TermLoom. */
export interface RemoteDownloadTransport {
  stat(hostId: string, path: string, options?: { signal?: AbortSignal }): Promise<FileEntry>;
  manifestDirectory(
    hostId: string,
    path: string,
    options?: { signal?: AbortSignal },
  ): Promise<RemoteDirectoryManifest>;
  downloadFile(
    hostId: string,
    remotePath: string,
    localPartialPath: string,
    context: RemoteDownloadTransportContext,
  ): Promise<{ skippedSymbolicLinks: number }>;
  downloadDirectory(
    hostId: string,
    remotePath: string,
    localDirectory: string,
    context: RemoteDownloadTransportContext,
  ): Promise<{ skippedSymbolicLinks: number }>;
}

export interface RemoteDownloadServiceOptions {
  queue?: TransferQueue;
}

const MAX_UNIQUE_ATTEMPTS = 10_000;
const MAX_CLEANUP_ENTRIES = 100_000;

export class RemoteDownloadService {
  public readonly queue: TransferQueue;

  public constructor(
    private readonly transport: RemoteDownloadTransport,
    options: RemoteDownloadServiceOptions = {},
  ) {
    this.queue = options.queue ?? new TransferQueue({ concurrency: 2 });
  }

  public normalizeDestination(value: string): string {
    if (/\0|\r|\n/u.test(value)) throw invalidDestination("control characters are not allowed");
    const trimmed = value.trim();
    if (!trimmed) throw invalidDestination("the destination is empty");
    const expanded =
      trimmed === "~"
        ? homedir()
        : trimmed.startsWith("~/")
          ? join(homedir(), trimmed.slice(2))
          : trimmed;
    if (expanded.startsWith("~")) {
      throw invalidDestination("~user expansion is not supported");
    }
    if (!isAbsolute(expanded)) throw invalidDestination("an absolute local path is required");
    return normalize(expanded);
  }

  public async start(request: RemoteDownloadRequest): Promise<DownloadHandle> {
    const localDestination = this.normalizeDestination(request.localDestination);
    await requireExistingDirectory(dirname(localDestination));
    const initial = await this.transport.stat(request.hostId, request.remotePath);
    validateRemoteSource(initial, request);
    return this.queue.enqueue(
      { ...request, localDestination },
      async ({ signal, report, setResolvedDestination, setSkippedSymbolicLinks }) => {
        signal.throwIfAborted();
        const source = await this.transport.stat(request.hostId, request.remotePath, { signal });
        validateRemoteSource(source, request);
        if (source.isDirectory) {
          return this.downloadDirectory(
            { ...request, localDestination },
            signal,
            report,
            setResolvedDestination,
            setSkippedSymbolicLinks,
          );
        }
        return this.downloadFile(
          { ...request, localDestination },
          source,
          signal,
          report,
          setResolvedDestination,
          setSkippedSymbolicLinks,
        );
      },
    );
  }

  private async downloadFile(
    request: RemoteDownloadRequest,
    source: FileEntry,
    signal: AbortSignal,
    report: (progress: DownloadProgress) => void,
    setResolvedDestination: (path: string) => void,
    setSkippedSymbolicLinks: (count: number) => void,
  ): Promise<DownloadResult> {
    const parent = dirname(request.localDestination);
    const partial = join(
      parent,
      `.${basename(request.localDestination)}.${crypto.randomUUID()}.partial`,
    );
    const reservation = await open(partial, "wx", 0o600);
    await reservation.close();
    let published = false;
    try {
      report({ bytes: 0, totalBytes: source.size });
      const transfer = await this.transport.downloadFile(
        request.hostId,
        request.remotePath,
        partial,
        { signal, report },
      );
      signal.throwIfAborted();
      const downloaded = await lstat(partial);
      if (!downloaded.isFile() || downloaded.isSymbolicLink()) {
        throw new TermLoomError({
          code: "FILE_IO",
          message: "The download producer did not create a regular local file",
        });
      }
      await chmod(partial, 0o600);
      const resolvedDestination = await publishFileNoReplace(
        partial,
        request.localDestination,
        setResolvedDestination,
      );
      published = true;
      setSkippedSymbolicLinks(transfer.skippedSymbolicLinks);
      return {
        resolvedDestination,
        skippedSymbolicLinks: transfer.skippedSymbolicLinks,
      };
    } finally {
      if (!published) await removeOwnedPartialFile(partial);
      else
        await unlink(partial).catch((error) => {
          if (!isNotFound(error)) throw error;
        });
    }
  }

  private async downloadDirectory(
    request: RemoteDownloadRequest,
    signal: AbortSignal,
    report: (progress: DownloadProgress) => void,
    setResolvedDestination: (path: string) => void,
    setSkippedSymbolicLinks: (count: number) => void,
  ): Promise<DownloadResult> {
    const manifest = await this.transport.manifestDirectory(request.hostId, request.remotePath, {
      signal,
    });
    signal.throwIfAborted();
    const destination = await reserveUniqueDirectory(request.localDestination);
    setResolvedDestination(destination);
    const taskId = crypto.randomUUID();
    const markerName = `.termloom-download-${taskId}.owner`;
    const markerPath = join(destination, markerName);
    await Bun.write(markerPath, taskId, { mode: 0o600, createPath: false });
    let completed = false;
    try {
      const transfer = await this.transport.downloadDirectory(
        request.hostId,
        request.remotePath,
        destination,
        { signal, report },
      );
      signal.throwIfAborted();
      const skipped = Math.max(manifest.skippedSymbolicLinks, transfer.skippedSymbolicLinks);
      setSkippedSymbolicLinks(skipped);
      await unlink(markerPath);
      completed = true;
      return { resolvedDestination: destination, skippedSymbolicLinks: skipped };
    } catch (error) {
      const cleanup = await cleanupOwnedDirectory(
        destination,
        markerName,
        taskId,
        manifest.expectedPaths,
      );
      if (!cleanup.removed) {
        throw new TermLoomError({
          code: signal.aborted ? "PROCESS_CANCELLED" : "PROCESS_FAILED",
          message: `${errorMessage(error)}; partial directory preserved at ${cleanup.preservedPath}`,
          cause: error,
          details: { preservedPath: cleanup.preservedPath },
        });
      }
      throw error;
    } finally {
      if (!completed) {
        // cleanupOwnedDirectory owns all failure cleanup. This branch deliberately does not use a
        // broad recursive fallback when ownership could not be proven.
      }
    }
  }
}

function validateRemoteSource(entry: FileEntry, request: RemoteDownloadRequest): void {
  if (entry.isSymbolicLink) {
    throw new TermLoomError({
      code: "RESOURCE_INVALID",
      message: "Symbolic links cannot be downloaded",
      details: { hostId: request.hostId, remotePath: request.remotePath },
    });
  }
  const actual = entry.isDirectory ? "directory" : "file";
  if (actual !== request.sourceKind) {
    throw new TermLoomError({
      code: "RESOURCE_INVALID",
      message: `Remote download source changed from ${request.sourceKind} to ${actual}`,
      details: { hostId: request.hostId, remotePath: request.remotePath },
    });
  }
}

async function requireExistingDirectory(path: string): Promise<void> {
  let metadata: Stats;
  try {
    metadata = await stat(path);
  } catch (error) {
    throw new TermLoomError({
      code: "FILE_IO",
      message: `Download parent directory is unavailable: ${path}`,
      cause: error,
      details: { path },
    });
  }
  if (!metadata.isDirectory()) throw invalidDestination("the parent is not a directory");
}

async function publishFileNoReplace(
  partial: string,
  requested: string,
  setResolvedDestination: (path: string) => void,
): Promise<string> {
  for (let index = 0; index <= MAX_UNIQUE_ATTEMPTS; index += 1) {
    const candidate = numberedDestination(requested, index, false);
    setResolvedDestination(candidate);
    try {
      await link(partial, candidate);
      return candidate;
    } catch (error) {
      if (isAlreadyExists(error)) continue;
      if (!isHardLinkUnsupported(error)) throw error;
    }
    try {
      await copyFile(partial, candidate, constants.COPYFILE_EXCL);
      await chmod(candidate, 0o600);
      return candidate;
    } catch (error) {
      if (isAlreadyExists(error)) continue;
      throw error;
    }
  }
  throw uniqueNameExhausted(requested);
}

async function reserveUniqueDirectory(requested: string): Promise<string> {
  for (let index = 0; index <= MAX_UNIQUE_ATTEMPTS; index += 1) {
    const candidate = numberedDestination(requested, index, true);
    try {
      await mkdir(candidate, { mode: 0o700 });
      return candidate;
    } catch (error) {
      if (isAlreadyExists(error)) continue;
      throw error;
    }
  }
  throw uniqueNameExhausted(requested);
}

function numberedDestination(requested: string, index: number, directory: boolean): string {
  if (index === 0) return requested;
  const parent = dirname(requested);
  const name = basename(requested);
  if (directory) return join(parent, `${name} (${index})`);
  const extension = extname(name);
  const stem = extension ? name.slice(0, -extension.length) : name;
  return join(parent, `${stem} (${index})${extension}`);
}

async function removeOwnedPartialFile(path: string): Promise<void> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) return;
    await unlink(path);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

async function cleanupOwnedDirectory(
  destination: string,
  markerName: string,
  taskId: string,
  expectedPaths: ReadonlySet<string>,
): Promise<{ removed: boolean; preservedPath: string }> {
  const markerPath = join(destination, markerName);
  try {
    if ((await readFile(markerPath, "utf8")) !== taskId) {
      return { removed: false, preservedPath: destination };
    }
  } catch {
    return { removed: false, preservedPath: destination };
  }

  const quarantine = join(
    dirname(destination),
    `.${basename(destination)}.termloom-partial-${taskId}`,
  );
  try {
    await rename(destination, quarantine);
  } catch {
    return { removed: false, preservedPath: destination };
  }
  const safe = await containsOnlyExpectedPaths(quarantine, markerName, expectedPaths);
  if (!safe) return { removed: false, preservedPath: quarantine };
  await rm(quarantine, { recursive: true });
  return { removed: true, preservedPath: quarantine };
}

async function containsOnlyExpectedPaths(
  root: string,
  markerName: string,
  expectedPaths: ReadonlySet<string>,
): Promise<boolean> {
  const pending = [root];
  let seen = 0;
  while (pending.length > 0) {
    const directory = pending.pop();
    if (!directory) break;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      seen += 1;
      if (seen > MAX_CLEANUP_ENTRIES) return false;
      const path = join(directory, entry.name);
      const child = relative(root, path).split("\\").join("/");
      if (child === markerName) continue;
      if (entry.isSymbolicLink()) return false;
      const expected = entry.isDirectory() ? `${child}/` : child;
      if (!expectedPaths.has(expected)) return false;
      if (entry.isDirectory()) pending.push(path);
      else if (!entry.isFile()) return false;
    }
  }
  return true;
}

function invalidDestination(reason: string): TermLoomError {
  return new TermLoomError({
    code: "FILE_IO",
    message: `Invalid download destination: ${reason}`,
  });
}

function uniqueNameExhausted(path: string): TermLoomError {
  return new TermLoomError({
    code: "TRANSFER_CONFLICT",
    message: `Unable to reserve a unique local destination for ${path}`,
  });
}

function isAlreadyExists(error: unknown): boolean {
  return errorCode(error) === "EEXIST";
}

function isNotFound(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function isHardLinkUnsupported(error: unknown): boolean {
  return ["EPERM", "EOPNOTSUPP", "ENOTSUP", "EXDEV"].includes(errorCode(error) ?? "");
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}
