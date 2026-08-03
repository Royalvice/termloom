import { EventEmitter } from "node:events";
import { reduceWorkspace, type WorkspaceAction } from "./reducer.js";
import type { WorkspaceSnapshot } from "./schema.js";

export interface WorkspacePersistence {
  save(snapshot: WorkspaceSnapshot): Promise<void>;
}

export interface WorkspacePersistenceError {
  error: unknown;
  revision: number;
}

export interface WorkspacePersistenceRecovered {
  revision: number;
}

export interface WorkspaceControllerOptions {
  saveDebounceMs?: number;
}

/** Debounced, revision-aware workspace persistence with one save worker and recoverable errors. */
export class WorkspaceController extends EventEmitter {
  private readonly saveDebounceMs: number;
  private revision = 0;
  private persistedRevision = 0;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private saveWorker: Promise<void> | undefined;
  private lastPersistenceError: WorkspacePersistenceError | undefined;

  public constructor(
    private snapshot: WorkspaceSnapshot,
    private readonly store: WorkspacePersistence,
    options: WorkspaceControllerOptions = {},
  ) {
    super();
    this.saveDebounceMs = options.saveDebounceMs ?? 200;
    if (!Number.isFinite(this.saveDebounceMs) || this.saveDebounceMs < 0) {
      throw new Error("Workspace save debounce must be non-negative");
    }
  }

  public get state(): WorkspaceSnapshot {
    return this.snapshot;
  }

  public get hasUnsavedChanges(): boolean {
    return this.persistedRevision < this.revision;
  }

  public get persistenceError(): WorkspacePersistenceError | undefined {
    return this.lastPersistenceError;
  }

  public dispatch(action: WorkspaceAction): WorkspaceSnapshot {
    const next = reduceWorkspace(this.snapshot, action);
    if (next === this.snapshot) return this.snapshot;
    this.snapshot = next;
    this.revision += 1;
    this.emit("change", this.snapshot, action);
    this.scheduleSave();
    return this.snapshot;
  }

  public onChange(
    listener: (state: WorkspaceSnapshot, action: WorkspaceAction) => void,
  ): () => void {
    this.on("change", listener);
    return () => this.off("change", listener);
  }

  public onPersistenceError(listener: (event: WorkspacePersistenceError) => void): () => void {
    this.on("persistence-error", listener);
    return () => this.off("persistence-error", listener);
  }

  public onPersistenceRecovered(
    listener: (event: WorkspacePersistenceRecovered) => void,
  ): () => void {
    this.on("persistence-recovered", listener);
    return () => this.off("persistence-recovered", listener);
  }

  public async retry(): Promise<void> {
    await this.flush();
  }

  public async flush(): Promise<void> {
    this.clearSaveTimer();
    if (!this.hasUnsavedChanges) {
      if (this.saveWorker) await this.saveWorker;
      return;
    }
    this.startSaveWorker();
    await this.saveWorker;
    if (this.hasUnsavedChanges) {
      throw (
        this.lastPersistenceError?.error ??
        new Error("Workspace save did not persist latest revision")
      );
    }
  }

  private scheduleSave(): void {
    this.clearSaveTimer();
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.startSaveWorker();
    }, this.saveDebounceMs);
    this.saveTimer.unref?.();
  }

  private clearSaveTimer(): void {
    if (!this.saveTimer) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
  }

  private startSaveWorker(): void {
    if (this.saveWorker || !this.hasUnsavedChanges) return;
    this.saveWorker = this.runSaveWorker().finally(() => {
      this.saveWorker = undefined;
      if (this.hasUnsavedChanges && !this.lastPersistenceError && !this.saveTimer) {
        this.scheduleSave();
      }
    });
  }

  private async runSaveWorker(): Promise<void> {
    while (this.persistedRevision < this.revision) {
      const revision = this.revision;
      const snapshot = this.snapshot;
      try {
        await this.store.save(snapshot);
        this.persistedRevision = revision;
        if (this.lastPersistenceError) {
          this.lastPersistenceError = undefined;
          this.emit("persistence-recovered", { revision });
        }
      } catch (error) {
        const event = { error, revision } satisfies WorkspacePersistenceError;
        this.lastPersistenceError = event;
        this.emit("persistence-error", event);
        return;
      }
    }
  }
}
