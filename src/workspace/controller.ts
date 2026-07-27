import { EventEmitter } from "node:events";
import { reduceWorkspace, type WorkspaceAction } from "./reducer.js";
import type { WorkspaceSnapshot } from "./schema.js";
export interface WorkspacePersistence {
  save(snapshot: WorkspaceSnapshot): Promise<void>;
}

export class WorkspaceController extends EventEmitter {
  private saveChain: Promise<void> = Promise.resolve();

  public constructor(
    private snapshot: WorkspaceSnapshot,
    private readonly store: WorkspacePersistence,
  ) {
    super();
  }

  public get state(): WorkspaceSnapshot {
    return this.snapshot;
  }

  public dispatch(action: WorkspaceAction): WorkspaceSnapshot {
    this.snapshot = reduceWorkspace(this.snapshot, action);
    this.emit("change", this.snapshot, action);
    this.saveChain = this.saveChain.then(() => this.store.save(this.snapshot));
    return this.snapshot;
  }

  public onChange(
    listener: (state: WorkspaceSnapshot, action: WorkspaceAction) => void,
  ): () => void {
    this.on("change", listener);
    return () => this.off("change", listener);
  }

  public async flush(): Promise<void> {
    await this.saveChain;
  }
}
