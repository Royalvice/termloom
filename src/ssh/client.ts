import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { HostConfig, TermLoomConfig } from "../config/schema.js";
import { TermLoomError } from "../core/errors.js";
import { type ProcessResult, runProcess } from "../process/process-runner.js";
import { PtyBackend } from "../terminal/pty-backend.js";
import { type EffectiveSshConfig, OpenSshResolver } from "./resolver.js";

export interface ResolvedSshHost {
  configured: HostConfig;
  effective: EffectiveSshConfig;
  controlPath: string;
}

export interface SshClientOptions {
  resolver?: OpenSshResolver;
  controlDirectory: string;
}

export interface SshHostIdentity {
  id: string;
  alias: string;
  label?: string;
  defaultPath: string;
  defaultTmuxSession?: string;
  source?: "ssh-config" | "manual" | "discovered" | "missing";
}

export class SshClient {
  private readonly hosts = new Map<string, ResolvedSshHost>();
  private readonly configuredHosts = new Map<string, HostConfig>();
  private readonly resolutions = new Map<string, Promise<ResolvedSshHost>>();

  private constructor(
    private readonly config: TermLoomConfig,
    private readonly resolver: OpenSshResolver,
    private readonly controlDirectory: string,
  ) {}

  public static async create(
    config: TermLoomConfig,
    options: SshClientOptions,
  ): Promise<SshClient> {
    const resolver = options.resolver ?? new OpenSshResolver({ timeoutMs: 10_000 });
    const client = new SshClient(config, resolver, options.controlDirectory);
    await mkdir(options.controlDirectory, { recursive: true, mode: 0o700 });
    client.syncHosts(config.hosts);
    return client;
  }

  public syncHosts(hosts: readonly SshHostIdentity[]): void {
    const next = new Map<string, HostConfig>();
    for (const host of hosts) {
      if (host.source === "missing") continue;
      if (next.has(host.id)) {
        throw new TermLoomError({
          code: "SSH_CONFIG_INVALID",
          message: `Duplicate SSH host id: ${host.id}`,
          details: { hostId: host.id },
        });
      }
      next.set(host.id, {
        id: host.id,
        alias: host.alias,
        ...(host.label ? { label: host.label } : {}),
        defaultPath: host.defaultPath,
        ...(host.defaultTmuxSession ? { defaultTmuxSession: host.defaultTmuxSession } : {}),
      });
    }
    for (const [hostId, configured] of this.configuredHosts) {
      const replacement = next.get(hostId);
      if (!replacement || replacement.alias !== configured.alias) {
        this.hosts.delete(hostId);
        this.resolutions.delete(hostId);
      }
    }
    this.configuredHosts.clear();
    for (const [hostId, configured] of next) this.configuredHosts.set(hostId, configured);
  }

  public updateConfig(config: TermLoomConfig): void {
    this.config.ssh = structuredClone(config.ssh);
  }

  public async resolveHost(hostId: string, signal?: AbortSignal): Promise<ResolvedSshHost> {
    const existing = this.hosts.get(hostId);
    if (existing) return existing;
    const inFlight = this.resolutions.get(hostId);
    if (inFlight) return inFlight;
    const configured = this.configuredHost(hostId);
    const resolution = this.resolver
      .resolve(configured.alias, { signal })
      .then((effective) => {
        const resolved = {
          configured,
          effective,
          controlPath: createControlPath(this.controlDirectory, configured, effective),
        } satisfies ResolvedSshHost;
        this.hosts.set(hostId, resolved);
        return resolved;
      })
      .finally(() => this.resolutions.delete(hostId));
    this.resolutions.set(hostId, resolution);
    return resolution;
  }

  public list(): readonly ResolvedSshHost[] {
    return [...this.hosts.values()];
  }

  public hasHost(hostId: string): boolean {
    return this.configuredHosts.has(hostId);
  }

  public host(hostId: string): ResolvedSshHost {
    this.configuredHost(hostId);
    const host = this.hosts.get(hostId);
    if (!host) {
      throw new TermLoomError({
        code: "SSH_CONFIG_INVALID",
        message: `SSH host has not been resolved yet: ${hostId}`,
        hint: "Select the host and finish its SSH connection first.",
        details: { hostId },
      });
    }
    return host;
  }

  public spawnMaster(hostId: string, cols = 80, rows = 24): PtyBackend {
    const host = this.host(hostId);
    return PtyBackend.spawn(this.resolver.binary, this.masterArgs(host), { cols, rows });
  }

  public spawnTerminal(
    hostId: string,
    remoteArgs?: readonly string[],
    cols = 80,
    rows = 24,
  ): PtyBackend {
    const host = this.host(hostId);
    const args = [
      ...this.resolver.prefixArgs,
      ...this.connectionOptions(host, "auto"),
      "-tt",
      "--",
      host.configured.alias,
    ];
    if (remoteArgs && remoteArgs.length > 0) args.push(remoteCommand(remoteArgs));
    return PtyBackend.spawn(this.resolver.binary, args, { cols, rows });
  }

