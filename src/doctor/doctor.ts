import { constants } from "node:fs";
import { access, readFile, readdir, stat } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import type { TerminalCapabilities } from "@opentui/core";
import { ConfigStore } from "../config/store.js";
import { resolveTermLoomPaths, type TermLoomPaths } from "../config/paths.js";
import type { TermLoomConfig } from "../config/schema.js";
import { errorMessage } from "../core/errors.js";
import { selectMediaAdapter, waitForTerminalCapabilities } from "../media/capabilities.js";
import type { MediaAdapterSelection } from "../media/types.js";
import { redactText, runProcess } from "../process/process-runner.js";
import { parseEffectiveSshConfig } from "../ssh/resolver.js";
import { WorkspaceStore } from "../workspace/store.js";

export type DoctorStatus = "pass" | "warn" | "fail" | "skipped";

export interface DoctorDependencyResult {
  name: "ssh" | "tmux" | "rclone" | "ffmpeg" | "ffprobe" | "mpv" | "resvg";
  status: DoctorStatus;
  path?: string;
  version?: string;
  message: string;
}

export interface DoctorPathResult {
  name: keyof TermLoomPaths;
  path: string;
  status: DoctorStatus;
  exists: boolean;
  kind?: "file" | "directory" | "other";
  mode?: string;
  message: string;
}

export interface DoctorCheck {
  id: string;
  status: DoctorStatus;
  message: string;
}

export interface DoctorReport {
  schemaVersion: 1;
  generatedAt: string;
  ok: boolean;
  runtime: {
    termloomVersion: string;
    bunVersion: string;
    platform: NodeJS.Platform;
    arch: string;
  };
  dependencies: readonly DoctorDependencyResult[];
  terminal: {
    status: DoctorStatus;
    identity: MediaAdapterSelection["terminal"];
    environment: {
      TERM?: string;
      TERM_PROGRAM?: string;
      COLORTERM?: string;
      multiplexed: boolean;
    };
    tty: { stdin: boolean; stdout: boolean };
    capabilitySource: "opentui" | "injected" | "environment-only";
    capabilities: TerminalCapabilities | null;
    adapter?: MediaAdapterSelection;
    message: string;
  };
  paths: readonly DoctorPathResult[];
  configuration: {
    status: DoctorStatus;
    path: string;
    exists: boolean;
    hostCount?: number;
    locale?: string;
    configuredAdapter?: string;
    message: string;
    hosts: readonly DoctorCheck[];
  };
  workspace: {
    status: DoctorStatus;
    path: string;
    exists: boolean;
    tabs?: number;
    panes?: number;
    message: string;
  };
  security: readonly DoctorCheck[];
}

export interface DoctorOptions {
  environment?: Readonly<Record<string, string | undefined>>;
  paths?: TermLoomPaths;
  terminalCapabilities?: TerminalCapabilities | null;
  probeTerminal?: boolean;
  stdinIsTty?: boolean;
  stdoutIsTty?: boolean;
  now?: () => Date;
}

interface DependencyDefinition {
  name: DoctorDependencyResult["name"];
  versionArgs: readonly string[];
  capability?: {
    args: readonly string[];
    requiredText: string;
    failureMessage: string;
  };
}

const dependencyDefinitions: readonly DependencyDefinition[] = [
  { name: "ssh", versionArgs: ["-V"] },
  { name: "tmux", versionArgs: ["-V"] },
  {
    name: "rclone",
    versionArgs: ["version"],
    capability: {
      args: ["help", "flags"],
      requiredText: "--sftp-ssh",
      failureMessage: "rclone does not support the required --sftp-ssh external OpenSSH flag",
    },
  },
  { name: "ffmpeg", versionArgs: ["-version"] },
  { name: "ffprobe", versionArgs: ["-version"] },
  { name: "mpv", versionArgs: ["--version"] },
  { name: "resvg", versionArgs: ["--version"] },
];

