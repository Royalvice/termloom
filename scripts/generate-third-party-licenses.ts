import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

interface PackageManifest {
  name: string;
  version: string;
  license?: string | { type?: string };
  repository?: string | { url?: string };
  homepage?: string;
  dependencies?: Readonly<Record<string, string>>;
  optionalDependencies?: Readonly<Record<string, string>>;
  peerDependencies?: Readonly<Record<string, string>>;
}

interface PackageRecord {
  key: string;
  directory: string;
  manifest: PackageManifest;
}

const root = join(import.meta.dir, "..");
const outputPath = join(root, "THIRD_PARTY_LICENSES.txt");
const bunLicensePath = join(root, "licenses", "BUN_LICENSE.md");
const expectedBunVersion = "1.3.14";
const supportedOpenTuiNativePackages = [
  "@opentui/core-darwin-arm64",
  "@opentui/core-darwin-x64",
  "@opentui/core-linux-x64",
] as const;

const licenseOverrides: Readonly<Record<string, string>> = {
  "@mathjax/mathjax-newcm-font": join(root, "node_modules", "@mathjax", "src", "LICENSE"),
  "@xterm/headless": join(root, "licenses", "overrides", "xterm-headless-LICENSE"),
  "emoji-regex": join(root, "licenses", "overrides", "emoji-regex-LICENSE"),
  "remark-math": join(root, "licenses", "overrides", "remark-math-LICENSE"),
};

const rootManifest = await readManifest(join(root, "package.json"));
if (!rootManifest.dependencies) throw new Error("package.json has no production dependencies");
if (Bun.version !== expectedBunVersion) {
  throw new Error(`License inventory requires Bun ${expectedBunVersion}; running ${Bun.version}`);
}

const packages = await collectProductionPackages(Object.keys(rootManifest.dependencies));
const generated = await renderBundle(packages);
if (process.argv.includes("--check")) {
  const current = await readFile(outputPath, "utf8").catch(() => "");
  if (current !== generated) {
    throw new Error(
      `${relative(root, outputPath)} is stale; run "bun run licenses" with Bun ${expectedBunVersion}`,
    );
  }
  console.log(
    `Verified ${packages.length} production package license records and Bun runtime notices`,
  );
} else {
  await writeFile(outputPath, generated, "utf8");
  console.log(`Wrote ${relative(root, outputPath)} with ${packages.length} package records`);
}

async function collectProductionPackages(directDependencies: readonly string[]) {
  const queue = directDependencies.map((name) => ({ name, from: root }));
  const found = new Map<string, PackageRecord>();
  while (queue.length > 0) {
    const item = queue.shift();
    if (!item) break;
    const directory = resolvePackageDirectory(item.name, item.from);
    if (!directory) {
      throw new Error(`Unable to resolve production dependency ${item.name} from ${item.from}`);
    }
    const manifest = await readManifest(join(directory, "package.json"));
    const key = `${manifest.name}@${manifest.version}`;
    if (found.has(key)) continue;
    found.set(key, { key, directory, manifest });
    for (const field of ["dependencies", "optionalDependencies", "peerDependencies"] as const) {
      for (const dependency of Object.keys(manifest[field] ?? {})) {
        if (isOpenTuiNativePackage(dependency)) continue;
        if (resolvePackageDirectory(dependency, directory)) {
          queue.push({ name: dependency, from: directory });
        }
      }
    }
  }
  addSupportedOpenTuiNativePackages(found);
  return [...found.values()].sort((left, right) => left.key.localeCompare(right.key));
}

function addSupportedOpenTuiNativePackages(found: Map<string, PackageRecord>): void {
  const core = [...found.values()].find((record) => record.manifest.name === "@opentui/core");
  if (!core) throw new Error("Production graph does not contain @opentui/core");

  for (const name of supportedOpenTuiNativePackages) {
    const version = core.manifest.optionalDependencies?.[name];
    if (!version)
      throw new Error(`@opentui/core does not declare supported native package ${name}`);
    const manifest: PackageManifest = {
      name,
      version,
      ...(core.manifest.license ? { license: core.manifest.license } : {}),
      ...(core.manifest.repository ? { repository: core.manifest.repository } : {}),
      ...(core.manifest.homepage ? { homepage: core.manifest.homepage } : {}),
    };
    const key = `${name}@${version}`;
    found.set(key, { key, directory: core.directory, manifest });
  }
}

