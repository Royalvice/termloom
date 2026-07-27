import { TermLoomError } from "../core/errors.js";
import type { SshClient } from "../ssh/client.js";
import type { PtyBackend } from "../terminal/pty-backend.js";

export interface TmuxSessionInfo {
  name: string;
  attachedClients: number;
  windows: number;
  createdAt: Date;
}

export interface TmuxServiceOptions {
  socketName?: string;
}

export class TmuxService {
  private readonly prefix: readonly string[];

  public constructor(
    private readonly ssh: SshClient,
    options: TmuxServiceOptions = {},
  ) {
    this.prefix = options.socketName
      ? ["tmux", "-L", validateSocketName(options.socketName)]
      : ["tmux"];
  }

  public async version(hostId: string): Promise<string> {
    const result = await this.ssh.run(hostId, [...this.prefix, "-V"]);
    return result.stdout.trim();
  }

  public async list(hostId: string): Promise<readonly TmuxSessionInfo[]> {
    const result = await this.ssh.run(
      hostId,
      [
        ...this.prefix,
        "list-sessions",
        "-F",
        "#{session_name}|#{session_attached}|#{session_windows}|#{session_created}",
      ],
      { allowNonZero: true },
    );
    if (result.exitCode !== 0) {
      if (isNoServer(result.stderr)) return [];
      throw tmuxFailed("list sessions", result.exitCode, result.stderr);
    }
    return result.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map(parseSessionLine)
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  public async create(hostId: string, name: string, cwd?: string): Promise<void> {
    const args = [...this.prefix, "new-session", "-d", "-s", validateSessionName(name)];
    if (cwd) args.push("-c", cwd);
    await this.ssh.run(hostId, args);
  }

  public async rename(hostId: string, currentName: string, nextName: string): Promise<void> {
    await this.ssh.run(hostId, [
      ...this.prefix,
      "rename-session",
      "-t",
      exactTarget(currentName),
      validateSessionName(nextName),
    ]);
  }

  public async kill(hostId: string, name: string): Promise<void> {
    await this.ssh.run(hostId, [...this.prefix, "kill-session", "-t", exactTarget(name)]);
  }

  public async exists(hostId: string, name: string): Promise<boolean> {
    const result = await this.ssh.run(
      hostId,
      [...this.prefix, "has-session", "-t", exactTarget(name)],
      { allowNonZero: true },
    );
    return result.exitCode === 0;
  }

  public async sendKeys(hostId: string, name: string, text: string): Promise<void> {
    if (text.includes("\0")) throw new Error("tmux input contains NUL");
    const target = `${exactTarget(name)}:`;
    await this.ssh.run(hostId, [...this.prefix, "send-keys", "-t", target, "-l", text]);
    await this.ssh.run(hostId, [...this.prefix, "send-keys", "-t", target, "Enter"]);
  }

  public attachBackend(hostId: string, name: string, cwd?: string): PtyBackend {
    const args = [...this.prefix, "new-session", "-A", "-s", validateSessionName(name)];
    if (cwd) args.push("-c", cwd);
    return this.ssh.spawnTerminal(hostId, args);
  }
}

function parseSessionLine(line: string): TmuxSessionInfo {
  const fields = line.split("|");
  const created = fields.pop();
  const windows = fields.pop();
  const attached = fields.pop();
  const name = fields.join("|");
  const attachedClients = Number.parseInt(attached ?? "", 10);
  const windowCount = Number.parseInt(windows ?? "", 10);
  const createdSeconds = Number.parseInt(created ?? "", 10);
  if (
    !name ||
    !Number.isInteger(attachedClients) ||
    !Number.isInteger(windowCount) ||
    !Number.isInteger(createdSeconds)
  ) {
    throw new TermLoomError({
      code: "PROCESS_FAILED",
      message: `Unable to parse tmux session line: ${line}`,
      details: { line },
    });
  }
  return {
    name,
    attachedClients,
    windows: windowCount,
    createdAt: new Date(createdSeconds * 1_000),
  };
}

function validateSessionName(name: string): string {
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(name)) {
    throw new TermLoomError({
      code: "PROCESS_FAILED",
      message: `Invalid tmux session name: ${name}`,
      hint: "Use 1-128 letters, numbers, dots, underscores, or hyphens.",
      details: { name },
    });
  }
  return name;
}

function validateSocketName(name: string): string {
  if (!/^[A-Za-z0-9_.-]{1,80}$/.test(name)) throw new Error(`Invalid tmux socket name: ${name}`);
  return name;
}

function exactTarget(name: string): string {
  return `=${validateSessionName(name)}`;
}

function isNoServer(stderr: string): boolean {
  return /no server running|failed to connect to server|error connecting to .*tmux-|no sessions/i.test(
    stderr,
  );
}

function tmuxFailed(action: string, exitCode: number, stderr: string): TermLoomError {
  return new TermLoomError({
    code: "PROCESS_FAILED",
    message: `tmux failed to ${action}: ${stderr.trim() || `exit ${exitCode}`}`,
    details: { action, exitCode },
  });
}
