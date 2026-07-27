import { describe, expect, test } from "bun:test";
import { TermLoomError } from "../../../src/core/errors.js";
import { collectPaneIds, reduceWorkspace } from "../../../src/workspace/reducer.js";
import { createDefaultWorkspace } from "../../../src/workspace/schema.js";

describe("workspace reducer", () => {
  test("creates recursive horizontal and vertical splits and collapses them", () => {
    let state = createDefaultWorkspace();
    state = reduceWorkspace(state, {
      type: "split-pane",
      paneId: "pane-local-1",
      direction: "horizontal",
      pane: { id: "files-1", kind: "files", title: "Files", hostId: "demo", path: "/tmp" },
    });
    state = reduceWorkspace(state, {
      type: "split-pane",
      paneId: "files-1",
      direction: "vertical",
      pane: {
        id: "preview-1",
        kind: "preview",
        title: "Preview",
        hostId: "demo",
        path: "/tmp/a.md",
        scrollOffset: 0,
      },
    });
    const splitTab = state.tabs[0];
    if (!splitTab) throw new Error("Expected a tab");
    expect(collectPaneIds(splitTab.root)).toEqual(["pane-local-1", "files-1", "preview-1"]);
    state = reduceWorkspace(state, { type: "close-pane", paneId: "files-1" });
    const collapsedTab = state.tabs[0];
    if (!collapsedTab) throw new Error("Expected a tab");
    expect(collectPaneIds(collapsedTab.root)).toEqual(["pane-local-1", "preview-1"]);
    expect(state.panes["files-1"]).toBeUndefined();
  });

  test("rejects closing the last pane without corrupting state", () => {
    const state = createDefaultWorkspace();
    expect(() => reduceWorkspace(state, { type: "close-pane", paneId: "pane-local-1" })).toThrow(
      TermLoomError,
    );
    expect(state.tabs).toHaveLength(1);
  });

  test("clamps split ratio", () => {
    let state = createDefaultWorkspace();
    state = reduceWorkspace(state, {
      type: "split-pane",
      paneId: "pane-local-1",
      direction: "horizontal",
      pane: { id: "files-1", kind: "files", title: "Files", hostId: "demo", path: "/" },
    });
    const tab = state.tabs[0];
    if (!tab) throw new Error("Expected a tab");
    const root = tab.root;
    if (root.type !== "split") throw new Error("Expected split");
    state = reduceWorkspace(state, { type: "resize-split", splitId: root.id, ratio: 9 });
    expect(state.tabs[0]?.root).toMatchObject({ ratio: 0.9 });
  });
});
