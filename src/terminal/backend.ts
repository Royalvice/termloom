export interface Disposable {
  dispose(): void;
}

export interface TerminalExit {
  exitCode: number;
  signal?: number | string;
}

export interface TerminalBackend {
  readonly pid: number | null;
  readonly cols: number;
  readonly rows: number;
  readonly closed: boolean;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(listener: (data: string) => void): Disposable;
  onExit(listener: (event: TerminalExit) => void): Disposable;
}

export class MemoryTerminalBackend implements TerminalBackend {
  public readonly pid = null;
  public cols: number;
  public rows: number;
  public closed = false;
  public readonly writes: string[] = [];
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: TerminalExit) => void>();

  public constructor(cols = 80, rows = 24) {
    this.cols = cols;
    this.rows = rows;
  }

  public write(data: string): void {
    if (this.closed) {
      throw new Error("Cannot write to a closed terminal backend");
    }
    this.writes.push(data);
  }

  public resize(cols: number, rows: number): void {
    this.cols = Math.max(1, Math.floor(cols));
    this.rows = Math.max(1, Math.floor(rows));
  }

  public kill(): void {
    if (this.closed) return;
    this.closed = true;
    for (const listener of this.exitListeners) {
      listener({ exitCode: 0 });
    }
  }

  public onData(listener: (data: string) => void): Disposable {
    this.dataListeners.add(listener);
    return { dispose: () => this.dataListeners.delete(listener) };
  }

  public onExit(listener: (event: TerminalExit) => void): Disposable {
    this.exitListeners.add(listener);
    return { dispose: () => this.exitListeners.delete(listener) };
  }

  public emitData(data: string): void {
    for (const listener of this.dataListeners) {
      listener(data);
    }
  }

  public get written(): string {
    return this.writes.join("");
  }
}
