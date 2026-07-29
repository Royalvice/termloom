import { expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../../src/config/schema.js";
import { RcloneSftpService } from "../../src/sftp/rclone-sftp.js";
import { SshClient } from "../../src/ssh/client.js";
import { OpenSshResolver } from "../../src/ssh/resolver.js";
import { SshdFixture } from "../helpers/sshd-fixture.js";

test("runs the complete rclone SFTP file and transfer workflow through ControlMaster", async () => {
  const fixture = await SshdFixture.create();
  const localRoot = await mkdtemp(join(tmpdir(), "termloom-rclone-"));
  const remoteRoot = `/tmp/tl-sftp-${crypto.randomUUID()}`;
  let client: SshClient | undefined;
  let service: RcloneSftpService | undefined;
  try {
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
    service = new RcloneSftpService(client, { operationTimeoutMs: 10_000, debug: true });
    expect(await service.version()).toMatch(/^rclone v\d/);

    await service.mkdir("fixture", remoteRoot);
    await service.mkdir("fixture", `${remoteRoot}/directory`);
    await service.touch("fixture", `${remoteRoot}/alpha.txt`);
    await service.touch("fixture", `${remoteRoot}/directory/nested.txt`);
    await service.touch("fixture", `${remoteRoot}/bravo.txt`);

    const firstPage = await service.list("fixture", remoteRoot, { page: 1, pageSize: 2 });
    expect(firstPage.total).toBe(3);
    expect(firstPage.totalPages).toBe(2);
    expect(firstPage.entries[0]).toMatchObject({ name: "directory", isDirectory: true });
    const search = await service.list("fixture", remoteRoot, { query: "brav" });
    expect(search.entries.map((entry) => entry.name)).toEqual(["bravo.txt"]);
    expect(await service.stat("fixture", `${remoteRoot}/alpha.txt`)).toMatchObject({
      name: "alpha.txt",
      size: 0,
      isDirectory: false,
    });

    await service.rename("fixture", `${remoteRoot}/alpha.txt`, `${remoteRoot}/renamed.txt`);
    await service.copy("fixture", `${remoteRoot}/renamed.txt`, `${remoteRoot}/copied.txt`);
    await service.move("fixture", `${remoteRoot}/copied.txt`, `${remoteRoot}/moved.txt`);
    await service.copy("fixture", `${remoteRoot}/directory`, `${remoteRoot}/directory-copy`);
    expect(await service.stat("fixture", `${remoteRoot}/directory-copy/nested.txt`)).toMatchObject({
      name: "nested.txt",
      isDirectory: false,
    });

    const source = join(localRoot, "source.bin");
    const sourceBytes = randomBytes(512 * 1024);
    await writeFile(source, sourceBytes);
    const uploaded = service.upload("fixture", source, `${remoteRoot}/uploaded.bin`);
    expect(await uploaded.completion).toEqual({
      destination: `${remoteRoot}/uploaded.bin`,
    });
    expect(service.queue.get(uploaded.id)?.status).toBe("completed");

    const conflict = service.upload("fixture", source, `${remoteRoot}/uploaded.bin`, "error");
    await expect(conflict.completion).rejects.toMatchObject({ code: "TRANSFER_CONFLICT" });
    const skipped = service.upload("fixture", source, `${remoteRoot}/uploaded.bin`, "skip");
    await expect(skipped.completion).resolves.toEqual({
      destination: `${remoteRoot}/uploaded.bin`,
      skipped: true,
    });
    expect(service.queue.get(skipped.id)?.status).toBe("skipped");
    const renamed = service.upload("fixture", source, `${remoteRoot}/uploaded.bin`, "rename");
    await expect(renamed.completion).resolves.toEqual({
      destination: `${remoteRoot}/uploaded (1).bin`,
    });

    const downloaded = join(localRoot, "downloaded.bin");
    const download = service.download("fixture", `${remoteRoot}/uploaded.bin`, downloaded);
    await expect(download.completion).resolves.toEqual({ destination: downloaded });
    expect(await sha256(source)).toBe(await sha256(downloaded));
    const downloadRename = service.download(
      "fixture",
      `${remoteRoot}/uploaded.bin`,
      downloaded,
      "rename",
    );
    await expect(downloadRename.completion).resolves.toEqual({
      destination: join(localRoot, "downloaded (1).bin"),
    });

    const slowSource = join(localRoot, "slow.bin");
    await writeFile(slowSource, randomBytes(2 * 1024 * 1024));
    const slowService = new RcloneSftpService(client, {
      operationTimeoutMs: 15_000,
      transferBandwidthLimit: "512K",
    });
    const progress: number[] = [];
    let slowId = "";
    const unsubscribe = slowService.queue.onChange((job) => {
      if (job.id === slowId) progress.push(job.progress.bytes);
    });
    const slow = slowService.upload("fixture", slowSource, `${remoteRoot}/cancelled.bin`);
    slowId = slow.id;
    try {
      await waitUntil(() => (slowService.queue.get(slow.id)?.progress.bytes ?? 0) > 0, 5_000);
      expect(slow.cancel()).toBe(true);
      await expect(slow.completion).rejects.toMatchObject({ code: "PROCESS_CANCELLED" });
      expect(slowService.queue.get(slow.id)?.status).toBe("cancelled");
      expect(progress.some((bytes) => bytes > 0)).toBe(true);
    } finally {
      unsubscribe();
    }

    expect("delete" in service).toBe(false);
    expect("delete" in service.forHost("fixture")).toBe(false);
  } finally {
    if (client) await removeRemoteFixture(client, remoteRoot).catch(() => undefined);
    if (client) await client.stopMaster("fixture").catch(() => undefined);
    await fixture.dispose();
    await rm(localRoot, { recursive: true, force: true });
  }
}, 30_000);

async function sha256(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

async function removeRemoteFixture(client: SshClient, path: string): Promise<void> {
  if (!/^\/tmp\/tl-sftp-[0-9a-f-]+$/i.test(path)) {
    throw new Error(`Refusing to clean an unexpected fixture path: ${path}`);
  }
  await client.run("fixture", ["rm", "-rf", "--", path], {
    timeoutMs: 5_000,
    allowNonZero: true,
  });
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
