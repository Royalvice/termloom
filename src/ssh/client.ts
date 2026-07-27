import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { HostConfig, TermLoomConfig } from "../config/schema.js";
import { TermLoomError } from "../core/errors.js";
import { runProcess, type ProcessResult } from "../process/process-runner.js";
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

export class SshClient {
  private readonly hosts = new Map<string, ResolvedSshHost>();

  private constructor(
    private readonly config: TermLoomConfig,
    private readonly resolver: OpenSshResolver,
  ) {}

  public static async create(
    config: TermLoomConfig,
    options: SshClientOptions,
  ): Promise<SshClient> {
    const resolver = options.resolver ?? new OpenSshResolver({ timeoutMs: 10_000 });
    const client = new SshClient(config, resolver);
    await mkdir(options.controlDirectory, { recursive: true, mode: 0o700 });
    const resolved = await Promise.all(
      config.hosts.map(async (configured) => {
        const effective = await resolver.resolve(configured.alias);
        const controlPath = createControlPath(options.controlDirectory, configured, effective);
        return { configured, effective, controlPath } satisfies ResolvedSshHost;
      }),
    );
    for (const host of resolved) {
      if (client.hosts.has(host.configured.id)) {
        throw new TermLoomError({
          code: "SSH_CONFIG_INVALID",
          message: `Duplicate SSH host id: ${host.configured.id}`,
          details: { hostId: host.configured.id },
        });
      }
      client.hosts.set(host.configured.id, host);
    }
    return client;
  }

  public list(): readonly ResolvedSshHost[] {
    return [...this.hosts.values()];
  }

  public host(hostId: string): ResolvedSshHost {
    const host = this.hosts.get(hostId);
    if (!host) {
      throw new TermLoomError({
        code: "SSH_HOST_UNKNOWN",
        message: `Unknown SSH host: ${hostId}`,
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
    const host = this.host(hostId);
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
    const host = this.host(hostId);
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
    const host = this.host(hostId);
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