function isOpenTuiNativePackage(name: string): boolean {
  return name.startsWith("@opentui/core-");
}

function resolvePackageDirectory(name: string, from: string): string | undefined {
  let current = from;
  while (true) {
    const candidate = join(current, "node_modules", ...name.split("/"));
    if (existsSync(join(candidate, "package.json"))) return candidate;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

async function renderBundle(packages: readonly PackageRecord[]): Promise<string> {
  const lines = [
    "TERMLOOM THIRD-PARTY LICENSES",
    "============================",
    "",
    "Generated deterministically from package.json, the production dependency graph,",
    `and Bun ${expectedBunVersion}. Development-only packages are excluded. Installed peer packages`,
    "are included when they may be selected by the compiled runtime. OpenTUI native packages for",
    "the v0.2.0 darwin-arm64, darwin-x64, and linux-x64 targets are always included so this bundle",
    "is identical on every supported build host.",
    "",
    "TermLoom invokes OpenSSH, tmux, rclone, FFmpeg/ffprobe, mpv, and resvg as external",
    "programs. Those executables are not distributed in the TermLoom release archive and are",
    "therefore not reproduced in this bundled-code license inventory.",
    "",
    separator(),
    `Bun runtime ${expectedBunVersion}`,
    "Source: https://github.com/oven-sh/bun",
    "License metadata: MIT plus licenses of statically linked and embedded components",
    separator(),
    normalize(await readFile(bunLicensePath, "utf8")),
  ];

  for (const record of packages) {
    const licenseFiles = await findLicenseFiles(record);
    lines.push(
      separator(),
      record.key,
      `Declared license: ${licenseName(record.manifest.license)}`,
      `Source: ${repositoryUrl(record.manifest)}`,
      separator(),
    );
    for (const file of licenseFiles) {
      lines.push(normalize(await readFile(file, "utf8")));
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

async function findLicenseFiles(record: PackageRecord): Promise<readonly string[]> {
  const override = licenseOverrides[record.manifest.name];
  if (override) {
    if (!existsSync(override)) throw new Error(`Missing license override for ${record.key}`);
    return [override];
  }
  const entries = await readdir(record.directory);
  const matches = entries
    .filter((name) => /^(licen[cs]e|copying|notice)(\..*)?$/iu.test(name))
    .sort((left, right) => left.localeCompare(right))
    .map((name) => join(record.directory, name));
  if (matches.length === 0) throw new Error(`No license or notice file found for ${record.key}`);
  return matches;
}

function licenseName(value: PackageManifest["license"]): string {
  if (typeof value === "string" && value.length > 0) return value;
  if (value && typeof value === "object" && value.type) return value.type;
  return "UNDECLARED";
}

function repositoryUrl(manifest: PackageManifest): string {
  const repository =
    typeof manifest.repository === "string" ? manifest.repository : manifest.repository?.url;
  let value = repository ?? manifest.homepage ?? `https://www.npmjs.com/package/${manifest.name}`;
  value = value.replace(/^git\+/u, "");
  value = value.replace(/^github:/u, "https://github.com/");
  value = value.replace(/^git@github\.com:/u, "https://github.com/");
  value = value.replace(/^ssh:\/\/git@github\.com\//u, "https://github.com/");
  value = value.replace(/^git:\/\//u, "https://");
  return value.replace(/\.git$/u, "");
}

async function readManifest(path: string): Promise<PackageManifest> {
  return JSON.parse(await readFile(path, "utf8")) as PackageManifest;
}

function normalize(value: string): string {
  return value
    .replaceAll("\r\n", "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

function separator(): string {
  return "\n--------------------------------------------------------------------------------\n";
}
