import { afterEach, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defaultConfig } from "../../src/config/schema.js";
import { SshClient } from "../../src/ssh/client.js";
import { OpenSshResolver } from "../../src/ssh/resolver.js";
import type { PtyBackend } from "../../src/terminal/pty-backend.js";
import { SshdFixture } from "../helpers/sshd-fixture.js";

let fixture: SshdFixture | undefined;
const masters: Array<{ client: SshClient; hostId: string }> = [];

afterEach(async () => {
  for (const master of masters.splice(0).reverse()) await master.client.stopMaster(master.hostId);
  await fixture?.dispose();
  fixture = undefined;
});

describe("system OpenSSH ControlMaster", () => {
  test("resolves ssh -G and starts, reuses, checks, and stops a master", async () => {
    fixture = await SshdFixture.create();
    const clientConfig = await fixture.createClientConfig({ strictHostKeyChecking: "yes" });
    const client = await createClient(fixture, clientConfig);
    masters.push({ client, hostId: "fixture" });

    const resolved = client.host("fixture");
    expect(resolved.effective.hostName).toBe("127.0.0.1");
    expect(resolved.effective.port).toBe(fixture.port);
    expect(await client.checkMaster("fixture")).toBe(false);

    const master = client.spawnMaster("fixture", 100, 30);
    await waitForExit(master);
    expect(await client.checkMaster("fixture")).toBe(true);
    const first = await client.run("fixture", ["/usr/bin/printf", "control-one"]);
    const second = await client.run("fixture", ["/usr/bin/printf", "control-two"]);
    expect(first.stdout).toBe("control-one");
    expect(second.stdout).toBe("control-two");
    expect(await client.stopMaster("fixture")).toBe(true);
    masters.pop();
    expect(await client.checkMaster("fixture")).toBe(false);
  });

  test("presents an unknown-host prompt through the interactive PTY", async () => {
    fixture = await SshdFixture.create();
    const emptyKnownHosts = join(fixture.root, "known_hosts_prompt");
    await writeFile(emptyKnownHosts, "", { mode: 0o600 });
    const clientConfig = await fixture.createClientConfig({
      strictHostKeyChecking: "ask",
      knownHostsFile: emptyKnownHosts,
      batchMode: false,
    });
    const client = await createClient(fixture, clientConfig);
    masters.push({ client, hostId: "fixture" });
    const master = client.spawnMaster("fixture", 100, 30);
    let output = "";
    const subscription = master.onData((data) => {
      output += data;
    });
    try {
      await waitUntil(() => output.includes("Are you sure you want to continue connecting"));
      master.write("yes\r");
      await waitForExit(master);
      expect(output).toContain("ED25519 key fingerprint");
      expect(await client.checkMaster("fixture")).toBe(true);
    } finally {
      subscription.dispose();
    }
  });
});

async function createClient(fixtureServer: SshdFixture, configFile: string): Promise<SshClient> {
  const config = defaultConfig();
  config.hosts = [
    {
      id: "fixture",
      alias: fixtureServer.alias,
      label: "Fixture",
      defaultPath: ".",
      defaultTmuxSession: "termloom-test",
    },
  ];
  config.ssh.connectTimeoutSeconds = 5;
  return SshClient.create(config, {
    resolver: new OpenSshResolver({
      binary: fixtureServer.sshBinary,
      configFile,
      timeoutMs: 5_000,
    }),
    controlDirectory: fixtureServer.controlDirectory,
  });
}

async function waitForExit(backend: PtyBackend, timeoutMs = 5_000): Promise<void> {
  await waitUntil(() => backend.closed, timeoutMs);
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(20);
  }
  throw new Error("Timed out waiting for SSH fixture state");
}
