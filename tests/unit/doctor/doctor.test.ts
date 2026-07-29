import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTerminalCapabilities } from "@opentui/core/testing";
import type { TermLoomPaths } from "../../../src/config/paths.js";
import { defaultConfig } from "../../../src/config/schema.js";
import { ConfigStore } from "../../../src/config/store.js";
import { formatDoctorReport, runDoctor, type DoctorReport } from "../../../src/doctor/doctor.js";
import { createDefaultWorkspace } from "../../../src/workspace/schema.js";
import { WorkspaceStore } from "../../../src/workspace/store.js";

const dependencies = ["ssh", "tmux", "rclone", "ffmpeg", "ffprobe", "mpv", "resvg"] as const;
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("TermLoom doctor", () => {
  test("passes complete dependencies, persisted stores, SSH aliases, and injected capabilities", async () => {
    const fixture = await createFixture();
    const capabilities = createTerminalCapabilities({
      terminal: { name: "ghostty", version: "1.2.3", from_xtversion: true },
      kitty_graphics: true,
      rgb: true,
    });

    const report = await runDoctor({
      environment: fixture.environment,
      paths: fixture.paths,
      terminalCapabilities: capabilities,
      stdinIsTty: true,
      stdoutIsTty: true,
      now: () => new Date("2026-07-28T00:00:00.000Z"),
    });

    expect(report.ok).toBe(true);
    expect(report.generatedAt).toBe("2026-07-28T00:00:00.000Z");
    expect(report.dependencies).toHaveLength(7);
    expect(report.dependencies.every((dependency) => dependency.status === "pass")).toBe(true);
    expect(report.paths.every((path) => path.status === "pass")).toBe(true);
    expect(report.configuration).toMatchObject({ status: "pass", hostCount: 1 });
    expect(report.configuration.hosts).toEqual([
      {
        id: "ssh-host:fixture",
        status: "pass",
        message: "OpenSSH effective configuration resolves",
      },
    ]);
    expect(report.workspace).toMatchObject({ status: "pass", tabs: 1, panes: 2 });
    expect(report.terminal).toMatchObject({
      status: "pass",
      identity: "ghostty",
      capabilitySource: "injected",
      adapter: { name: "kitty", protocol: "kitty-unicode" },
    });
    expect(report.security.every((check) => check.status === "pass")).toBe(true);
  });

  test("fails explicitly when a required executable is absent", async () => {
    const fixture = await createFixture({ missingDependency: "mpv" });
    const report = await runFixtureDoctor(fixture);

    expect(report.ok).toBe(false);
    expect(report.dependencies.find((dependency) => dependency.name === "mpv")).toEqual({
      name: "mpv",
      status: "fail",
      message: "mpv was not found on PATH",
    });
  });

  test("fails explicitly when rclone cannot reuse external OpenSSH", async () => {
    const fixture = await createFixture({ rcloneSupportsExternalSsh: false });
    const report = await runFixtureDoctor(fixture);

    expect(report.ok).toBe(false);
    expect(report.dependencies.find((dependency) => dependency.name === "rclone")).toMatchObject({
      name: "rclone",
      status: "fail",
      version: "rclone fixture 1.0",
      message: "rclone does not support the required --sftp-ssh external OpenSSH flag",
    });
  });

  test("reports corrupted configuration and workspace without resetting either file", async () => {
    const fixture = await createFixture();
    await writeFile(fixture.paths.configFile, "not = [valid", "utf8");
    await writeFile(fixture.paths.stateFile, "{broken", "utf8");

    const report = await runFixtureDoctor(fixture);

    expect(report.ok).toBe(false);
    expect(report.configuration.status).toBe("fail");
    expect(report.workspace.status).toBe("fail");
    expect(await readFile(fixture.paths.configFile, "utf8")).toBe("not = [valid");
    expect(await readFile(fixture.paths.stateFile, "utf8")).toBe("{broken");
  });

  test("fails group/world writable persistent files", async () => {
    const fixture = await createFixture();
    await chmod(fixture.paths.configFile, 0o666);
    await chmod(fixture.paths.stateFile, 0o666);

    const report = await runFixtureDoctor(fixture);

    expect(report.ok).toBe(false);
    expect(report.security.find((check) => check.id === "config-permissions")?.status).toBe("fail");
    expect(report.security.find((check) => check.id === "state-permissions")?.status).toBe("fail");
  });

  test("detects but never echoes credential material from logs", async () => {
    const fixture = await createFixture();
    const secret = crypto.randomUUID();
    await writeFile(join(fixture.paths.logDirectory, "termloom.log"), `token = "${secret}"\n`);

    const report = await runFixtureDoctor(fixture);
    const serialized = JSON.stringify(report);

    expect(report.ok).toBe(false);
    expect(report.security.find((check) => check.id === "sensitive-content")?.status).toBe("fail");
    expect(serialized).not.toContain(secret);
    expect(serialized).toContain(fixture.paths.logDirectory);
  });

  test("formats an actionable human-readable report with every section", async () => {
    const fixture = await createFixture({ missingDependency: "resvg" });
    const output = formatDoctorReport(await runFixtureDoctor(fixture));

    expect(output).toContain("Overall: FAIL");
    expect(output).toContain("Dependencies");
    expect(output).toContain("[FAIL] resvg");
    expect(output).toContain("Terminal");
    expect(output).toContain("Paths");
    expect(output).toContain("Configuration and workspace");
    expect(output).toContain("SSH Config discovery");
    expect(output).toContain("Security");
    expect(output).toContain("[PASS]");
  });

  test("reports recursive Include files and literal Hosts without making network connections", async () => {
    const fixture = await createFixture();
    const sshDirectory = join(fixture.root, ".ssh");
    const includeDirectory = join(sshDirectory, "conf.d");
    await mkdir(includeDirectory, { recursive: true, mode: 0o700 });
    await writeFile(
      join(sshDirectory, "config"),
      "Include conf.d/*.conf\nHost edge-a\nHost *.wildcard\n",
      "utf8",
    );
    await writeFile(join(includeDirectory, "edge.conf"), "Host edge-b\n", "utf8");

    const report = await runFixtureDoctor(fixture);
    expect(report.ok).toBe(true);
    expect(report.hostDiscovery).toMatchObject({
      status: "pass",
      rootExists: true,
      includeFileCount: 1,
      literalHostCount: 2,
      errorCount: 0,
    });
    expect(report.configuration.hostCount).toBe(3);
    expect(report.configuration.hosts).toHaveLength(3);
    expect(report.configuration.hosts.every((check) => check.status === "pass")).toBe(true);
  });

  test("keeps per-alias ssh -G failures independent and reports Include errors", async () => {
    const fixture = await createFixture();
    const sshDirectory = join(fixture.root, ".ssh");
    const invocationLog = join(fixture.root, "ssh-invocations.log");
    await mkdir(sshDirectory, { recursive: true, mode: 0o700 });
    await writeFile(
      join(sshDirectory, "config"),
      "Include missing/*.conf\nHost edge-good edge-bad\n",
      "utf8",
    );
    const sshScript = `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(invocationLog)}
if [ "$1" = "-G" ]; then
  for value in "$@"; do target="$value"; done
  if [ "$target" = "edge-bad" ]; then exit 7; fi
  printf 'hostname 127.0.0.1\\nuser fixture\\nport 22\\nidentityfile none\\nuserknownhostsfile /tmp/known_hosts\\nstricthostkeychecking ask\\n'
  exit 0
fi
printf 'OpenSSH_fixture 1.0\\n' >&2
`;
    await writeFile(join(fixture.root, "bin", "ssh"), sshScript, {
      encoding: "utf8",
      mode: 0o700,
    });

    const report = await runFixtureDoctor(fixture);
    expect(report.ok).toBe(false);
    expect(report.hostDiscovery).toMatchObject({ status: "fail", errorCount: 1 });
    const hostChecks = report.configuration.hosts;
    expect(hostChecks.filter((check) => check.status === "pass")).toHaveLength(2);
    expect(hostChecks.filter((check) => check.status === "fail")).toHaveLength(1);
    const invocations = (await readFile(invocationLog, "utf8")).trim().split("\n");
    const hostProbes = invocations.filter((line) => line.startsWith("-G "));
    expect(hostProbes).toHaveLength(3);
    expect(hostProbes.every((line) => line.startsWith("-G -T -- "))).toBe(true);
  });
});

