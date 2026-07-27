import { atomicWriteUtf8, readOptionalUtf8 } from "../core/atomic-file.js";
import { errorMessage, TermLoomError } from "../core/errors.js";
import {
  createDefaultWorkspace,
  type WorkspaceSnapshot,
  WorkspaceSnapshotSchema,
} from "./schema.js";

export class WorkspaceStore {
  public constructor(public readonly path: string) {}

  public async load(defaultSidebarWidth = 28): Promise<WorkspaceSnapshot> {
    const content = await readOptionalUtf8(this.path);
    if (content === null) return createDefaultWorkspace(defaultSidebarWidth);
    try {
      return WorkspaceSnapshotSchema.parse(JSON.parse(content));
    } catch (error) {
      throw new TermLoomError({
        code: "STATE_INVALID",
        message: `Workspace state is invalid: ${errorMessage(error)}`,
        hint: `Repair or explicitly move ${this.path}; TermLoom did not reset it.`,
        cause: error,
        details: { path: this.path },
      });
    }
  }

  public async save(snapshot: WorkspaceSnapshot): Promise<void> {
    const validated = WorkspaceSnapshotSchema.parse(snapshot);
    await atomicWriteUtf8(this.path, `${JSON.stringify(validated, null, 2)}\n`);
  }
}
