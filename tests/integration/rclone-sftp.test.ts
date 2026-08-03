import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { defaultConfig } from "../../src/config/schema.js";
import { RemoteDownloadService } from "../../src/sftp/remote-download-service.js";
import { RcloneSftpService } from "../../src/sftp/rclone-sftp.js";
import { SshClient } from "../../src/ssh/client.js";
import { OpenSshResolver } from "../../src/ssh/resolver.js";
import { SshdFixture } from "../helpers/sshd-fixture.js";

test("keeps SFTP browsing read-only and downloads files/directories locally without overwrite", async () => {
  const fixture = await SshdFixture.create();
  const localRoot = await mkdtemp(join(tmpdir(), "termloom-rclone-readonly-"));
  const remoteRoot = `/tmp/tl-sftp-readonly-${crypto.randomUUID()}`;
  let client: SshClient | undefined;
  try {
    await createRemoteSource(remoteRoot);
    const clientConfig = await fixture.createClientConfig({ strictHostKeyChecking: "yes" });
    const config = defaultConfig();
    config.hosts = [{ id: "fixture", alias: fixture.alias, defaultPath: remoteRoot }];
    config.ssh.connectTimeoutSeconds = 5;
    client = await SshClient.create(config, {
      resolver: new OpenSshResolver({
        binary: fixture.sshBinary,
        configFile: clientConfig,
        timeoutMs: 5_000,
      }),
      controlDirectory: fixture.controlDirectory,
    });
    await client.resolveHost("fixture");
    const master = client.spawnMaster("fixture");
    await waitUntil(() => master.closed);
    const service = new RcloneSftpService(client, { operationTimeoutMs: 10_000, debug: true });
    expect(await service.version()).toMatch(/^rclone v\d/);

    const firstPage = await service.list("fixture", remoteRoot, { page: 1, pageSize: 2 });
    expect(firstPage.total).toBe(5);
    expect(firstPage.totalPages).toBe(3);
    expect(firstPage.entries[0]).toMatchObject({ name: "directory", isDirectory: true });
    const search = await service.list("fixture", remoteRoot, { query: "brav" });
    expect(search.entries.map((entry) => entry.name)).toEqual(["bravo.txt"]);
    const newline = await service.list("fixture", remoteRoot, { query: "break" });
    expect(newline.entries.map((entry) => entry.name)).toEqual(["line\nbreak.txt"]);
    expect(await service.stat("fixture", `${remoteRoot}/directory`)).toMatchObject({
      name: "directory",
      isDirectory: true,
    });
    expect(await service.stat("fixture", `${remoteRoot}/alpha.txt`)).toMatchObject({
      name: "alpha.txt",
      size: 5,
      isDirectory: false,
    });
    expect(
      new TextDecoder().decode(
        await service.read("fixture", `${remoteRoot}/alpha.txt`, {
          offset: 1,
          length: 3,
        }),
      ),
    ).toBe("lph");

    await writeFile(join(remoteRoot, "cache-new.txt"), "new");
    const cached = await service.list("fixture", remoteRoot);
    expect(cached.entries.some((entry) => entry.name === "cache-new.txt")).toBe(false);
    const refreshed = await service.list("fixture", remoteRoot, { refresh: true });
    expect(refreshed.entries.some((entry) => entry.name === "cache-new.txt")).toBe(true);

    const sourceBefore = await treeSnapshot(remoteRoot);
    const cachePath = join(localRoot, "preview-cache.bin");
    await service.materialize("fixture", `${remoteRoot}/alpha.txt`, cachePath, {
      maxBytes: 1024,
    });
    expect(await readFile(cachePath, "utf8")).toBe("alpha");

    const downloadsRoot = join(localRoot, "downloads");
    await mkdir(downloadsRoot);
    const downloads = new RemoteDownloadService(service);
    const first = await downloads.start({
      hostId: "fixture",
      remotePath: `${remoteRoot}/alpha.txt`,
      sourceKind: "file",
      localDestination: join(downloadsRoot, "alpha.txt"),
      ownerPaneId: "pane-a",
    });
    await expect(first.completion).resolves.toEqual({
      resolvedDestination: join(downloadsRoot, "alpha.txt"),
      skippedSymbolicLinks: 0,
    });
    expect(await sha256(join(remoteRoot, "alpha.txt"))).toBe(
      await sha256(join(downloadsRoot, "alpha.txt")),
    );

    const second = await downloads.start({
      hostId: "fixture",
      remotePath: `${remoteRoot}/alpha.txt`,
      sourceKind: "file",
      localDestination: join(downloadsRoot, "alpha.txt"),
      ownerPaneId: "pane-b",
    });
    expect((await second.completion).resolvedDestination).toBe(
      join(downloadsRoot, "alpha (1).txt"),
    );
    expect(await readFile(join(downloadsRoot, "alpha.txt"), "utf8")).toBe("alpha");

    const directory = await downloads.start({
      hostId: "fixture",
      remotePath: `${remoteRoot}/directory`,
      sourceKind: "directory",
      localDestination: join(downloadsRoot, "directory"),
      ownerPaneId: "pane-a",
    });
    const directoryResult = await directory.completion;
    expect(directoryResult.resolvedDestination).toBe(join(downloadsRoot, "directory"));
    expect(await readFile(join(downloadsRoot, "directory", "nested.txt"), "utf8")).toBe("nested");
    await expect(lstat(join(downloadsRoot, "directory", "outside-link"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    expect(await treeSnapshot(remoteRoot)).toEqual(sourceBefore);
    const provider = service.forHost("fixture");
    for (const mutation of [
      "createFile",
      "createDirectory",
      "rename",
      "copy",
      "move",
      "upload",
      "download",
      "delete",
    ]) {
      expect(mutation in service).toBe(false);
      expect(mutation in provider).toBe(false);
    }
  } finally {
    if (client) await client.stopMaster("fixture").catch(() => undefined);
    await fixture.dispose();
    await rm(remoteRoot, { recursive: true, force: true });
    await rm(localRoot, { recursive: true, force: true });
  }
}, 30_000);

async function createRemoteSource(root: string): Promise<void> {
  await mkdir(join(root, "directory"), { recursive: true, mode: 0o700 });
  await writeFile(join(root, "alpha.txt"), "alpha", { mode: 0o640 });
  await writeFile(join(root, "bravo.txt"), "bravo", { mode: 0o600 });
  await writeFile(join(root, ".hidden"), "hidden", { mode: 0o600 });
  await writeFile(join(root, "line\nbreak.txt"), "newline", { mode: 0o600 });
  await writeFile(join(root, "directory", "nested.txt"), "nested", { mode: 0o600 });
  await symlink("/etc/hosts", join(root, "directory", "outside-link"));
}

async function treeSnapshot(root: string): Promise<readonly string[]> {
  const result: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (!directory) break;
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const metadata = await lstat(path);
      const name = relative(root, path);
      if (entry.isDirectory()) {
        result.push(`d:${name}:${metadata.mode & 0o7777}`);
        pending.push(path);
      } else if (entry.isSymbolicLink()) {
        result.push(`l:${name}:${metadata.mode & 0o7777}`);
      } else {
        result.push(`f:${name}:${metadata.mode & 0o7777}:${await sha256(path)}`);
      }
    }
  }
  return result.sort();
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(20);
  }
  throw new Error("Timed out waiting for rclone fixture state");
}
