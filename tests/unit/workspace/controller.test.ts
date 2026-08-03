import { describe, expect, test } from "bun:test";
import { WorkspaceController } from "../../../src/workspace/controller.js";
import { createDefaultWorkspace, type WorkspaceSnapshot } from "../../../src/workspace/schema.js";

describe("WorkspaceController", () => {
  test("does not emit or save reducer no-ops", async () => {
    const store = new RecordingStore();
    const controller = new WorkspaceController(createDefaultWorkspace(), store, {
      saveDebounceMs: 1,
    });
    const initial = controller.state;
    let changes = 0;
    controller.onChange(() => {
      changes += 1;
    });
    expect(controller.dispatch({ type: "focus-pane", paneId: "pane-local-files-1" })).toBe(initial);
    await controller.flush();
    expect(changes).toBe(0);
    expect(store.saved).toHaveLength(0);
  });

  test("coalesces 200 actions into at most two saves and persists the latest revision", async () => {
    const store = new RecordingStore();
    const controller = new WorkspaceController(createDefaultWorkspace(), store, {
      saveDebounceMs: 2,
    });
    for (let index = 0; index < 200; index += 1) {
      const pane = controller.state.panes["pane-local-files-1"];
      if (pane?.kind !== "files") throw new Error("Expected Local files pane");
      controller.dispatch({ type: "update-pane", pane: { ...pane, path: `/tmp/${index}` } });
    }
    await controller.flush();
    expect(store.saved.length).toBeLessThanOrEqual(2);
    expect(store.saved.at(-1)?.panes["pane-local-files-1"]).toMatchObject({ path: "/tmp/199" });
    expect(controller.hasUnsavedChanges).toBe(false);
  });

  test("reports a failed save and allows a later revision and explicit flush to recover", async () => {
    const store = new RecordingStore(1);
    const controller = new WorkspaceController(createDefaultWorkspace(), store, {
      saveDebounceMs: 100,
    });
    const errors: number[] = [];
    controller.onPersistenceError((event) => errors.push(event.revision));
    controller.dispatch({ type: "set-sidebar-width", width: 33 });
    await expect(controller.flush()).rejects.toThrow("fixture save failed");
    expect(errors).toEqual([1]);
    expect(controller.hasUnsavedChanges).toBe(true);

    controller.dispatch({ type: "set-sidebar-width", width: 34 });
    await controller.retry();
    expect(controller.persistenceError).toBeUndefined();
    expect(controller.hasUnsavedChanges).toBe(false);
    expect(store.saved.at(-1)?.sidebar.width).toBe(34);
  });
});

class RecordingStore {
  public readonly saved: WorkspaceSnapshot[] = [];
  private attempts = 0;

  public constructor(private readonly failures = 0) {}

  public async save(snapshot: WorkspaceSnapshot): Promise<void> {
    this.attempts += 1;
    if (this.attempts <= this.failures) throw new Error("fixture save failed");
    this.saved.push(structuredClone(snapshot));
  }
}
