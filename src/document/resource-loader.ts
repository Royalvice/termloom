import { open, stat } from "node:fs/promises";
import { extname, posix } from "node:path";
import { lookup } from "mime-types";
import { TermLoomError } from "../core/errors.js";
import type { RemoteResourceReader } from "../sftp/remote-resource-reader.js";
import type { LoadedResource, ResourceLocation } from "./model.js";
import type { DomainPermissionGate } from "./domain-permission.js";
import type { ResourceCache } from "./resource-cache.js";

export interface ResourceLoaderOptions {
  remote?: RemoteResourceReader;
  cache: ResourceCache;
  permissions: DomainPermissionGate;
  fetch?: typeof fetch;
  maxHttpBytes?: number;
  maxRemoteBytes?: number;
  maxRedirects?: number;
}

export interface ResourceLoadOptions {
  signal?: AbortSignal;
}

export interface ResourceDescriptor {
  location: ResourceLocation;
  size: number;
  mimeType?: string;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}

export interface ResourceReadOptions extends ResourceLoadOptions {
  offset?: number;
  length: number;
}

const MAX_SEGMENT_BYTES = 8 * 1024 * 1024;

export class ResourceLoader {
  private readonly remote: RemoteResourceReader | undefined;
  private readonly cache: ResourceCache;
  private readonly permissions: DomainPermissionGate;
  private readonly fetch: typeof fetch;
  private readonly maxHttpBytes: number;
  private readonly maxRemoteBytes: number;
  private readonly maxRedirects: number;

  public constructor(options: ResourceLoaderOptions) {
    this.remote = options.remote;
    this.cache = options.cache;
    this.permissions = options.permissions;
    this.fetch = options.fetch ?? fetch;
    this.maxHttpBytes = options.maxHttpBytes ?? 100 * 1024 * 1024;
    this.maxRemoteBytes = Math.min(options.maxRemoteBytes ?? 512 * 1024 * 1024, 512 * 1024 * 1024);
    this.maxRedirects = options.maxRedirects ?? 5;
  }

  public async load(
    location: ResourceLocation,
    options: ResourceLoadOptions = {},
  ): Promise<LoadedResource> {
    options.signal?.throwIfAborted();
    if (location.scheme === "file") return this.loadLocal(location, options.signal);
    return location.scheme === "sftp"
      ? this.loadRemote(location, options.signal)
      : this.loadHttp(location, options.signal);
  }

  public async describe(
    location: ResourceLocation,
    options: ResourceLoadOptions = {},
  ): Promise<ResourceDescriptor> {
    options.signal?.throwIfAborted();
    if (location.scheme === "file") {
      const metadata = await stat(location.path);
      options.signal?.throwIfAborted();
      return {
        location,
        size: metadata.size,
        mimeType: mimeType(location.path),
        isDirectory: metadata.isDirectory(),
        isSymbolicLink: metadata.isSymbolicLink(),
      };
    }
    if (location.scheme === "sftp") {
      const remote = this.requireRemote();
      const metadata = await remote.stat(location.hostId, location.path, {
        signal: options.signal,
      });
      return {
        location,
        size: metadata.size,
        mimeType: metadata.mimeType ?? mimeType(location.path),
        isDirectory: metadata.isDirectory,
        isSymbolicLink: metadata.isSymbolicLink,
      };
    }
    const loaded = await this.load(location, options);
    return {
      location,
      size: loaded.size,
      mimeType: loaded.mimeType,
      isDirectory: false,
      isSymbolicLink: false,
    };
  }

