import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DomainPermissionGate } from "../../../src/document/domain-permission.js";
import type { ResourceLocation } from "../../../src/document/model.js";
import { ResourceCache } from "../../../src/document/resource-cache.js";
import { ResourceLoader } from "../../../src/document/resource-loader.js";
import type { FileEntry } from "../../../src/files/file-provider.js";
import type { RemoteResourceReader } from "../../../src/sftp/remote-resource-reader.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("ResourceLoader", () => {
  test("loads a local resource directly without a remote provider or cache copy", async () => {
    const directory = await temporaryDirectory();
    const localPath = join(directory, "local.md");
    await writeFile(localPath, "# Local", { mode: 0o600 });
    const loader = new ResourceLoader({
      cache: new ResourceCache(join(directory, "cache"), 1024 * 1024),
      permissions: new DomainPermissionGate(),
    });

    const loaded = await loader.load({ scheme: "file", path: localPath });

    expect(loaded.localPath).toBe(localPath);
    expect(loaded.cacheHit).toBe(true);
    expect(loaded.mimeType).toBe("text/markdown");
    expect(await readFile(loaded.localPath, "utf8")).toBe("# Local");
  });

  test("downloads a versioned remote resource once and serves later loads from cache", async () => {
    const directory = await temporaryDirectory();
    const remote = new FakeRemoteResourceProvider(Buffer.from("remote-png"));
    const loader = new ResourceLoader({
      remote,
      cache: new ResourceCache(directory, 1024 * 1024),
      permissions: new DomainPermissionGate(),
    });
    const location: ResourceLocation = {
      scheme: "sftp",
      hostId: "fixture",
      path: "/srv/image.png",
    };

    const first = await loader.load(location);
    const second = await loader.load(location);
    expect(first.cacheHit).toBe(false);
    expect(second.cacheHit).toBe(true);
    expect(remote.downloads).toBe(1);
    expect(await readFile(second.localPath, "utf8")).toBe("remote-png");
    expect(second.mimeType).toBe("image/png");
  });

  test("makes zero HTTP requests before permission and persists only explicit approval", async () => {
    const directory = await temporaryDirectory();
    let requests = 0;
    const server = Bun.serve({
      port: 0,
      fetch: () => {
        requests += 1;
        return new Response("http-image", {
          headers: { "content-type": "image/png", "content-length": "10" },
        });
      },
    });
    const persisted: string[][] = [];
    const permissions = new DomainPermissionGate({
      persist: async (domains) => {
        persisted.push([...domains]);
      },
    });
    const loader = new ResourceLoader({
      remote: new FakeRemoteResourceProvider(Buffer.alloc(0)),
      cache: new ResourceCache(directory, 1024 * 1024),
      permissions,
    });
    const url = `http://127.0.0.1:${server.port}/image.png`;
    const location: ResourceLocation = {
      scheme: "http",
      url,
      domain: "127.0.0.1",
    };

    try {
      await expect(loader.load(location)).rejects.toMatchObject({
        code: "HTTP_PERMISSION_REQUIRED",
      });
      expect(requests).toBe(0);
      await permissions.allow(url, "once");
      const loaded = await loader.load(location);
      expect(requests).toBe(1);
      expect(await readFile(loaded.localPath, "utf8")).toBe("http-image");
      expect(persisted).toEqual([]);

      await permissions.allow("example.com", "persist");
      expect(persisted).toEqual([["example.com"]]);
      expect(permissions.persistedDomains()).toEqual(["example.com"]);
    } finally {
      server.stop(true);
    }
  });

  test("blocks an HTTP response before writing when its declared size exceeds the limit", async () => {
    const directory = await temporaryDirectory();
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response("01234567890"),
    });
    const url = `http://127.0.0.1:${server.port}/large.mp4`;
    const permissions = new DomainPermissionGate();
    await permissions.allow(url, "once");
    const loader = new ResourceLoader({
      remote: new FakeRemoteResourceProvider(Buffer.alloc(0)),
      cache: new ResourceCache(directory, 1024 * 1024),
      permissions,
      maxHttpBytes: 10,
    });
    try {
      await expect(loader.load({ scheme: "http", url, domain: "127.0.0.1" })).rejects.toMatchObject(
        { code: "RESOURCE_TOO_LARGE" },
      );
    } finally {
      server.stop(true);
    }
  });

  test("rejects an oversized remote resource from stat without materializing it", async () => {
    const directory = await temporaryDirectory();
    const remote = new FakeRemoteResourceProvider(Buffer.from("eleven bytes"));
    const loader = new ResourceLoader({
      remote,
      cache: new ResourceCache(directory, 1024 * 1024),
      permissions: new DomainPermissionGate(),
      maxRemoteBytes: 10,
    });

    await expect(
      loader.load({ scheme: "sftp", hostId: "fixture", path: "/srv/large.bin" }),
    ).rejects.toMatchObject({ code: "RESOURCE_TOO_LARGE" });
    expect(remote.downloads).toBe(0);
  });
});

class FakeRemoteResourceProvider implements RemoteResourceReader {
  public downloads = 0;

  public constructor(private readonly content: Uint8Array) {}

  public async stat(_hostId: string, path: string): Promise<FileEntry> {
    return {
      name: "image.png",
      path,
      size: this.content.byteLength,
      isDirectory: false,
      isSymbolicLink: false,
      mimeType: "image/png",
      modifiedAt: new Date("2026-07-28T00:00:00.000Z"),
      hashes: {},
    };
  }

  public async read(
    _hostId: string,
    _path: string,
    options: { offset?: number; length?: number; signal?: AbortSignal } = {},
  ): Promise<Uint8Array> {
    options.signal?.throwIfAborted();
    const start = options.offset ?? 0;
    return this.content.slice(start, start + (options.length ?? this.content.byteLength));
  }

  public async materialize(
    _hostId: string,
    _source: string,
    destination: string,
    options: { signal?: AbortSignal; maxBytes: number },
  ): Promise<void> {
    options.signal?.throwIfAborted();
    if (this.content.byteLength > options.maxBytes) throw new Error("too large");
    this.downloads += 1;
    await writeFile(destination, this.content, { mode: 0o600 });
  }
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "termloom-resource-"));
  temporaryDirectories.push(directory);
  return directory;
}
