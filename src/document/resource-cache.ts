import { createHash } from "node:crypto";
import { mkdir, readdir, rename, rm, stat, utimes } from "node:fs/promises";
import { join } from "node:path";
import { TermLoomError } from "../core/errors.js";

export interface CacheMaterialization {
  path: string;
  size: number;
  cacheHit: boolean;
}

export interface CacheMaterializeOptions {
  signal?: AbortSignal;
}

interface InflightMaterialization {
  controller: AbortController;
  promise: Promise<CacheMaterialization>;
  consumers: number;
  settled: boolean;
}

export class ResourceCache {
  private readonly inflight = new Map<string, InflightMaterialization>();

  public constructor(
    public readonly directory: string,
    private maxBytes: number,
  ) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw new Error("Resource cache size must be a positive safe integer");
    }
  }

  public updateMaxBytes(maxBytes: number): void {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw new Error("Resource cache size must be a positive safe integer");
    }
    this.maxBytes = maxBytes;
  }

  public async materialize(
    identity: string,
    extension: string,
    write: (temporaryPath: string, signal: AbortSignal) => Promise<void>,
    options: CacheMaterializeOptions = {},
  ): Promise<CacheMaterialization> {
    options.signal?.throwIfAborted();
    const key = createHash("sha256").update(identity).digest("hex");
    const suffix = safeExtension(extension);
    const path = join(this.directory, `${key}${suffix}`);
    let entry = this.inflight.get(path);
    if (entry?.controller.signal.aborted && !entry.settled) {
      if (this.inflight.get(path) === entry) this.inflight.delete(path);
      entry = undefined;
    }
    if (!entry) {
      const controller = new AbortController();
      entry = {
        controller,
        consumers: 0,
        settled: false,
        promise: Promise.resolve({ path, size: 0, cacheHit: false }),
      };
      const created = entry;
      created.promise = this.materializeOnce(path, write, controller.signal).finally(() => {
        created.settled = true;
        if (this.inflight.get(path) === created) this.inflight.delete(path);
      });
      // The producer remains observed even if every consumer cancels before it settles.
      void created.promise.catch(() => undefined);
      this.inflight.set(path, created);
    }
    return this.consume(entry, options.signal);
  }

  private async materializeOnce(
    path: string,
    write: (temporaryPath: string, signal: AbortSignal) => Promise<void>,
    signal: AbortSignal,
  ): Promise<CacheMaterialization> {
    signal.throwIfAborted();
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const cached = await optionalStat(path);
    if (cached?.isFile()) {
      const now = new Date();
      await utimes(path, now, now);
      return { path, size: cached.size, cacheHit: true };
    }

    const temporaryPath = `${path}.${crypto.randomUUID()}.partial`;
    try {
      await write(temporaryPath, signal);
      signal.throwIfAborted();
      const written = await stat(temporaryPath);
      if (!written.isFile()) throw new Error("Resource producer did not write a regular file");
      if (written.size > this.maxBytes) {
        throw new TermLoomError({
          code: "RESOURCE_TOO_LARGE",
          message: `Resource is larger than the ${this.maxBytes}-byte cache limit`,
          details: { size: written.size, maxBytes: this.maxBytes },
        });
      }
      await rename(temporaryPath, path);
      await this.evict(path);
      return { path, size: written.size, cacheHit: false };
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }

  private consume(
    entry: InflightMaterialization,
    signal: AbortSignal | undefined,
  ): Promise<CacheMaterialization> {
    entry.consumers += 1;
    return new Promise<CacheMaterialization>((resolve, reject) => {
      let completed = false;
      const release = () => {
        if (completed) return false;
        completed = true;
        signal?.removeEventListener("abort", onAbort);
        entry.consumers = Math.max(0, entry.consumers - 1);
        return true;
      };
      const onAbort = () => {
        if (!release()) return;
        if (entry.consumers === 0 && !entry.settled) entry.controller.abort();
        reject(abortReason(signal));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      entry.promise.then(
        (value) => {
          if (!release()) return;
          resolve(value);
        },
        (error) => {
          if (!release()) return;
          reject(error);
        },
      );
      if (signal?.aborted) onAbort();
    });
  }

  private async evict(protectedPath: string): Promise<void> {
    const names = await readdir(this.directory);
    const files = (
      await Promise.all(
        names
          .filter((name) => !name.endsWith(".partial"))
          .map(async (name) => {
            const path = join(this.directory, name);
            const metadata = await optionalStat(path);
            return metadata?.isFile()
              ? { path, size: metadata.size, touchedAt: metadata.mtimeMs }
              : null;
          }),
      )
    ).filter((entry): entry is NonNullable<typeof entry> => entry !== null);
    let total = files.reduce((sum, file) => sum + file.size, 0);
    files.sort((left, right) => left.touchedAt - right.touchedAt);
    for (const file of files) {
      if (total <= this.maxBytes) break;
      if (file.path === protectedPath) continue;
      await rm(file.path, { force: true });
      total -= file.size;
    }
  }
}

function abortReason(signal: AbortSignal | undefined): unknown {
  return signal?.reason ?? new DOMException("Resource materialization cancelled", "AbortError");
}

async function optionalStat(path: string) {
  try {
    return await stat(path);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function safeExtension(value: string): string {
  const normalized = value.toLocaleLowerCase();
  return /^\.[a-z0-9]{1,10}$/.test(normalized) ? normalized : ".bin";
}