export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const environment = options.environment ?? process.env;
  const paths = options.paths ?? resolveTermLoomPaths(environment);
  const stdinIsTty = options.stdinIsTty ?? Boolean(process.stdin.isTTY);
  const stdoutIsTty = options.stdoutIsTty ?? Boolean(process.stdout.isTTY);
  const dependencies = await Promise.all(
    dependencyDefinitions.map((definition) => inspectDependency(definition, environment)),
  );
  const pathResults = await Promise.all(
    (Object.entries(paths) as Array<[keyof TermLoomPaths, string]>).map(([name, path]) =>
      inspectPath(name, path),
    ),
  );

  const configExists = await exists(paths.configFile);
  let config: TermLoomConfig | undefined;
  let configuration: DoctorReport["configuration"];
  try {
    config = await new ConfigStore(paths.configFile).load();
    configuration = {
      status: "pass",
      path: paths.configFile,
      exists: configExists,
      hostCount: config.hosts.length,
      locale: config.ui.locale,
      configuredAdapter: config.media.adapter,
      message: configExists
        ? "Configuration is valid"
        : "Configuration file is absent; schema defaults are valid",
      hosts: [],
    };
  } catch (error) {
    configuration = {
      status: "fail",
      path: paths.configFile,
      exists: configExists,
      message: safeError(error),
      hosts: [],
    };
  }

  if (config) {
    const ssh = dependencies.find((dependency) => dependency.name === "ssh");
    configuration.hosts = await inspectHosts(config, ssh, environment);
    if (configuration.hosts.some((check) => check.status === "fail")) {
      configuration.status = "fail";
      configuration.message = "Configuration schema is valid, but one or more OpenSSH aliases fail";
    }
  }

  const stateExists = await exists(paths.stateFile);
  let workspace: DoctorReport["workspace"];
  try {
    const snapshot = await new WorkspaceStore(paths.stateFile).load(config?.ui.sidebarWidth ?? 28);
    workspace = {
      status: "pass",
      path: paths.stateFile,
      exists: stateExists,
      tabs: snapshot.tabs.length,
      panes: Object.keys(snapshot.panes).length,
      message: stateExists
        ? "Workspace state is valid"
        : "Workspace state is absent; the default workspace is valid",
    };
  } catch (error) {
    workspace = {
      status: "fail",
      path: paths.stateFile,
      exists: stateExists,
      message: safeError(error),
    };
  }

  const terminalProbe = await inspectTerminal({
    environment,
    configuredAdapter: config?.media.adapter ?? "auto",
    injectedCapabilities: options.terminalCapabilities,
    shouldProbe: options.probeTerminal !== false && stdinIsTty && stdoutIsTty,
    stdinIsTty,
    stdoutIsTty,
  });
  const security = await inspectSecurity(paths);
  const failed =
    dependencies.some((dependency) => dependency.status === "fail") ||
    pathResults.some((path) => path.status === "fail") ||
    configuration.status === "fail" ||
    workspace.status === "fail" ||
    terminalProbe.status === "fail" ||
    security.some((check) => check.status === "fail");

  return {
    schemaVersion: 1,
    generatedAt: (options.now?.() ?? new Date()).toISOString(),
    ok: !failed,
    runtime: {
      termloomVersion: "0.1.0",
      bunVersion: Bun.version,
      platform: process.platform,
      arch: process.arch,
    },
    dependencies,
    terminal: terminalProbe,
    paths: pathResults,
    configuration,
    workspace,
    security,
  };
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines = [
    `TermLoom Doctor ${report.runtime.termloomVersion}`,
    `Overall: ${report.ok ? "PASS" : "FAIL"}`,
    `Runtime: Bun ${report.runtime.bunVersion} · ${report.runtime.platform}/${report.runtime.arch}`,
    "",
    "Dependencies",
  ];
  for (const dependency of report.dependencies) {
    lines.push(
      `  ${statusLabel(dependency.status)} ${dependency.name}: ${dependency.version ?? dependency.message}${
        dependency.path ? ` (${dependency.path})` : ""
      }`,
    );
  }
  lines.push(
    "",
    "Terminal",
    `  ${statusLabel(report.terminal.status)} ${report.terminal.identity} · ${
      report.terminal.adapter?.protocol ?? "no adapter"
    } · ${report.terminal.capabilitySource}`,
    `  ${report.terminal.message}`,
    "",
    "Paths",
  );
  for (const path of report.paths) {
    lines.push(`  ${statusLabel(path.status)} ${path.name}: ${path.path} — ${path.message}`);
  }
  lines.push(
    "",
    "Configuration and workspace",
    `  ${statusLabel(report.configuration.status)} config: ${report.configuration.message}`,
  );
  for (const host of report.configuration.hosts) {
    lines.push(`    ${statusLabel(host.status)} ${host.id}: ${host.message}`);
  }
  lines.push(
    `  ${statusLabel(report.workspace.status)} workspace: ${report.workspace.message}`,
    "",
    "Security",
  );
  for (const check of report.security) {
    lines.push(`  ${statusLabel(check.status)} ${check.id}: ${check.message}`);
  }
  return lines.join("\n");
}

