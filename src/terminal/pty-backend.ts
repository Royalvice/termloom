import { spawn, type IDisposable, type IExitEvent, type IPty } from "bun-pty";
import type { Disposable, TerminalBackend, TerminalExit } from "./backend.js";

export interface PtySpawnOptions {
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  cols?: number;
  rows?: number;
  name?: string;
}

function cleanEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

export class PtyBackend implements TerminalBackend {
  private readonly pty: IPty;
  private exited = false;

  private constructor(pty: IPty) {
    this.pty = pty;
    this.pty.onExit(() => {
      this.exited = true;
    });
  }

  public static spawn(
    command: string,
    args: readonly string[],
    options: PtySpawnOptions = {},
  ): PtyBackend {
    const cols = Math.max(1, Math.floor(options.cols ?? 80));
    const rows = Math.max(1, Math.floor(options.rows ?? 24));
    const env = {
      ...cleanEnvironment(process.env),
      ...options.env,
      TERM: options.name ?? "xterm-256color",
      COLORTERM: "truecolor",
    };

    const pty = spawn(command, [...args], {
      name: options.name ?? "xterm-256color",
      cols,
      rows,
      cwd: options.cwd ?? process.cwd(),
      env,
    });
    return new PtyBackend(pty);
  }

  public get pid(): number {
    return this.pty.pid;
  }

  public get cols(): number {
    return this.pty.cols;
  }

  public get rows(): number {
    return this.pty.rows;
  }

  public get closed(): boolean {
    return this.exited;
  }

  public write(data: string): void {
    if (this.exited) throw new Error("Cannot write to an exited PTY");
    this.pty.write(data);
  }

  public resize(cols: number, rows: number): void {
    if (this.exited) return;
    this.pty.resize(Math.max(1, Math.floor(cols)), Math.max(1, Math.floor(rows)));
  }

  public kill(signal?: string): void {
    if (this.exited) return;
    this.pty.kill(signal);
  }

  public onData(listener: (data: string) => void): Disposable {
    return adaptDisposable(this.pty.onData(listener));
  }

  public onExit(listener: (event: TerminalExit) => void): Disposable {
    return adaptDisposable(
      this.pty.onExit((event: IExitEvent) => {
        this.exited = true;
        listener({ exitCode: event.exitCode, signal: event.signal });
      }),
    );
  }
}

function adaptDisposable(disposable: IDisposable): Disposable {
  return { dispose: () => disposable.dispose() };
}
