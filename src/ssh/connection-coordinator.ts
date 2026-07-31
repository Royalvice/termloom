import { TermLoomError } from "../core/errors.js";
import type { TerminalExit } from "../terminal/backend.js";
import type { PtyBackend } from "../terminal/pty-backend.js";
import type { SshClient } from "./client.js";
import type { HostCatalog, HostConnectionStatus } from "./host-catalog.js";

export interface HostConnectionEvent {
  hostId: string;
  status: HostConnectionStatus;
  authenticationBackend?: PtyBackend;
  error?: string;
}

export type HostConnectionListener = (event: HostConnectionEvent) => void;

interface ConnectionAttempt {
  promise: Promise<void>;
  backend?: PtyBackend;
  cancelled?: boolean;
  abortController: AbortController;
}

// `ssh -f` can report success before the background process publishes ControlPath. Keep this
// bounded, but allow enough time for a loaded host instead of converting success into auth error.
const MASTER_READY_TIMEOUT_MS = 5_000;
const MASTER_READY_POLL_INTERVAL_MS = 50;

export class HostConnectionCoordinator {
  private readonly attempts = new Map<string, ConnectionAttempt>();
  private readonly listeners = new Set<HostConnectionListener>();
  private readonly statuses = new Map<string, HostConnectionStatus>();

  public constructor(
    private readonly ssh: SshClient,
    private readonly catalog?: HostCatalog,
  ) {}

  public onChange(listener: HostConnectionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public ensureConnected(hostId: string): Promise<void> {
    const existing = this.attempts.get(hostId);
    if (existing) return existing.promise;
    const attempt: ConnectionAttempt = {
      promise: Promise.resolve(),
      abortController: new AbortController(),
    };
    attempt.promise = this.connect(hostId, attempt).finally(() => {
      if (this.attempts.get(hostId) === attempt) this.attempts.delete(hostId);
    });
    this.attempts.set(hostId, attempt);
    return attempt.promise;
  }

  public async isConnected(hostId: string): Promise<boolean> {
    return this.ssh.checkMaster(hostId);
  }

  public cancel(hostId: string): void {
    const attempt = this.attempts.get(hostId);
    if (!attempt) return;
    attempt.cancelled = true;
    attempt.abortController.abort();
    attempt.backend?.kill("SIGTERM");
  }

  public async reconnect(hostId: string): Promise<void> {
    this.cancel(hostId);
    const active = this.attempts.get(hostId);
    if (active) await active.promise.catch(() => undefined);
    this.transition(hostId, "reconnecting");
    return this.ensureConnected(hostId);
  }

  private async connect(hostId: string, attempt: ConnectionAttempt): Promise<void> {
    let masterExitCode: number | undefined;
    let masterReady: boolean | undefined;
    const wasConnected = this.statuses.get(hostId) === "connected";
    if (!wasConnected) this.transition(hostId, "resolving");
    try {
      await this.ssh.resolveHost(hostId, attempt.abortController.signal);
      if (await this.ssh.checkMaster(hostId)) {
        if (wasConnected) return;
        this.transition(hostId, "connected");
        return;
      }
      if (wasConnected) this.transition(hostId, "reconnecting");
      const backend = this.ssh.spawnMaster(hostId);
      attempt.backend = backend;
      const exitPromise = waitForExit(backend);
      this.transition(hostId, "authenticating", { authenticationBackend: backend });
      const exit = await exitPromise;
      masterExitCode = exit.exitCode;
      attempt.backend = undefined;
      if (attempt.cancelled) throw connectionCancelled(hostId);
      if (exit.exitCode === 0) {
        masterReady = await waitForMasterReady(
          () => this.ssh.checkMaster(hostId),
          attempt.abortController.signal,
        );
      }
      if (masterReady) {
        this.transition(hostId, "connected");
        return;
      }
      throw authenticationFailed(hostId, { masterExitCode, masterReady });
    } catch (error) {
      const safeError = attempt.cancelled
        ? connectionCancelled(hostId)
        : error instanceof TermLoomError && error.code === "PROCESS_CANCELLED"
          ? error
          : error instanceof TermLoomError && error.code === "SSH_CONFIG_INVALID"
            ? error
            : authenticationFailed(hostId, { masterExitCode, masterReady });
      this.transition(hostId, "error", { error: safeError.message });
      throw safeError;
    }
  }

  private transition(
    hostId: string,
    status: HostConnectionStatus,
    details: Pick<HostConnectionEvent, "authenticationBackend" | "error"> = {},
  ): void {
    this.statuses.set(hostId, status);
    this.catalog?.updateRuntimeState(hostId, {
      connectionStatus: status,
      resolutionStatus:
        status === "resolving"
          ? "resolving"
          : status === "error"
            ? "error"
            : status === "idle"
              ? "idle"
              : "resolved",
      ...(details.error ? { error: details.error } : { error: undefined }),
    });
    const event = { hostId, status, ...details } satisfies HostConnectionEvent;
    for (const listener of this.listeners) listener(event);
  }
}

async function waitForMasterReady(
  check: () => Promise<boolean>,
  signal: AbortSignal,
): Promise<boolean> {
  const deadline = Date.now() + MASTER_READY_TIMEOUT_MS;
  while (!signal.aborted) {
    if (await check()) return true;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await waitForProbe(Math.min(MASTER_READY_POLL_INTERVAL_MS, remaining), signal);
  }
  return false;
}

function waitForProbe(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
  });
}

function waitForExit(backend: PtyBackend): Promise<TerminalExit> {
  return new Promise((resolve) => {
    const subscription = backend.onExit((event) => {
      subscription.dispose();
      resolve(event);
    });
  });
}

function authenticationFailed(
  hostId: string,
  diagnostics: { masterExitCode?: number; masterReady?: boolean } = {},
): TermLoomError {
  return new TermLoomError({
    code: "PROCESS_FAILED",
    message: `SSH authentication failed for ${hostId}`,
    hint: "Retry the connection and complete the SSH prompt in TermLoom.",
    details: { hostId, ...diagnostics },
  });
}

function connectionCancelled(hostId: string): TermLoomError {
  return new TermLoomError({
    code: "PROCESS_CANCELLED",
    message: `SSH connection was cancelled for ${hostId}`,
    details: { hostId },
  });
}
