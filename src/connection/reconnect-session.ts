import type { ReconnectConfig } from "../config/schema.js";
import type { Disposable, TerminalBackend, TerminalExit } from "../terminal/backend.js";

export type ConnectionPhase =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "detached"
  | "stopped";

export interface ConnectionState {
  phase: ConnectionPhase;
  attempt: number;
  nextDelayMs?: number;
  lastExit?: TerminalExit;
}

export interface ReconnectSessionHooks {
  /** Resolves transport prerequisites before a fresh terminal backend is spawned. */
  beforeConnect?(): Promise<void>;
  onBackend(backend: TerminalBackend): void;
  onState(state: ConnectionState): void;
  onConnectError?(error: unknown): void;
}

export class ReconnectSession {
  private backend: TerminalBackend | undefined;
  private backendSubscriptions: Disposable[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private attempt = 0;
  private connectionGeneration = 0;
  private state: ConnectionState = { phase: "idle", attempt: 0 };

  public constructor(
    private readonly createBackend: () => TerminalBackend,
    private config: ReconnectConfig,
    private readonly hooks: ReconnectSessionHooks,
    private readonly random: () => number = Math.random,
  ) {
    this.config = structuredClone(config);
  }

  public get current(): ConnectionState {
    return this.state;
  }

  public start(): void {
    if (this.stopped || this.backend || this.timer) return;
    this.connect(this.attempt === 0 ? "connecting" : "reconnecting");
  }

  public reconnectNow(): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.connectionGeneration += 1;
    this.clearBackend(true);
    this.connect("reconnecting");
  }

  public updateConfig(config: ReconnectConfig): void {
    const wasEnabled = this.config.enabled;
    this.config = structuredClone(config);
    if (!config.enabled && this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
      this.transition({
        phase: "detached",
        attempt: this.attempt,
        ...(this.state.lastExit ? { lastExit: this.state.lastExit } : {}),
      });
      return;
    }
    if (config.enabled && this.timer && this.state.lastExit) {
      clearTimeout(this.timer);
      this.timer = undefined;
      this.scheduleReconnect(this.state.lastExit, false);
      return;
    }
    if (
      config.enabled &&
      !wasEnabled &&
      this.state.phase === "detached" &&
      this.state.lastExit?.exitCode !== 0
    ) {
      this.reconnectNow();
    }
  }

  public stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.connectionGeneration += 1;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.clearBackend(true);
    this.transition({ phase: "stopped", attempt: this.attempt });
  }

  private connect(phase: "connecting" | "reconnecting"): void {
    const generation = ++this.connectionGeneration;
    this.transition({ phase, attempt: this.attempt });
    const startBackend = () => {
      if (this.stopped || generation !== this.connectionGeneration) return;
      let backend: TerminalBackend;
      try {
        backend = this.createBackend();
      } catch (error) {
        this.hooks.onConnectError?.(error);
        this.scheduleReconnect({ exitCode: 255 });
        return;
      }
      if (this.stopped || generation !== this.connectionGeneration) {
        backend.kill();
        return;
      }
      this.backend = backend;
      let sawData = false;
      this.backendSubscriptions = [
        backend.onData(() => {
          if (sawData || this.stopped || generation !== this.connectionGeneration) return;
          sawData = true;
          this.attempt = 0;
          this.transition({ phase: "connected", attempt: 0 });
        }),
        backend.onExit((event) => {
          if (generation !== this.connectionGeneration) return;
          this.clearBackend(false);
          if (this.stopped) return;
          if (event.exitCode === 0) {
            this.transition({ phase: "detached", attempt: 0, lastExit: event });
            return;
          }
          this.scheduleReconnect(event);
        }),
      ];
      this.hooks.onBackend(backend);
    };

    if (!this.hooks.beforeConnect) {
      startBackend();
      return;
    }
    void this.hooks.beforeConnect().then(
      () => startBackend(),
      (error) => {
        if (this.stopped || generation !== this.connectionGeneration) return;
        this.hooks.onConnectError?.(error);
        this.scheduleReconnect({ exitCode: 255 });
      },
    );
  }

  private scheduleReconnect(lastExit: TerminalExit, incrementAttempt = true): void {
    if (!this.config.enabled || this.stopped) {
      this.transition({ phase: "detached", attempt: this.attempt, lastExit });
      return;
    }
    if (incrementAttempt) this.attempt += 1;
    const base = Math.min(
      this.config.maxDelayMs,
      this.config.initialDelayMs * this.config.multiplier ** Math.max(0, this.attempt - 1),
    );
    const spread = base * this.config.jitter;
    const nextDelayMs = Math.max(0, Math.round(base - spread + this.random() * spread * 2));
    this.transition({ phase: "reconnecting", attempt: this.attempt, nextDelayMs, lastExit });
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.connect("reconnecting");
    }, nextDelayMs);
  }

  private clearBackend(kill: boolean): void {
    for (const subscription of this.backendSubscriptions.splice(0)) subscription.dispose();
    if (kill) this.backend?.kill();
    this.backend = undefined;
  }

  private transition(state: ConnectionState): void {
    this.state = state;
    this.hooks.onState(state);
  }
}