interface DoctorFixture {
  root: string;
  paths: TermLoomPaths;
  environment: Readonly<Record<string, string>>;
}

async function createFixture(
  options: {
    missingDependency?: (typeof dependencies)[number];
    rcloneSupportsExternalSsh?: boolean;
  } = {},
): Promise<DoctorFixture> {
  const root = await mkdtemp(join(tmpdir(), "termloom-doctor-"));
  roots.push(root);
  const binaries = join(root, "bin");
  const paths: TermLoomPaths = {
    configFile: join(root, "config", "termloom", "config.toml"),
    stateFile: join(root, "state", "termloom", "workspaces.json"),
    cacheDirectory: join(root, "cache", "termloom"),
    controlDirectory: join(root, "cache", "termloom", "ssh-control"),
    logDirectory: join(root, "state", "termloom", "logs"),
  };
  await mkdir(binaries, { recursive: true, mode: 0o700 });
  await Promise.all(
    dependencies
      .filter((dependency) => dependency !== options.missingDependency)
      .map((dependency) =>
        writeExecutable(
          join(binaries, dependency),
          dependency,
          options.rcloneSupportsExternalSsh !== false,
        ),
      ),
  );
  await Promise.all([
    mkdir(paths.cacheDirectory, { recursive: true, mode: 0o700 }),
    mkdir(paths.controlDirectory, { recursive: true, mode: 0o700 }),
    mkdir(paths.logDirectory, { recursive: true, mode: 0o700 }),
  ]);

  const config = defaultConfig();
  config.hosts.push({ id: "fixture", alias: "fixture-host", defaultPath: "." });
  await new ConfigStore(paths.configFile).save(config);
  await new WorkspaceStore(paths.stateFile).save(createDefaultWorkspace());

  return {
    root,
    paths,
    environment: {
      HOME: root,
      PATH: binaries,
      TERM: "xterm-ghostty",
      TERM_PROGRAM: "ghostty",
      COLORTERM: "truecolor",
    },
  };
}