async function inspectDependency(
  definition: DependencyDefinition,
  environment: Readonly<Record<string, string | undefined>>,
): Promise<DoctorDependencyResult> {
  const path = await findExecutable(definition.name, envValue(environment, "PATH"));
  if (!path) {
    return {
      name: definition.name,
      status: "fail",
      message: `${definition.name} was not found on PATH`,
    };
  }
  try {
    const result = await runProcess(path, definition.versionArgs, {
      timeoutMs: 5_000,
      env: definedEnvironment(environment),
      allowNonZero: true,
    });
    const output = `${result.stdout}\n${result.stderr}`
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find(Boolean);
    if (result.exitCode !== 0 || !output) {
      return {
        name: definition.name,
        status: "fail",
        path,
        message: `${definition.name} version probe exited with status ${result.exitCode}`,
      };
    }
    const version = redactText(output).slice(0, 240);
    if (definition.capability) {
      const capability = await runProcess(path, definition.capability.args, {
        timeoutMs: 5_000,
        env: definedEnvironment(environment),
        allowNonZero: true,
      });
      const capabilityOutput = `${capability.stdout}\n${capability.stderr}`;
      if (
        capability.exitCode !== 0 ||
        !capabilityOutput.includes(definition.capability.requiredText)
      ) {
        return {
          name: definition.name,
          status: "fail",
          path,
          version,
          message: definition.capability.failureMessage,
        };
      }
    }
    return {
      name: definition.name,
      status: "pass",
      path,
      version,
      message: "Dependency is available",
    };
  } catch (error) {
    return {
      name: definition.name,
      status: "fail",
      path,
      message: safeError(error),
    };
  }
}

async function inspectPath(name: keyof TermLoomPaths, path: string): Promise<DoctorPathResult> {
  try {
    const metadata = await stat(path);
    const kind = metadata.isFile() ? "file" : metadata.isDirectory() ? "directory" : "other";
    const expectedFile = name === "configFile" || name === "stateFile";
    const typeValid = expectedFile ? metadata.isFile() : metadata.isDirectory();
    return {
      name,
      path,
      status: typeValid ? "pass" : "fail",
      exists: true,
      kind,
      mode: modeString(metadata.mode),
      message: typeValid ? `${kind} exists` : `Expected ${expectedFile ? "file" : "directory"}`,
    };
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) {
      return { name, path, status: "fail", exists: false, message: safeError(error) };
    }
    const ancestor = await nearestExistingAncestor(dirname(path));
    if (!ancestor) {
      return { name, path, status: "fail", exists: false, message: "No writable ancestor exists" };
    }
    try {
      await access(ancestor, constants.W_OK);
      return {
        name,
        path,
        status: "pass",
        exists: false,
        message: `Absent; can be created under ${ancestor}`,
      };
    } catch {
      return {
        name,
        path,
        status: "fail",
        exists: false,
        message: `Absent and nearest ancestor is not writable: ${ancestor}`,
      };
    }
  }
}

async function inspectHosts(
  config: TermLoomConfig,
  sshDependency: DoctorDependencyResult | undefined,
  environment: Readonly<Record<string, string | undefined>>,
): Promise<DoctorCheck[]> {
  if (config.hosts.length === 0) return [];
  if (sshDependency?.status !== "pass" || !sshDependency.path) {
    return config.hosts.map((host) => ({
      id: `ssh-host:${host.id}`,
      status: "fail",
      message: "OpenSSH is unavailable; alias was not resolved",
    }));
  }
  return Promise.all(
    config.hosts.map(async (host): Promise<DoctorCheck> => {
      try {
        const result = await runProcess(
          sshDependency.path as string,
          ["-G", "-T", "--", host.alias],
          { timeoutMs: 5_000, env: definedEnvironment(environment) },
        );
        parseEffectiveSshConfig(host.alias, result.stdout);
        return {
          id: `ssh-host:${host.id}`,
          status: "pass",
          message: "OpenSSH effective configuration resolves",
        };
      } catch (error) {
        return { id: `ssh-host:${host.id}`, status: "fail", message: safeError(error) };
      }
    }),
  );
}

