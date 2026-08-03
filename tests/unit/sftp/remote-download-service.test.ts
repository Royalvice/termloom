import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { FileEntry } from "../../../src/files/file-provider.js";
import {
  RemoteDownloadService,
  type RemoteDownloadTransport,
  type RemoteDownloadTransportContext,
} from "../../../src/sftp/remote-download-service.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("RemoteDownloadService", () => {
  test("rejects relative/control destinations, missing parents, and selected symlinks", async () => {
    const root = await temporaryDirectory();
    const transport = new FakeTransport(fileEntry("/remote/file.txt"));
    const service = new RemoteDownloadService(transport);
    expect(() => service.normalizeDestination("relative.txt")).toThrow("absolute local path");
    expect(() => service.normalizeDestination(`${root}/bad\nname`)).toThrow("control characters");
    await expect(
      service.start(request("/remote/file.txt", join(root, "missing", "file.txt"))),
    ).rejects.toMatchObject({ code: "FILE_IO" });

    transport.entry = { ...transport.entry, isSymbolicLink: true };
    await expect(service.start(request("/remote/link", join(root, "link")))).rejects.toMatchObject({
      code: "RESOURCE_INVALID",
    });
    expect(service.queue.list()).toHaveLength(0);
  });

  test("publishes files without overwrite and removes its exact partial on cancellation", async () => {
    const root = await temporaryDirectory();
    const transport = new FakeTransport(fileEntry("/remote/file.txt"));
    const service = new RemoteDownloadService(transport);
    const destination = join(root, "file.txt");
    await writeFile(destination, "original");
    transport.fileWorker = async (_path, localPath) => {
      await writeFile(localPath, "downloaded");
      return { skippedSymbolicLinks: 0 };
    };
    const completed = await service.start(request("/remote/file.txt", destination));
    expect((await completed.completion).resolvedDestination).toBe(join(root, "file (1).txt"));
    expect(await Bun.file(destination).text()).toBe("original");
    expect(await Bun.file(join(root, "file (1).txt")).text()).toBe("downloaded");

    transport.fileWorker = (_path, _localPath, context) => waitForAbort(context.signal);
    const cancelled = await service.start(request("/remote/file.txt", join(root, "cancel.txt")));
    await Bun.sleep(0);
    expect(cancelled.cancel()).toBe(true);
    await expect(cancelled.completion).rejects.toMatchObject({ code: "PROCESS_CANCELLED" });
    expect((await readdir(root)).some((name) => name.endsWith(".partial"))).toBe(false);
  });

  test("cleans a failed owned directory but preserves a tree containing an unknown file", async () => {
    const root = await temporaryDirectory();
    const transport = new FakeTransport(directoryEntry("/remote/folder"));
    transport.manifest = new Set(["expected.txt"]);
    const service = new RemoteDownloadService(transport);
    const destination = join(root, "folder");

    transport.directoryWorker = async (_path, localPath) => {
      await writeFile(join(localPath, "expected.txt"), "partial");
      throw new Error("fixture failed");
    };
    const removable = await service.start(request("/remote/folder", destination, "directory"));
    await expect(removable.completion).rejects.toThrow("fixture failed");
    expect((await readdir(root)).some((name) => name.includes("folder"))).toBe(false);

    transport.directoryWorker = async (_path, localPath) => {
      await writeFile(join(localPath, "expected.txt"), "partial");
      await writeFile(join(localPath, "external.txt"), "unknown");
      throw new Error("fixture failed with unknown content");
    };
    const preserved = await service.start(request("/remote/folder", destination, "directory"));
    await expect(preserved.completion).rejects.toThrow("partial directory preserved");
    const preservedName = (await readdir(root)).find((name) => name.includes("termloom-partial"));
    expect(preservedName).toBeDefined();
    expect(await Bun.file(join(root, preservedName ?? "", "external.txt")).text()).toBe("unknown");
  });

  test("keeps cancellation scoped to the exact host and owner pane", async () => {
    const root = await temporaryDirectory();
    const transport = new FakeTransport(fileEntry("/remote/file.txt"));
    transport.fileWorker = (_path, _localPath, context) => waitForAbort(context.signal);
    const service = new RemoteDownloadService(transport);
    const first = await service.start({
      ...request("/remote/file.txt", join(root, "one.txt")),
      hostId: "host-a",
      ownerPaneId: "pane-a",
    });
    const second = await service.start({
      ...request("/remote/file.txt", join(root, "two.txt")),
      hostId: "host-b",
      ownerPaneId: "pane-b",
    });
    await Bun.sleep(0);
    expect(service.queue.cancel(first.id, { hostId: "host-b", ownerPaneId: "pane-b" })).toBe(false);
    expect(service.queue.get(first.id)?.status).toBe("running");
    expect(service.queue.cancel(first.id, { hostId: "host-a", ownerPaneId: "pane-a" })).toBe(true);
    await expect(first.completion).rejects.toMatchObject({ code: "PROCESS_CANCELLED" });
    expect(service.queue.get(second.id)?.status).toBe("running");
    second.cancel();
    await expect(second.completion).rejects.toMatchObject({ code: "PROCESS_CANCELLED" });
  });
});

class FakeTransport implements RemoteDownloadTransport {
  public manifest = new Set<string>();
  public fileWorker: (
    remotePath: string,
    localPath: string,
    context: RemoteDownloadTransportContext,
  ) => Promise<{ skippedSymbolicLinks: number }> = async (_remotePath, localPath) => {
    await writeFile(localPath, "fixture");
    return { skippedSymbolicLinks: 0 };
  };
  public directoryWorker: (
    remotePath: string,
    localPath: string,
    context: RemoteDownloadTransportContext,
  ) => Promise<{ skippedSymbolicLinks: number }> = async () => ({
    skippedSymbolicLinks: 0,
  });

  public constructor(public entry: FileEntry) {}

  public async stat(_hostId: string, path: string): Promise<FileEntry> {
    return { ...this.entry, path, name: basename(path) };
  }

  public async manifestDirectory() {
    return { expectedPaths: new Set(this.manifest), skippedSymbolicLinks: 0 };
  }

  public downloadFile(
    _hostId: string,
    remotePath: string,
    localPath: string,
    context: RemoteDownloadTransportContext,
  ) {
    return this.fileWorker(remotePath, localPath, context);
  }

  public downloadDirectory(
    _hostId: string,
    remotePath: string,
    localPath: string,
    context: RemoteDownloadTransportContext,
  ) {
    return this.directoryWorker(remotePath, localPath, context);
  }
}

function request(
  remotePath: string,
  localDestination: string,
  sourceKind: "file" | "directory" = "file",
) {
  return {
    hostId: "fixture",
    remotePath,
    sourceKind,
    localDestination,
    ownerPaneId: "pane-files",
  };
}

function fileEntry(path: string): FileEntry {
  return {
    name: basename(path),
    path,
    size: 7,
    isDirectory: false,
    isSymbolicLink: false,
    hashes: {},
  };
}

function directoryEntry(path: string): FileEntry {
  return { ...fileEntry(path), size: 0, isDirectory: true };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "termloom-download-service-"));
  temporaryDirectories.push(directory);
  return directory;
}

function waitForAbort(signal: AbortSignal): Promise<{ skippedSymbolicLinks: number }> {
  if (signal.aborted) return Promise.reject(new Error("aborted"));
  return new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
}