  public async checkMaster(hostId: string): Promise<boolean> {
    const host = await this.resolveHost(hostId);
    const result = await runProcess(
      this.resolver.binary,
      [
        ...this.resolver.prefixArgs,
        "-o",
        `ControlPath=${host.controlPath}`,
        "-O",
        "check",
        "--",
        host.configured.alias,
      ],
      { timeoutMs: 5_000, allowNonZero: true },
    );
    return result.exitCode === 0;
  }

  public async stopMaster(hostId: string): Promise<boolean> {
    const host = await this.resolveHost(hostId);
    const result = await runProcess(
      this.resolver.binary,
      [
        ...this.resolver.prefixArgs,
        "-o",
        `ControlPath=${host.controlPath}`,
        "-O",
        "exit",
        "--",
        host.configured.alias,
      ],
      { timeoutMs: 5_000, allowNonZero: true },
    );
    return result.exitCode === 0;
  }

  public async run(
    hostId: string,
    remoteArgs: readonly string[],
    options: { timeoutMs?: number; signal?: AbortSignal; allowNonZero?: boolean } = {},
  ): Promise<ProcessResult> {
    if (remoteArgs.length === 0) {
      throw new TermLoomError({
        code: "PROCESS_FAILED",
        message: "Remote command must not be empty",
        details: { hostId },
      });
    }
    const host = await this.resolveHost(hostId, options.signal);
    if (!(await this.checkResolvedMaster(host))) {
      throw new TermLoomError({
        code: "PROCESS_FAILED",
        message: `No authenticated OpenSSH ControlMaster for ${hostId}`,
        hint: "Select the host and finish authentication before running remote commands.",
        details: { hostId },
      });
    }
    return runProcess(
      this.resolver.binary,
      [
        ...this.resolver.prefixArgs,
        ...this.connectionOptions(host, "auto"),
        "-T",
        "--",
        host.configured.alias,
        remoteCommand(remoteArgs),
      ],
      {
        timeoutMs: options.timeoutMs ?? this.config.ssh.connectTimeoutSeconds * 1_000,
        signal: options.signal,
        allowNonZero: options.allowNonZero,
      },
    );
  }

  public externalCommand(hostId: string): string {
    const host = this.host(hostId);
    const args = [
      this.resolver.binary,
      ...this.resolver.prefixArgs,
      ...this.connectionOptions(host, "auto"),
      host.configured.alias,
    ];
    return args.map(quoteSpaceSeparatedArgument).join(" ");
  }

  private masterArgs(host: ResolvedSshHost): string[] {
    return [
      ...this.resolver.prefixArgs,
      "-M",
      "-N",
      "-f",
      ...this.connectionOptions(host, "yes"),
      "--",
      host.configured.alias,
    ];
  }

  private connectionOptions(host: ResolvedSshHost, master: "auto" | "yes"): string[] {
    return [
      "-o",
      `ControlMaster=${master}`,
      "-o",
      `ControlPersist=${this.config.ssh.controlPersistSeconds}`,
      "-o",
      `ControlPath=${host.controlPath}`,
      "-o",
      `ConnectTimeout=${this.config.ssh.connectTimeoutSeconds}`,
      "-o",
      `ServerAliveInterval=${this.config.ssh.serverAliveInterval}`,
      "-o",
      `ServerAliveCountMax=${this.config.ssh.serverAliveCountMax}`,
    ];
  }

  private configuredHost(hostId: string): HostConfig {
    const configured = this.configuredHosts.get(hostId);
    if (!configured) {
      throw new TermLoomError({
        code: "SSH_HOST_UNKNOWN",
        message: `Unknown SSH host: ${hostId}`,
        details: { hostId },
      });
    }
    return configured;
  }

  private async checkResolvedMaster(host: ResolvedSshHost): Promise<boolean> {
    const result = await runProcess(
      this.resolver.binary,
      [
        ...this.resolver.prefixArgs,
        "-o",
        `ControlPath=${host.controlPath}`,
        "-O",
        "check",
        "--",
        host.configured.alias,
      ],
      { timeoutMs: 5_000, allowNonZero: true },
    );
    return result.exitCode === 0;
  }
}

export function createControlPath(
  directory: string,
  configured: HostConfig,
  effective: EffectiveSshConfig,
): string {
  const identity = [
    configured.id,
    configured.alias,
    effective.user,
    effective.hostName,
    effective.port,
  ].join("\0");
  const digest = createHash("sha256").update(identity).digest("hex").slice(0, 32);
  const path = join(directory, `cm-${digest}`);
  if (Buffer.byteLength(path) > 100) {
    throw new TermLoomError({
      code: "SSH_CONFIG_INVALID",
      message: `SSH control path is too long: ${path}`,
      hint: "Set XDG_CACHE_HOME to a shorter path.",
      details: { byteLength: Buffer.byteLength(path) },
    });
  }
  return path;
}

export function remoteCommand(args: readonly string[]): string {
  if (args.length === 0) throw new Error("Remote command must not be empty");
  return args.map(quotePosixArgument).join(" ");
}

function quotePosixArgument(value: string): string {
  if (value.includes("\0")) throw new Error("Remote argument contains NUL");
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function quoteSpaceSeparatedArgument(value: string): string {
  if (value.includes("\0") || /[\r\n]/.test(value)) {
    throw new Error("External SSH argument contains a control character");
  }
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}
