import { TermLoomError } from "../core/errors.js";
import { runProcess, type RunProcessOptions } from "../process/process-runner.js";

export interface EffectiveSshConfig {
  alias: string;
  hostName: string;
  user: string;
  port: number;
  identityFiles: readonly string[];
  proxyJump?: string;
  proxyCommand?: string;
  userKnownHostsFiles: readonly string[];
  strictHostKeyChecking: string;
  raw: Readonly<Record<string, readonly string[]>>;
}

export interface OpenSshResolverOptions {
  binary?: string;
  configFile?: string;
  timeoutMs?: number;
}

interface ParsedSshValues extends Record<string, string[] | undefined> {
  port?: string[];
  identityfile?: string[];
  userknownhostsfile?: string[];
  stricthostkeychecking?: string[];
}

export class OpenSshResolver {
  public readonly binary: string;
  private readonly globalArgs: readonly string[];
  private readonly timeoutMs: number;

  public constructor(options: OpenSshResolverOptions = {}) {
    const binary = options.binary ?? Bun.which("ssh");
    if (!binary) {
      throw new TermLoomError({
        code: "DEPENDENCY_MISSING",
        message: "OpenSSH client was not found",
        hint: "Install OpenSSH and ensure ssh is available on PATH.",
        details: { dependency: "ssh" },
      });
    }
    this.binary = binary;
    this.globalArgs = options.configFile ? ["-F", options.configFile] : [];
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  public get prefixArgs(): readonly string[] {
    return this.globalArgs;
  }

  public async resolve(
    alias: string,
    options: Pick<RunProcessOptions, "signal"> = {},
  ): Promise<EffectiveSshConfig> {
    validateAlias(alias);
    const result = await runProcess(this.binary, [...this.globalArgs, "-G", "-T", "--", alias], {
      timeoutMs: this.timeoutMs,
      signal: options.signal,
    });
    return parseEffectiveSshConfig(alias, result.stdout);
  }
}

export function parseEffectiveSshConfig(alias: string, output: string): EffectiveSshConfig {
  const values: ParsedSshValues = {};
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const separator = line.search(/\s/);
    if (separator < 1) continue;
    const key = line.slice(0, separator).toLowerCase();
    const value = line.slice(separator).trim();
    const entries = values[key] ?? [];
    entries.push(value);
    values[key] = entries;
  }
  const hostName = required(values, "hostname", alias);
  const user = required(values, "user", alias);
  const parsedPort = Number.parseInt(required(values, "port", alias), 10);
  if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65_535) {
    throw invalid(alias, `Invalid resolved SSH port: ${values.port?.[0] ?? "missing"}`);
  }
  return {
    alias,
    hostName,
    user,
    port: parsedPort,
    identityFiles: values.identityfile ?? [],
    proxyJump: optional(values, "proxyjump", "none"),
    proxyCommand: optional(values, "proxycommand", "none"),
    userKnownHostsFiles: splitWords(values.userknownhostsfile ?? []),
    strictHostKeyChecking: values.stricthostkeychecking?.[0] ?? "ask",
    raw: values as Readonly<Record<string, readonly string[]>>,
  };
}

function validateAlias(alias: string): void {
  if (alias.length === 0 || alias.startsWith("-") || /[\0\r\n]/.test(alias)) {
    throw invalid(alias, "SSH alias is empty or contains unsafe control characters");
  }
}

function required(values: ParsedSshValues, key: string, alias: string): string {
  const value = values[key]?.[0];
  if (!value) throw invalid(alias, `ssh -G did not return ${key}`);
  return value;
}

function optional(
  values: ParsedSshValues,
  key: string,
  absentSentinel: string,
): string | undefined {
  const value = values[key]?.[0];
  return !value || value === absentSentinel ? undefined : value;
}

function splitWords(values: readonly string[]): string[] {
  return values.flatMap((value) => value.split(/\s+/)).filter(Boolean);
}

function invalid(alias: string, message: string): TermLoomError {
  return new TermLoomError({
    code: "SSH_CONFIG_INVALID",
    message: `${message} for ${alias}`,
    hint: `Inspect the effective configuration with: ssh -G -- ${alias}`,
    details: { alias },
  });
}
