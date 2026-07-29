import { afterEach, describe, expect, test } from "bun:test";
import { access, rm } from "node:fs/promises";
import { defaultConfig } from "../../src/config/schema.js";
import { SshClient } from "../../src/ssh/client.js";
import { OpenSshResolver } from "../../src/ssh/resolver.js";
import type { PtyBackend } from "../../src/terminal/pty-backend.js";
import { TmuxService } from "../../src/tmux/tmux-service.js";
import { SshdFixture } from "../helpers/sshd-fixture.js";

let fixture: SshdFixture | undefined;
let client: SshClient | undefined;
let tmux: TmuxService | undefined;

afterEach(async () => {
  if (tmux && client) {
    for (const session of await tmux.list("fixture").catch(() => [])) {
      await tmux.kill("fixture", session.name).catch(() => undefined);
    }
    await client.stopMaster("fixture").catch(() => undefined);
  }
  await fixture?.dispose();
  fixture = undefined;
  client = undefined;
  tmux = undefined;
});

describe("remote tmux service", () => {
  test("lists, creates, renames, attaches, detaches, and kills sessions", async () => {
    ({ fixture, client, tmux } = await setup());
    expect(await tmux.version("fixture")).toMatch(/^tmux \d/);
    expect(await tmux.list("fixture")).toEqual([]);

    await tmux.create("fixture", "alpha");
    expect(await tmux.exists("fixture", "alpha")).toBe(true);
    await tmux.rename("fixture", "alpha", "beta");
    expect((await tmux.list("fixture")).map((session) => session.name)).toEqual(["beta"]);

    const backend = tmux.attachBackend("fixture", "beta");
    let output = "";
    const subscription = backend.onData((data) => {
      output += data;
    });
    try {
      await waitUntil(() => output.includes("beta"));
      backend.write("printf 'termloom-attach-smoke\\n'\r");
      await waitUntil(() => output.includes("termloom-attach-smoke"));
      backend.write("\u0002d");
      await waitForExit(backend);
    } finally {
      subscription.dispose();
      backend.kill();
    }
    expect(await tmux.exists("fixture", "beta")).toBe(true);
    await tmux.kill("fixture", "beta");
    expect(await tmux.list("fixture")).toEqual([]);
  });

  test("keeps remote work alive when the local SSH client is interrupted", async () => {
    ({ fixture, client, tmux } = await setup());
    const sshClient = client;
    if (!sshClient) throw new Error("Expected SSH client");
    await tmux.create("fixture", "durable");
    const marker = `/tmp/tl-durable-${crypto.randomUUID()}`;
    const launched = `/tmp/tl-launched-${crypto.randomUUID()}`;
    await tmux.sendKeys(
      "fixture",
      "durable",
      `(sleep 1; printf durable > '${marker}') & printf launched > '${launched}'`,
    );
    await waitUntil(async () => {
      try {
        await access(launched);
        return true;
      } catch {
        return false;
      }
    });
    const backend = tmux.attachBackend("fixture", "durable");
    let output = "";
    const subscription = backend.onData((data) => {
      output += data;
    });
    try {
      await waitUntil(() => output.includes("durable"));
      backend.kill("SIGKILL");
      await waitForExit(backend);
      await Bun.sleep(1_100);
      const result = await sshClient.run("fixture", ["/bin/cat", marker]);
      expect(result.stdout).toBe("durable");

      const reattached = tmux.attachBackend("fixture", "durable");
      let reattachedOutput = "";
      const reattachedSubscription = reattached.onData((data) => {
        reattachedOutput += data;
      });
      try {
        await waitUntil(() => reattachedOutput.includes("durable"));
        reattached.write("\u0002d");
        await waitForExit(reattached);
      } finally {
        reattachedSubscription.dispose();
        reattached.kill();
      }
    } finally {
      subscription.dispose();
      backend.kill();
      await rm(marker, { force: true });
      await rm(launched, { force: true });
    }
  }, 12_000);
});

async function setup(): Promise<{ fixture: SshdFixture; client: SshClient; tmux: TmuxService }> {
  const fixtureServer = await SshdFixture.create();
  const clientConfig = await fixtureServer.createClientConfig({ strictHostKeyChecking: "yes" });
  const config = defaultConfig();
  config.hosts = [
    {
      id: "fixture",
      alias: fixtureServer.alias,
      defaultPath: ".",
      defaultTmuxSession: "termloom-test",
    },
  ];
  config.ssh.connectTimeoutSeconds = 5;
  const sshClient = await SshClient.create(config, {
    resolver: new OpenSshResolver({
      binary: fixtureServer.sshBinary,
      configFile: clientConfig,
      timeoutMs: 5_000,
    }),
    controlDirectory: fixtureServer.controlDirectory,
  });
  await sshClient.resolveHost("fixture");
  const master = sshClient.spawnMaster("fixture");
  await waitForExit(master);
  const service = new TmuxService(sshClient, {
    socketName: `termloom-${process.pid}-${crypto.randomUUID()}`,
  });
  return { fixture: fixtureServer, client: sshClient, tmux: service };
}

async function waitForExit(backend: PtyBackend, timeoutMs = 5_000): Promise<void> {
  await waitUntil(() => backend.closed, timeoutMs);
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
  throw new Error("Timed out waiting for tmux fixture state");
}