async function inspectTerminal(options: {
  environment: Readonly<Record<string, string | undefined>>;
  configuredAdapter: TermLoomConfig["media"]["adapter"];
  injectedCapabilities: TerminalCapabilities | null | undefined;
  shouldProbe: boolean;
  stdinIsTty: boolean;
  stdoutIsTty: boolean;
}): Promise<DoctorReport["terminal"]> {
  let capabilities = options.injectedCapabilities;
  let source: DoctorReport["terminal"]["capabilitySource"] =
    capabilities !== undefined ? "injected" : "environment-only";
  let probeError: string | undefined;
  if (capabilities === undefined && options.shouldProbe) {
    source = "opentui";
    try {
      capabilities = await probeOpenTuiCapabilities();
    } catch (error) {
      capabilities = null;
      probeError = safeError(error);
    }
  }
  capabilities ??= null;
  try {
    const adapter = selectMediaAdapter(
      options.configuredAdapter,
      {
        TERM: envValue(options.environment, "TERM"),
        TERM_PROGRAM: envValue(options.environment, "TERM_PROGRAM"),
        COLORTERM: envValue(options.environment, "COLORTERM"),
        TMUX: envValue(options.environment, "TMUX"),
      },
      capabilities,
    );
    const probed = source !== "environment-only" && capabilities !== null;
    return {
      status: probeError ? "warn" : probed || !options.shouldProbe ? "pass" : "warn",
      identity: adapter.terminal,
      environment: terminalEnvironment(options.environment),
      tty: { stdin: options.stdinIsTty, stdout: options.stdoutIsTty },
      capabilitySource: source,
      capabilities,
      adapter,
      message: probeError
        ? `OpenTUI capability probe failed; environment selection used: ${probeError}`
        : probed
          ? "OpenTUI terminal capabilities were probed"
          : "Non-interactive stream; terminal identity and adapter are environment-derived",
    };
  } catch (error) {
    return {
      status: "fail",
      identity: "generic",
      environment: terminalEnvironment(options.environment),
      tty: { stdin: options.stdinIsTty, stdout: options.stdoutIsTty },
      capabilitySource: source,
      capabilities,
      message: safeError(error),
    };
  }
}

async function probeOpenTuiCapabilities(): Promise<TerminalCapabilities | null> {
  const { createCliRenderer } = await import("@opentui/core");
  const renderer = await createCliRenderer({
    screenMode: "alternate-screen",
    clearOnShutdown: true,
    exitOnCtrlC: false,
    useMouse: false,
    useKittyKeyboard: null,
    consoleMode: "disabled",
    targetFps: 1,
  });
  try {
    return waitForTerminalCapabilities(renderer);
  } finally {
    renderer.destroy();
  }
}

async function inspectSecurity(paths: TermLoomPaths): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  for (const [id, path] of [
    ["config-permissions", paths.configFile],
    ["state-permissions", paths.stateFile],
  ] as const) {
    checks.push(await inspectPermissions(id, path));
  }
  checks.push(await inspectDirectoryPermissions("cache-permissions", paths.cacheDirectory));
  checks.push(await inspectDirectoryPermissions("control-permissions", paths.controlDirectory));
  checks.push(await inspectSensitiveContent(paths));
  checks.push({
    id: "diagnostic-redaction",
    status: "pass",
    message: "Doctor errors and dependency output pass through credential redaction",
  });
  return checks;
}

