#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

interface BuildInfo {
  schemaVersion: 1;
  name: "termloom";
  version: string;
  commit: string;
  commitDate: string;
  platform: "darwin";
  arch: "arm64";
  bunVersion: string;
  signature: "ad-hoc";
  notarized: false;
  binarySha256: string;
  externalRuntimeDependencies: readonly string[];
}

const root = join(import.meta.dir, "..");
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
  name: string;
  version: string;
  packageManager?: string;
};
const version = argument("--version") ?? manifest.version;
const binary = resolve(root, argument("--binary") ?? "dist/termloom");
const outputDirectory = resolve(root, argument("--output") ?? "dist/release");
const target = "darwin-arm64";
const rootName = `termloom-v${version}-${target}`;
const archiveName = `${rootName}.tar.gz`;
const archive = join(outputDirectory, archiveName);
const checksum = `${archive}.sha256`;
const expectedPackageManager = `bun@${Bun.version}`;

if (manifest.name !== "termloom") throw new Error(`Unexpected package name: ${manifest.name}`);
if (version !== manifest.version) {
  throw new Error(`Requested version ${version} does not match package.json ${manifest.version}`);
}
if (manifest.packageManager !== expectedPackageManager) {
  throw new Error(
    `Release requires ${manifest.packageManager ?? "a pinned Bun version"}; running ${expectedPackageManager}`,
  );
}
if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error(
    `v${version} release packaging requires darwin/arm64, received ${process.platform}/${process.arch}`,
  );
}
if (!(await isFile(binary))) throw new Error(`Compiled binary not found: ${binary}`);

const gitStatus = await execute([requiredExecutable("git"), "status", "--porcelain=v1"], root);
if (gitStatus.stdout.trim().length > 0) {
  throw new Error("Release packaging requires a clean Git worktree");
}
const commit = (
  await execute([requiredExecutable("git"), "rev-parse", "HEAD"], root)
).stdout.trim();
const commitDate = (
  await execute([requiredExecutable("git"), "show", "-s", "--format=%cI", "HEAD"], root)
).stdout.trim();

await mkdir(outputDirectory, { recursive: true, mode: 0o755 });
if ((await pathExists(archive)) || (await pathExists(checksum))) {
  throw new Error(`Release output already exists: ${archiveName}`);
}

const temporary = await mkdtemp(join(tmpdir(), "termloom-release-"));
const stagingRoot = join(temporary, rootName);
try {
  await mkdir(stagingRoot, { mode: 0o755 });
  const packagedBinary = join(stagingRoot, "termloom");
  await copyFile(binary, packagedBinary);
  await chmod(packagedBinary, 0o755);
  await execute(
    ["/usr/bin/codesign", "--force", "--sign", "-", "--timestamp=none", packagedBinary],
    root,
  );
  await execute(
    ["/usr/bin/codesign", "--verify", "--deep", "--strict", "--verbose=2", packagedBinary],
    root,
  );

  const publicFiles = [
    "README.md",
    "README.CN.md",
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
    "THIRD_PARTY_LICENSES.txt",
  ] as const;
  for (const file of publicFiles) {
    const source = join(root, file);
    if (!(await isFile(source))) throw new Error(`Required release file is missing: ${file}`);
    await copyFile(source, join(stagingRoot, file));
    await chmod(join(stagingRoot, file), 0o644);
  }

  const buildInfo: BuildInfo = {
    schemaVersion: 1,
    name: "termloom",
    version,
    commit,
    commitDate,
    platform: "darwin",
    arch: "arm64",
    bunVersion: Bun.version,
    signature: "ad-hoc",
    notarized: false,
    binarySha256: await sha256(packagedBinary),
    externalRuntimeDependencies: ["ssh", "tmux", "rclone", "ffmpeg", "ffprobe", "mpv", "resvg"],
  };
  await writeFile(join(stagingRoot, "BUILDINFO.json"), `${JSON.stringify(buildInfo, null, 2)}\n`, {
    mode: 0o644,
  });

  await execute(["/usr/bin/tar", "-czf", archive, "-C", temporary, rootName], root);
  const listing = (await execute(["/usr/bin/tar", "-tzf", archive], root)).stdout;
  for (const expected of [
    `${rootName}/termloom`,
    `${rootName}/LICENSE`,
    `${rootName}/THIRD_PARTY_LICENSES.txt`,
    `${rootName}/BUILDINFO.json`,
  ]) {
    if (!listing.split("\n").includes(expected)) {
      throw new Error(`Archive is missing ${expected}`);
    }
  }
  const archiveDigest = await sha256(archive);
  await writeFile(checksum, `${archiveDigest}  ${archiveName}\n`, { mode: 0o644 });
  console.log(
    [
      `Packaged ${basename(archive)}`,
      `SHA256 ${archiveDigest}`,
      `Binary SHA256 ${buildInfo.binarySha256}`,
      "Signature ad-hoc; notarized false",
      `Commit ${commit}`,
    ].join("\n"),
  );
} catch (error) {
  await rm(archive, { force: true }).catch(() => undefined);
  await rm(checksum, { force: true }).catch(() => undefined);
  throw error;
} finally {
  await rm(temporary, { recursive: true, force: true });
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function requiredExecutable(name: string): string {
  const executable = Bun.which(name);
  if (!executable) throw new Error(`${name} is required for release packaging`);
  return executable;
}

async function execute(command: readonly string[], cwd: string) {
  const subprocess = Bun.spawn([...command], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `${command[0]} failed with status ${exitCode}: ${(stderr || stdout).trim().slice(0, 2_000)}`,
    );
  }
  return { stdout, stderr };
}

async function sha256(path: string): Promise<string> {
  const digest = createHash("sha256");
  const stream = Bun.file(path).stream().getReader();
  while (true) {
    const { value, done } = await stream.read();
    if (done) break;
    digest.update(value);
  }
  return digest.digest("hex");
}

async function isFile(path: string): Promise<boolean> {
  return stat(path)
    .then((metadata) => metadata.isFile())
    .catch(() => false);
}

async function pathExists(path: string): Promise<boolean> {
  return stat(path)
    .then(() => true)
    .catch(() => false);
}