async function writeExecutable(
  path: string,
  dependency: (typeof dependencies)[number],
  rcloneSupportsExternalSsh: boolean,
) {
  const body =
    dependency === "ssh"
      ? `#!/bin/sh
if [ "$1" = "-G" ]; then
  printf 'hostname 127.0.0.1\\nuser fixture\\nport 22\\nidentityfile none\\nuserknownhostsfile /tmp/known_hosts\\nstricthostkeychecking ask\\n'
  exit 0
fi
printf 'OpenSSH_fixture 1.0\\n' >&2
`
      : dependency === "rclone"
        ? `#!/bin/sh
if [ "$1" = "help" ] && [ "$2" = "flags" ]; then
  printf '%s\\n' '${rcloneSupportsExternalSsh ? "--sftp-ssh SpaceSepList" : "--sftp-host string"}'
  exit 0
fi
printf 'rclone fixture 1.0\\n'
`
        : `#!/bin/sh
printf '${dependency} fixture 1.0\\n'
`;
  await writeFile(path, body, { encoding: "utf8", mode: 0o700 });
  await chmod(path, 0o700);
}

function runFixtureDoctor(fixture: DoctorFixture): Promise<DoctorReport> {
  return runDoctor({
    environment: fixture.environment,
    paths: fixture.paths,
    terminalCapabilities: null,
    probeTerminal: false,
    stdinIsTty: false,
    stdoutIsTty: false,
  });
}
