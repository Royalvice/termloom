import { open } from "node:fs/promises";
import { extname, posix } from "node:path";
import { lookup } from "mime-types";
import { TermLoomError } from "../core/errors.js";
import type { ConflictPolicy, RemoteFileEntry } from "../sftp/rclone-sftp.js";
import type { TransferHandle } from "../sftp/transfer-queue.js";
import type { LoadedResource, ResourceLocation } from "./model.js";
import type { DomainPermissionGate } from "./domain-permission.js";
import type { ResourceCache } from "./resource-cache.js";

export interface RemoteResourceProvider {
  stat(hostId: string, path: string): Promise<RemoteFileEntry>;
  download(
    hostId: string,
    remotePath: string,
    localPath: string,
    policy?: ConflictPolicy,
  ): TransferHandle;
}

export interface ResourceLoaderOptions {
  remote: RemoteResourceProvider;
  cache: ResourceCache;
  permissions: DomainPermissionGate;
  fetch?: typeof fetch;
  maxHttpBytes?: number;
  maxRedirects?: number;
}

export class ResourceLoader {
  private readonly remote: RemoteResourceProvider;
  private readonly cache: ResourceCache;
  private readonly permissions: DomainPermissionGate;
  private readonly fetch: typeof fetch;
  private readonly maxHttpBytes: number;
  private readonly maxRedirects: number;

  public constructor(options: ResourceLoaderOptions) {
    this.remote = options.remote;
    this.cache = options.cache;
    this.permissions = options.permissions;
    this.fetch = options.fetch ?? fetch;
    this.maxHttpBytes = options.maxHttpBytes ?? 100 * 1024 * 1024;
    this.maxRedirects = options.maxRedirects ?? 5;
  }

  public async load(location: ResourceLocation): Promise<LoadedResource> {
    return location.scheme === "sftp" ? this.loadRemote(location) : this.loadHttp(location);
  }

  private async loadRemote(
    location: Extract<ResourceLocation, { scheme: "sftp" }>,
  ): Promise<LoadedResource> {
    const metadata = await this.remote.stat(location.hostId, location.path);
    if (metadata.isDirectory) {
      throw new TermLoomError({
        code: "RESOURCE_INVALID",
        message: "A directory cannot be rendered as a document resource",
        details: { hostId: location.hostId, path: location.path },
      });
    }
    const identity = [
      "sftp",
      location.hostId,
      location.path,
      metadata.size,
      metadata.modifiedAt?.toISOString() ?? "",
    ].join("\0");
    const cached = await this.cache.materialize(
      identity,
      posix.extname(location.path),
      async (path) => {
        await this.remote.download(location.hostId, location.path, path, "overwrite").completion;
      },
    );
    return {
      location,
      localPath: cached.path,
      size: cached.size,
      mimeType: metadata.mimeType ?? mimeType(location.path),
      cacheHit: cached.cacheHit,
    };
  }

  private async loadHttp(
    location: Extract<ResourceLocation, { scheme: "http" | "https" }>,
  ): Promise<LoadedResource> {
    const url = new URL(location.url);
    const cached = await this.cache.materialize(
      `http\0${url.toString()}`,
      extname(url.pathname),
      (path) => this.downloadHttp(url, path),
    );
    return {
      location,
      localPath: cached.path,
      size: cached.size,
      mimeType: mimeType(url.pathname),
      cacheHit: cached.cacheHit,
    };
  }

  private async downloadHttp(initialUrl: URL, path: string): Promise<void> {
    let url = initialUrl;
    for (let redirects = 0; redirects <= this.maxRedirects; redirects += 1) {
      this.permissions.require(url);
      const response = await this.fetch(url, { redirect: "manual" });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) {
          throw new TermLoomError({
            code: "PROCESS_FAILED",
            message: `HTTP redirect from ${url.hostname} has no Location header`,
          });
        }
        url = new URL(location, url);
        if (url.protocol !== "http:" && url.protocol !== "https:") {
          throw new TermLoomError({
            code: "RESOURCE_INVALID",
            message: `Unsupported redirect protocol: ${url.protocol}`,
          });
        }
        continue;
      }
      if (!response.ok || !response.body) {
        throw new TermLoomError({
          code: "PROCESS_FAILED",
          message: `HTTP resource request failed with status ${response.status}`,
          details: { domain: url.hostname, status: response.status },
        });
      }
      const declared = Number(response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > this.maxHttpBytes) {
        throw tooLarge(declared, this.maxHttpBytes);
      }
      await writeLimited(response.body, path, this.maxHttpBytes);
      return;
    }
    throw new TermLoomError({
      code: "PROCESS_FAILED",
      message: `HTTP resource exceeded ${this.maxRedirects} redirects`,
    });
  }
}

async function writeLimited(
  stream: ReadableStream<Uint8Array>,
  path: string,
  maximum: number,
): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  const reader = stream.getReader();
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maximum) {
        await reader.cancel();
        throw tooLarge(bytes, maximum);
      }
      await handle.write(value);
    }
  } finally {
    await handle.close();
  }
}

function tooLarge(size: number, maximum: number): TermLoomError {
  return new TermLoomError({
    code: "RESOURCE_TOO_LARGE",
    message: `HTTP resource exceeds the ${maximum}-byte limit`,
    details: { size, maxBytes: maximum },
  });
}

function mimeType(path: string): string | undefined {
  const value = lookup(path);
  return value || undefined;
}