async function inspectPermissions(id: string, path: string): Promise<DoctorCheck> {
  try {
    const metadata = await stat(path);
    const exposedWrite = metadata.mode & 0o022;
    const exposedRead = metadata.mode & 0o044;
    if (exposedWrite) {
      return {
        id,
        status: "fail",
        message: `${path} is group/world writable (${modeString(metadata.mode)})`,
      };
    }
    if (exposedRead) {
      return {
        id,
        status: "warn",
        message: `${path} is group/world readable (${modeString(metadata.mode)})`,
      };
    }
    return { id, status: "pass", message: `${path} is user-only (${modeString(metadata.mode)})` };
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return { id, status: "pass", message: `${path} is absent` };
    return { id, status: "fail", message: safeError(error) };
  }
}

async function inspectDirectoryPermissions(id: string, path: string): Promise<DoctorCheck> {
  try {
    const metadata = await stat(path);
    if (!metadata.isDirectory())
      return { id, status: "fail", message: `${path} is not a directory` };
    if (metadata.mode & 0o022) {
      return {
        id,
        status: "fail",
        message: `${path} is group/world writable (${modeString(metadata.mode)})`,
      };
    }
    return { id, status: "pass", message: `${path} is not writable by other users` };
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return { id, status: "pass", message: `${path} is absent` };
    return { id, status: "fail", message: safeError(error) };
  }
}

async function inspectSensitiveContent(paths: TermLoomPaths): Promise<DoctorCheck> {
  const files = [paths.configFile, paths.stateFile, ...(await logFiles(paths.logDirectory))];
  const flagged: string[] = [];
  for (const path of files) {
    try {
      const metadata = await stat(path);
      if (!metadata.isFile() || metadata.size > 2_097_152) continue;
      const content = await readFile(path, "utf8");
      if (containsPotentialSecret(content)) flagged.push(path);
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) {
        return { id: "sensitive-content", status: "fail", message: safeError(error) };
      }
    }
  }
  return flagged.length
    ? {
        id: "sensitive-content",
        status: "fail",
        message: `Potential credential material detected in: ${flagged.join(", ")}`,
      }
    : {
        id: "sensitive-content",
        status: "pass",
        message: "No credential-like content detected in config, state, or small log files",
      };
}

async function logFiles(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .slice(0, 100)
      .map((entry) => join(directory, entry.name));
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return [];
    throw error;
  }
}

function containsPotentialSecret(content: string): boolean {
  return (
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/u.test(content) ||
    /(?:password|passphrase|token|authorization|api[_-]?key|access[_-]?token|secret)\s*[:=]\s*["']?[^\s"']+/iu.test(
      content,
    ) ||
    /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/u.test(content)
  );
}

async function findExecutable(
  name: string,
  pathValue: string | undefined,
): Promise<string | undefined> {
  for (const directory of (pathValue ?? "").split(delimiter).filter(Boolean)) {
    const candidate = join(directory, name);
    try {
      const metadata = await stat(candidate);
      if (!metadata.isFile()) continue;
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  return undefined;
}

async function nearestExistingAncestor(path: string): Promise<string | undefined> {
  let current = path;
  while (true) {
    try {
      const metadata = await stat(current);
      return metadata.isDirectory() ? current : undefined;
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) return undefined;
      const parent = dirname(current);
      if (parent === current) return undefined;
      current = parent;
    }
  }
}

function terminalEnvironment(environment: Readonly<Record<string, string | undefined>>) {
  const term = envValue(environment, "TERM");
  const termProgram = envValue(environment, "TERM_PROGRAM");
  const colorTerm = envValue(environment, "COLORTERM");
  return {
    ...(term ? { TERM: term } : {}),
    ...(termProgram ? { TERM_PROGRAM: termProgram } : {}),
    ...(colorTerm ? { COLORTERM: colorTerm } : {}),
    multiplexed: Boolean(envValue(environment, "TMUX")),
  };
}

function envValue(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  return environment[name];
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

function modeString(mode: number): string {
  return `0${(mode & 0o777).toString(8).padStart(3, "0")}`;
}

function statusLabel(status: DoctorStatus): string {
  if (status === "pass") return "[PASS]";
  if (status === "warn") return "[WARN]";
  if (status === "fail") return "[FAIL]";
  return "[SKIP]";
}

function safeError(error: unknown): string {
  return redactText(errorMessage(error)).slice(0, 2_048);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return false;
    throw error;
  }
}
