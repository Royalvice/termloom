import { mkdtemp, rm, stat } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TermLoomError, errorMessage } from "../core/errors.js";
import { redactText } from "../process/process-runner.js";

export interface MpvControllerOptions {
  binary?: string;
  audioOutput?: string;
  startupTimeoutMs?: number;
  commandTimeoutMs?: number;
}

export interface MpvPlaybackState {
  positionSeconds: number;
  durationSeconds: number;
  paused: boolean;
  volume: number;
  muted: boolean;
}

interface PendingCommand {
  resolve(value: unknown): void;
  reject(error: unknown): void;
  timeout: ReturnType<typeof setTimeout>;
}

interface MpvResponse {
  request_id?: number;
  error?: string;
  data?: unknown;
}

export class MpvController {
  public readonly launchFlags: readonly string[];
  private readonly binary: string;
  private readonly sourcePath: string;
  private readonly startupTimeoutMs: number;
  private readonly commandTimeoutMs: number;
  private readonly audioOutput: string | undefined;
  private temporaryDirectory: string | undefined;
  private socketPath: string | undefined;
  private socket: Socket | undefined;
  private subprocess: Bun.Subprocess<"ignore", "ignore", "pipe"> | undefined;
  private stderrPromise: Promise<string> | undefined;
  private pending = new Map<number, PendingCommand>();
  private nextRequestId = 1;
  private incoming = "";
  private closing = false;

  public constructor(sourcePath: string, options: MpvControllerOptions = {}) {
    const binary = options.binary ?? Bun.which("mpv");
    if (!binary) {
      throw new TermLoomError({
        code: "DEPENDENCY_MISSING",
        message: "mpv was not found",
        hint: "Install mpv and run termloom doctor again.",
        details: { dependency: "mpv" },
      });
    }
    this.binary = binary;
    this.sourcePath = sourcePath;
    this.audioOutput = options.audioOutput;
    this.startupTimeoutMs = options.startupTimeoutMs ?? 8_000;
    this.commandTimeoutMs = options.commandTimeoutMs ?? 3_000;
    this.launchFlags = [
      "--no-config",
      "--no-terminal",
      "--really-quiet",
      "--no-video",
      "--force-window=no",
      "--audio-display=no",
      "--pause=yes",
      "--keep-open=yes",
    ];
  }

  public async start(): Promise<MpvPlaybackState> {
    if (this.subprocess) return this.state();
    this.temporaryDirectory = await mkdtemp(join(tmpdir(), "termloom-mpv-"));
    this.socketPath = join(this.temporaryDirectory, "ipc.sock");
    const args = [
      ...this.launchFlags,
      `--input-ipc-server=${this.socketPath}`,
      ...(this.audioOutput ? [`--ao=${this.audioOutput}`] : []),
      "--",
      this.sourcePath,
    ];
    try {
      this.subprocess = Bun.spawn([this.binary, ...args], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
      });
    } catch (error) {
      await this.cleanupFilesystem();
      throw new TermLoomError({
        code: "PROCESS_FAILED",
        message: `Unable to start mpv: ${errorMessage(error)}`,
        cause: error,
        details: { command: this.binary, flags: this.launchFlags },
      });
    }
    this.stderrPromise = new Response(this.subprocess.stderr).text();
    void this.observeProcessExit();
    try {
      this.socket = await connectSocket(this.socketPath, this.subprocess, this.startupTimeoutMs);
      this.socket.setEncoding("utf8");
      this.socket.on("data", (chunk: string) => this.consume(chunk));
      this.socket.on("error", (error) => this.rejectPending(error));
      this.socket.on("close", () => {
        if (!this.closing) this.rejectPending(new Error("mpv IPC socket closed"));
      });
      return await this.waitForLoadedState();
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  public async state(): Promise<MpvPlaybackState> {
    const [position, duration, paused, volume, muted] = await Promise.all([
      this.getProperty("time-pos"),
      this.getProperty("duration"),
      this.getProperty("pause"),
      this.getProperty("volume"),
      this.getProperty("mute"),
    ]);
    return {
      positionSeconds: finiteNumber(position) ?? 0,
      durationSeconds: finiteNumber(duration) ?? 0,
      paused: Boolean(paused),
      volume: clamp(finiteNumber(volume) ?? 100, 0, 100),
      muted: Boolean(muted),
    };
  }

  public async position(): Promise<number> {
    return finiteNumber(await this.getProperty("time-pos")) ?? 0;
  }

  public processId(): number | undefined {
    return this.subprocess?.pid;
  }

  public isRunning(): boolean {
    return this.subprocess?.exitCode === null;
  }

  public async play(): Promise<void> {
    await this.setProperty("pause", false);
  }

  public async pause(): Promise<void> {
    await this.setProperty("pause", true);
  }

  public async seek(seconds: number): Promise<number> {
    const target = Math.max(0, seconds);
    await this.command(["seek", target, "absolute+exact"]);
    return this.position();
  }

  public async setVolume(volume: number): Promise<number> {
    const target = clamp(volume, 0, 100);
    await this.setProperty("volume", target);
    return target;
  }

  public async setMuted(muted: boolean): Promise<boolean> {
    await this.setProperty("mute", muted);
    return muted;
  }

  public async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    const subprocess = this.subprocess;
    if (this.socket && !this.socket.destroyed) {
      await this.command(["quit"]).catch(() => undefined);
      this.socket.destroy();
    }
    this.socket = undefined;
    if (subprocess) {
      const exited = await Promise.race([
        subprocess.exited.then(() => true),
        Bun.sleep(1_000).then(() => false),
      ]);
      if (!exited) {
        subprocess.kill("SIGTERM");
        await subprocess.exited.catch(() => undefined);
      }
    }
    this.subprocess = undefined;
    this.rejectPending(new Error("mpv controller closed"));
    await this.cleanupFilesystem();
  }

