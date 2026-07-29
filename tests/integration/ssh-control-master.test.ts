import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defaultConfig } from "../../src/config/schema.js";
import { SshClient } from "../../src/ssh/client.js";
import { HostConnectionCoordinator } from "../../src/ssh/connection-coordinator.js";
import { OpenSshResolver } from "../../src/ssh/resolver.js";
import type { PtyBackend } from "../../src/terminal/pty-backend.js";
import { createDefaultWorkspace } from "../../src/workspace/schema.js";
import { SshdFixture } from "../helpers/sshd-fixture.js";

let fixture: SshdFixture | undefined;
let fakeRoot: string | undefined;
const masters: Array<{ client: SshClient; hostId: string }> = [];

afterEach(async () => {
  for (const master of masters.splice(0).reverse()) await master.client.stopMaster(master.hostId);
  await fixture?.dispose();
  fixture = undefined;
  if (fakeRoot) await rm(fakeRoot, { recursive: true, force: true });
  fakeRoot = undefined;
});

describe("system OpenSSH ControlMaster", () => {
  test("resolves ssh -G and starts, reuses, checks, and stops a master", async () => {
    fixture = await SshdFixture.create();
    const clientConfig = await fixture.createClientConfig({ strictHostKeyChecking: "yes" });
    const client = await createClient(fixture, clientConfig);
    masters.push({ client, hostId: "fixture" });

    const resolved = await client.resolveHost("fixture");
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
    await client.resolveHost("fixture");
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

  test("shares one authentication task across simultaneous consumers", async () => {
    fixture = await SshdFixture.create();
    const clientConfig = await fixture.createClientConfig({ strictHostKeyChecking: "yes" });
    const client = await createClient(fixture, clientConfig);
    masters.push({ client, hostId: "fixture" });
    const coordinator = new HostConnectionCoordinator(client);
    const authenticationPids: number[] = [];
    coordinator.onChange((event) => {
      if (event.authenticationBackend) authenticationPids.push(event.authenticationBackend.pid);
    });

    const filesRequest = coordinator.ensureConnected("fixture");
    const tmuxRequest = coordinator.ensureConnected("fixture");

    expect(filesRequest).toBe(tmuxRequest);
    await Promise.all([filesRequest, tmuxRequest]);
    expect(authenticationPids).toHaveLength(1);
    expect(await client.checkMaster("fixture")).toBe(true);
  });

  test("unlocks a real encrypted private key through the SSH PTY without persisting its passphrase", async () => {
    const passphrase = `termloom-${crypto.randomUUID()}`;
    fixture = await SshdFixture.create({ clientKeyPassphrase: passphrase });
    const clientConfig = await fixture.createClientConfig({
      strictHostKeyChecking: "yes",
      batchMode: false,
    });
    const client = await createClient(fixture, clientConfig);
    masters.push({ client, hostId: "fixture" });
    const coordinator = new HostConnectionCoordinator(client);
    const safeEvents: Array<{ status: string; error?: string }> = [];
    let transcript = "";
    let submitted = false;
    coordinator.onChange((event) => {
      safeEvents.push({ status: event.status, ...(event.error ? { error: event.error } : {}) });
      const backend = event.authenticationBackend;
      if (!backend) return;
      const subscription = backend.onData((data) => {
        transcript += data;
        if (submitted || !transcript.includes("Enter passphrase for key")) return;
        submitted = true;
        backend.write(`${passphrase}\r`);
        subscription.dispose();
      });
    });

    await coordinator.ensureConnected("fixture");

    expect(submitted).toBe(true);
    expect(transcript).toContain("Enter passphrase for key");
    expect(await client.checkMaster("fixture")).toBe(true);
    expect(await readFile(clientConfig, "utf8")).not.toContain(passphrase);
    expect(JSON.stringify({ config: defaultConfig(), events: safeEvents })).not.toContain(
      passphrase,
    );
  });

  test("routes simulated OpenSSH password and verification-code prompts through one PTY without persisting credentials", async () => {
    fakeRoot = await mkdtemp("/tmp/tl-prompt-");
    const fakeSsh = join(fakeRoot, "ssh");
    await writeFile(fakeSsh, fakeOpenSshScript(), { mode: 0o700 });
    const password = `password-${crypto.randomUUID()}`;
    const verificationCode = `${crypto.getRandomValues(new Uint32Array(1))[0]}`;
    const passwordEnvironment = "TERMLOOM_TEST_SSH_PASSWORD";
    const codeEnvironment = "TERMLOOM_TEST_SSH_CODE";
    const previousPassword = process.env[passwordEnvironment];
    const previousCode = process.env[codeEnvironment];
    process.env[passwordEnvironment] = password;
    process.env[codeEnvironment] = verificationCode;
    try {
      const config = defaultConfig();
      config.hosts = [{ id: "fixture", alias: "fixture", defaultPath: "." }];
      const client = await SshClient.create(config, {
        resolver: new OpenSshResolver({ binary: fakeSsh, timeoutMs: 2_000 }),
        controlDirectory: join(fakeRoot, "control"),
      });
      masters.push({ client, hostId: "fixture" });
      const coordinator = new HostConnectionCoordinator(client);
      let transcript = "";
      let passwordSent = false;
      let codeSent = false;
      const safeEvents: Array<{ status: string; error?: string }> = [];
      coordinator.onChange((event) => {
        safeEvents.push({ status: event.status, ...(event.error ? { error: event.error } : {}) });
        const backend = event.authenticationBackend;
        if (!backend) return;
        backend.onData((data) => {
          transcript += data;
          if (!passwordSent && transcript.includes("Password:")) {
            passwordSent = true;
            backend.write(`${password}\r`);
          }
          if (!codeSent && transcript.includes("Verification code:")) {
            codeSent = true;
            backend.write(`${verificationCode}\r`);
          }
        });
      });

      await coordinator.ensureConnected("fixture");

      expect(passwordSent).toBe(true);
      expect(codeSent).toBe(true);
      expect(await client.checkMaster("fixture")).toBe(true);
      const persisted = JSON.stringify({ config, workspace: createDefaultWorkspace(), safeEvents });
      expect(persisted).not.toContain(password);
      expect(persisted).not.toContain(verificationCode);
      expect(await readFile(fakeSsh, "utf8")).not.toContain(password);
      expect(await readFile(fakeSsh, "utf8")).not.toContain(verificationCode);
    } finally {
      restoreEnvironment(passwordEnvironment, previousPassword);
      restoreEnvironment(codeEnvironment, previousCode);
    }
  });

  test("cancels an interactive authentication without persisting input and can retry", async () => {
    fixture = await SshdFixture.create();
    const emptyKnownHosts = join(fixture.root, "known_hosts_coordinator_prompt");
    await writeFile(emptyKnownHosts, "", { mode: 0o600 });
    const clientConfig = await fixture.createClientConfig({
      strictHostKeyChecking: "ask",
      knownHostsFile: emptyKnownHosts,
      batchMode: false,
    });
    const client = await createClient(fixture, clientConfig);
    masters.push({ client, hostId: "fixture" });
    const coordinator = new HostConnectionCoordinator(client);
    let authenticationCount = 0;
    coordinator.onChange((event) => {
      if (!event.authenticationBackend) return;
      authenticationCount += 1;
      if (authenticationCount === 1) coordinator.cancel(event.hostId);
      else {
        let prompt = "";
        const dataSubscription = event.authenticationBackend.onData((data) => {
          prompt += data;
          if (!prompt.includes("Are you sure you want to continue connecting")) return;
          dataSubscription.dispose();
          event.authenticationBackend?.write("yes\r");
        });
      }
    });

    await expect(coordinator.ensureConnected("fixture")).rejects.toMatchObject({
      code: "PROCESS_CANCELLED",
    });
    await coordinator.ensureConnected("fixture");
    expect(authenticationCount).toBe(2);
    expect(await client.checkMaster("fixture")).toBe(true);
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

function fakeOpenSshScript(): string {
  return `#!/bin/sh
control_path=""
operation=""
config_mode="false"
master_mode="false"
while [ "$#" -gt 0 ]; do
  case "$1" in
    -G) config_mode="true" ;;
    -M) master_mode="true" ;;
    -O)
      shift
      operation="$1"
      ;;
    -o)
      shift
      case "$1" in
        ControlPath=*) control_path="\${1#ControlPath=}" ;;
      esac
      ;;
  esac
  shift
done
if [ "$config_mode" = "true" ]; then
  printf '%s\n' 'hostname 127.0.0.1' 'user fixture' 'port 22' 'stricthostkeychecking no'
  exit 0
fi
if [ "$operation" = "check" ]; then
  [ -n "$control_path" ] && [ -f "$control_path" ]
  exit $?
fi
if [ "$operation" = "exit" ]; then
  [ -n "$control_path" ] && rm -f "$control_path"
  exit 0
fi
if [ "$master_mode" = "true" ]; then
  printf 'Password: '
  IFS= read -r password
  [ "$password" = "$TERMLOOM_TEST_SSH_PASSWORD" ] || exit 1
  printf 'Verification code: '
  IFS= read -r verification_code
  [ "$verification_code" = "$TERMLOOM_TEST_SSH_CODE" ] || exit 1
  : > "$control_path"
  exit 0
fi
exit 1
`;
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
