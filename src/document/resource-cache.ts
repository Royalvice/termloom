import { createHash } from "node:crypto";
import { mkdir, readdir, rename, rm, stat, utimes } from "node:fs/promises";
import { join } from "node:path";
import { TermLoomError } from "../core/errors.js";

export interface CacheMaterialization {
  path: string;
  size: number;
  cacheHit: boolean;
}

export class ResourceCache {
  private readonly inflight = new Map<string, Promise<CacheMaterialization>>();

  public constructor(
    public readonly directory: string,
    private readonly maxBytes: number,
  ) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw new Error("Resource cache size must be a positive safe integer");
    }
  }

  public async materialize(
    identity: string,
    extension: string,
    write: (temporaryPath: string) => Promise<void>,
  ): Promise<CacheMaterialization> {
    const key = createHash("sha256").update(identity).digest("hex");
    const suffix = safeExtension(extension);
    const path = join(this.directory, `${key}${suffix}`);
    const existing = this.inflight.get(path);
    if (existing) return existing;
    const promise = this.materializeOnce(path, write).finally(() => this.inflight.delete(path));
    this.inflight.set(path, promise);
    return promise;
  }

  private async materializeOnce(
    path: string,
    write: (temporaryPath: string) => Promise<void>,
  ): Promise<CacheMaterialization> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const cached = await optionalStat(path);
    if (cached?.isFile()) {
      const now = new Date();
      await utimes(path, now, now);
      return { path, size: cached.size, cacheHit: true };
    }

    const temporaryPath = `${path}.${crypto.randomUUID()}.partial`;
    try {
      await write(temporaryPath);
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