  private async waitForLoadedState(): Promise<MpvPlaybackState> {
    const deadline = Date.now() + this.startupTimeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        const state = await this.state();
        if (state.durationSeconds > 0) return state;
        lastError = new Error("mpv media duration is not ready");
      } catch (error) {
        lastError = error;
      }
      await Bun.sleep(20);
    }
    throw new TermLoomError({
      code: "PROCESS_TIMEOUT",
      message: `mpv did not load media within ${this.startupTimeoutMs} ms: ${errorMessage(lastError)}`,
      details: { timeoutMs: this.startupTimeoutMs },
    });
  }

  private async getProperty(name: string): Promise<unknown> {
    return this.command(["get_property", name]);
  }

  private async setProperty(name: string, value: unknown): Promise<void> {
    await this.command(["set_property", name, value]);
  }

  private command(command: readonly unknown[]): Promise<unknown> {
    const socket = this.socket;
    if (!socket || socket.destroyed) {
      return Promise.reject(
        new TermLoomError({ code: "PROCESS_FAILED", message: "mpv IPC is not connected" }),
      );
    }
    const requestId = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        reject(
          new TermLoomError({
            code: "PROCESS_TIMEOUT",
            message: `mpv IPC command timed out after ${this.commandTimeoutMs} ms`,
            details: { command: command[0], timeoutMs: this.commandTimeoutMs },
          }),
        );
      }, this.commandTimeoutMs);
      this.pending.set(requestId, { resolve, reject, timeout });
      socket.write(`${JSON.stringify({ command, request_id: requestId })}\n`, (error) => {
        if (!error) return;
        const pending = this.pending.get(requestId);
        if (!pending) return;
        clearTimeout(pending.timeout);
        this.pending.delete(requestId);
        pending.reject(error);
      });
    });
  }

  private consume(chunk: string): void {
    this.incoming += chunk;
    while (true) {
      const newline = this.incoming.indexOf("\n");
      if (newline < 0) return;
      const line = this.incoming.slice(0, newline).trim();
      this.incoming = this.incoming.slice(newline + 1);
      if (!line) continue;
      let response: MpvResponse;
      try {
        response = JSON.parse(line) as MpvResponse;
      } catch {
        continue;
      }
      if (typeof response.request_id !== "number") continue;
      const pending = this.pending.get(response.request_id);
      if (!pending) continue;
      clearTimeout(pending.timeout);
      this.pending.delete(response.request_id);
      if (response.error && response.error !== "success") {
        pending.reject(
          new TermLoomError({
            code: "PROCESS_FAILED",
            message: `mpv IPC error: ${redactText(response.error)}`,
            details: { requestId: response.request_id },
          }),
        );
      } else {
        pending.resolve(response.data);
      }
    }
  }

  private rejectPending(error: unknown): void {
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(requestId);
    }
  }

  private async observeProcessExit(): Promise<void> {
    const subprocess = this.subprocess;
    const stderrPromise = this.stderrPromise;
    if (!subprocess || !stderrPromise) return;
    const [exitCode, stderr] = await Promise.all([subprocess.exited, stderrPromise]);
    if (this.closing || exitCode === 0) return;
    this.rejectPending(
      new TermLoomError({
        code: "PROCESS_FAILED",
        message: `mpv exited with status ${exitCode}: ${redactText(stderr.trim()).slice(-2_048)}`,
        details: { exitCode },
      }),
    );
  }

  private async cleanupFilesystem(): Promise<void> {
    const directory = this.temporaryDirectory;
    this.temporaryDirectory = undefined;
    this.socketPath = undefined;
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}

async function connectSocket(
  path: string,
  subprocess: Bun.Subprocess<"ignore", "ignore", "pipe">,
  timeoutMs: number,
): Promise<Socket> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const exitCode = subprocess.exitCode;
    if (exitCode !== null) {
      throw new TermLoomError({
        code: "PROCESS_FAILED",
        message: `mpv exited before its IPC socket became ready (status ${exitCode})`,
        details: { exitCode },
      });
    }
    try {
      await stat(path);
      return await openSocket(path);
    } catch (error) {
      lastError = error;
      await Bun.sleep(20);
    }
  }
  throw new TermLoomError({
    code: "PROCESS_TIMEOUT",
    message: `mpv IPC socket was not ready within ${timeoutMs} ms: ${errorMessage(lastError)}`,
    details: { timeoutMs },
  });
}

function openSocket(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path });
    const onError = (error: Error) => {
      socket.destroy();
      reject(error);
    };
    socket.once("error", onError);
    socket.once("connect", () => {
      socket.off("error", onError);
      resolve(socket);
    });
  });
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
