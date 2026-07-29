import { atomicWriteUtf8, readOptionalUtf8 } from "../core/atomic-file.js";
import { errorMessage, TermLoomError } from "../core/errors.js";
import {
  createDefaultWorkspace,
  migrateWorkspaceV1,
  type WorkspaceSnapshot,
  WorkspaceSnapshotSchema,
  WorkspaceSnapshotV1Schema,
} from "./schema.js";

export class WorkspaceStore {
  public constructor(public readonly path: string) {}

  public async load(defaultSidebarWidth = 28): Promise<WorkspaceSnapshot> {
    const content = await readOptionalUtf8(this.path);
    if (content === null) return createDefaultWorkspace(defaultSidebarWidth);
    try {
      const parsed = JSON.parse(content);
      if (workspaceVersion(parsed) === 1) {
        const migrated = migrateWorkspaceV1(WorkspaceSnapshotV1Schema.parse(parsed));
        await this.persistMigration(content, migrated);
        return migrated;
      }
      return WorkspaceSnapshotSchema.parse(parsed);
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

  private async persistMigration(original: string, migrated: WorkspaceSnapshot): Promise<void> {
    const backupPath = `${this.path}.v1.bak`;
    if ((await readOptionalUtf8(backupPath)) === null) {
      await atomicWriteUtf8(backupPath, original);
    }
    await atomicWriteUtf8(this.path, `${JSON.stringify(migrated, null, 2)}\n`);
  }
}

function workspaceVersion(value: unknown): unknown {
  if (typeof value !== "object" || value === null || !("schemaVersion" in value)) return undefined;
  return value.schemaVersion;
}