  public async read(location: ResourceLocation, options: ResourceReadOptions): Promise<Uint8Array> {
    const offset = boundedInteger(options.offset ?? 0, 0, Number.MAX_SAFE_INTEGER, "offset");
    const length = boundedInteger(options.length, 1, MAX_SEGMENT_BYTES, "length");
    options.signal?.throwIfAborted();
    if (location.scheme === "sftp") {
      return this.requireRemote().read(location.hostId, location.path, {
        offset,
        length,
        signal: options.signal,
      });
    }
    const localPath =
      location.scheme === "file" ? location.path : (await this.load(location, options)).localPath;
    const handle = await open(localPath, "r");
    try {
      const buffer = new Uint8Array(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      options.signal?.throwIfAborted();
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }

  private async loadLocal(
    location: Extract<ResourceLocation, { scheme: "file" }>,
    signal?: AbortSignal,
  ): Promise<LoadedResource> {
    const metadata = await stat(location.path);
    signal?.throwIfAborted();
    if (metadata.isDirectory()) {
      throw new TermLoomError({
        code: "RESOURCE_INVALID",
        message: "A directory cannot be rendered as a document resource",
        details: { path: location.path },
      });
    }
    return {
      location,
      localPath: location.path,
      size: metadata.size,
      mimeType: mimeType(location.path),
      cacheHit: true,
    };
  }

  private async loadRemote(
    location: Extract<ResourceLocation, { scheme: "sftp" }>,
    signal?: AbortSignal,
  ): Promise<LoadedResource> {
    const remote = this.requireRemote();
    const metadata = await remote.stat(location.hostId, location.path, { signal });
    if (metadata.isDirectory) {
      throw new TermLoomError({
        code: "RESOURCE_INVALID",
        message: "A directory cannot be rendered as a document resource",
        details: { hostId: location.hostId, path: location.path },
      });
    }
    if (metadata.isSymbolicLink) {
      throw new TermLoomError({
        code: "RESOURCE_INVALID",
        message: "A symbolic link cannot be rendered as a document resource",
        details: { hostId: location.hostId, path: location.path },
      });
    }
    if (metadata.size > this.maxRemoteBytes) {
      throw tooLarge(metadata.size, this.maxRemoteBytes, "Remote resource");
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
      async (path, producerSignal) => {
        await remote.materialize(location.hostId, location.path, path, {
          signal: producerSignal,
          maxBytes: this.maxRemoteBytes,
        });
      },
      { signal },
    );
    return {
      location,
      localPath: cached.path,
      size: cached.size,
      mimeType: metadata.mimeType ?? mimeType(location.path),
      cacheHit: cached.cacheHit,
    };
  }

  private requireRemote(): RemoteResourceReader {
    if (this.remote) return this.remote;
    throw new TermLoomError({
      code: "DEPENDENCY_MISSING",
      message: "Remote preview is unavailable because rclone was not found",
      hint: "Install rclone and run termloom doctor again. Local preview remains available.",
      details: { dependency: "rclone" },
    });
  }

  private async loadHttp(
    location: Extract<ResourceLocation, { scheme: "http" | "https" }>,
    signal?: AbortSignal,
  ): Promise<LoadedResource> {
    const url = new URL(location.url);
    const cached = await this.cache.materialize(
      `http\0${url.toString()}`,
      extname(url.pathname),
      (path, producerSignal) => this.downloadHttp(url, path, producerSignal),
      { signal },
    );
    return {
      location,
      localPath: cached.path,
      size: cached.size,
      mimeType: mimeType(url.pathname),
      cacheHit: cached.cacheHit,
    };
  }

  private async downloadHttp(initialUrl: URL, path: string, signal?: AbortSignal): Promise<void> {
    let url = initialUrl;
    for (let redirects = 0; redirects <= this.maxRedirects; redirects += 1) {
      this.permissions.require(url);
      signal?.throwIfAborted();
      const response = await this.fetch(url, { redirect: "manual", signal });
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
        throw tooLarge(declared, this.maxHttpBytes, "HTTP resource");
      }
      await writeLimited(response.body, path, this.maxHttpBytes, signal);
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
  signal?: AbortSignal,
): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  const reader = stream.getReader();
  let bytes = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maximum) {
        await reader.cancel();
        throw tooLarge(bytes, maximum, "HTTP resource");
      }
      await handle.write(value);
    }
  } finally {
    await handle.close();
  }
}

function tooLarge(size: number, maximum: number, label: string): TermLoomError {
  return new TermLoomError({
    code: "RESOURCE_TOO_LARGE",
    message: `${label} exceeds the ${maximum}-byte limit`,
    details: { size, maxBytes: maximum },
  });
}

function mimeType(path: string): string | undefined {
  const value = lookup(path);
  return value || undefined;
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`Resource ${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}
