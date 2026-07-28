import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DoctorReport } from "../../src/doctor/doctor.js";

const dependencies = ["ssh", "tmux", "rclone", "ffmpeg", "ffprobe", "mpv", "resvg"] as const;
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("termloom doctor CLI", () => {
  test("prints valid JSON and exits zero when all checks pass", async () => {
    const fixture = await createCliFixture();
    const result = await runCli(fixture);
    const report = JSON.parse(result.stdout) as DoctorReport;

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(report.schemaVersion).toBe(1);
    expect(report.ok).toBe(true);
    expect(report.dependencies).toHaveLength(7);
  });

  test("keeps JSON on stdout and exits one when a dependency is missing", async () => {
    const fixture = await createCliFixture("ffprobe");
    const result = await runCli(fixture);
    const report = JSON.parse(result.stdout) as DoctorReport;

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(report.ok).toBe(false);
    expect(report.dependencies.find((dependency) => dependency.name === "ffprobe")?.status).toBe(
      "fail",
    );
  });
});

interface CliFixture {
  root: string;
  environment: Record<string, string>;
}

async function createCliFixture(
  missingDependency?: (typeof dependencies)[number],
): Promise<CliFixture> {
  const root = await mkdtemp(join(tmpdir(), "termloom-doctor-cli-"));
  roots.push(root);
  const binaries = join(root, "bin");
  await mkdir(binaries, { recursive: true, mode: 0o700 });
  await Promise.all(
    dependencies
      .filter((dependency) => dependency !== missingDependency)
      .map(async (dependency) => {
        const path = join(binaries, dependency);
        await writeFile(path, `#!/bin/sh\nprintf '${dependency} fixture 1.0\\n'\n`, {
          encoding: "utf8",
          mode: 0o700,
        });
        await chmod(path, 0o700);
      }),
  );
  return {
    root,
    environment: {
      ...definedEnvironment(process.env),
      HOME: root,
      PATH: binaries,
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_STATE_HOME: join(root, "state"),
      XDG_CACHE_HOME: join(root, "cache"),
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
    },
  };
}

async function runCli(fixture: CliFixture) {
  const processHandle = Bun.spawn(
    [process.execPath, "run", "src/index.ts", "doctor", "--json", "--no-terminal-probe"],
    {
      cwd: process.cwd(),
      env: fixture.environment,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    processHandle.exited,
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

function definedEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}
