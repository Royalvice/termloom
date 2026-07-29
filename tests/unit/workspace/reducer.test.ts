import { describe, expect, test } from "bun:test";
import { TermLoomError } from "../../../src/core/errors.js";
import {
  activeSurface,
  activeTab,
  collectPaneIds,
  nearestSplitForPane,
  reduceWorkspace,
} from "../../../src/workspace/reducer.js";
import { createDefaultWorkspace } from "../../../src/workspace/schema.js";

describe("workspace reducer", () => {
  test("creates recursive horizontal and vertical splits and collapses them", () => {
    let state = createDefaultWorkspace();
    state = reduceWorkspace(state, {
      type: "split-pane",
      paneId: "pane-files-start-1",
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
    expect(collectPaneIds(activeSurface(splitTab).root)).toEqual([
      "pane-files-start-1",
      "files-1",
      "preview-1",
    ]);
    state = reduceWorkspace(state, { type: "close-pane", paneId: "files-1" });
    const collapsedTab = state.tabs[0];
    if (!collapsedTab) throw new Error("Expected a tab");
    expect(collectPaneIds(activeSurface(collapsedTab).root)).toEqual([
      "pane-files-start-1",
      "preview-1",
    ]);
    expect(state.panes["files-1"]).toBeUndefined();
  });

  test("rejects closing the last pane without corrupting state", () => {
    const state = createDefaultWorkspace();
    expect(() =>
      reduceWorkspace(state, { type: "close-pane", paneId: "pane-files-start-1" }),
    ).toThrow(TermLoomError);
    expect(state.tabs).toHaveLength(1);
  });

  test("clamps split ratio", () => {
    let state = createDefaultWorkspace();
    state = reduceWorkspace(state, {
      type: "split-pane",
      paneId: "pane-files-start-1",
      direction: "horizontal",
      pane: { id: "files-1", kind: "files", title: "Files", hostId: "demo", path: "/" },
    });
    const tab = state.tabs[0];
    if (!tab) throw new Error("Expected a tab");
    const root = activeSurface(tab).root;
    if (root.type !== "split") throw new Error("Expected split");
    state = reduceWorkspace(state, { type: "resize-split", splitId: root.id, ratio: 9 });
    expect(state.tabs[0] ? activeSurface(state.tabs[0]).root : undefined).toMatchObject({
      ratio: 0.9,
    });
  });

  test("finds the nearest split, swaps panes, and persists sidebar width", () => {
    let state = createDefaultWorkspace();
    state = reduceWorkspace(state, {
      type: "split-pane",
      paneId: "pane-files-start-1",
      direction: "horizontal",
      pane: { id: "files-1", kind: "files", title: "Files", hostId: "demo", path: "/" },
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
        path: "/README.md",
        scrollOffset: 0,
      },
    });
    const tab = state.tabs[0];
    if (!tab) throw new Error("Expected a tab");
    const nearest = nearestSplitForPane(activeSurface(tab).root, "preview-1");
    expect(nearest?.split.direction).toBe("vertical");
    expect(nearest?.side).toBe("second");

    state = reduceWorkspace(state, {
      type: "swap-panes",
      firstPaneId: "pane-files-start-1",
      secondPaneId: "preview-1",
    });
    const updatedTab = activeTab(state);
    expect(collectPaneIds(activeSurface(updatedTab).root)).toEqual([
      "preview-1",
      "files-1",
      "pane-files-start-1",
    ]);
    state = reduceWorkspace(state, { type: "set-sidebar-width", width: 99 });
    expect(state.sidebar.width).toBe(60);
  });

  test("keeps Files and Terminal layouts independent while switching surfaces", () => {
    let state = createDefaultWorkspace();
    state = reduceWorkspace(state, {
      type: "split-pane",
      paneId: "pane-files-start-1",
      direction: "horizontal",
      pane: { id: "files-1", kind: "files", title: "Files", hostId: "demo", path: "." },
    });
    const filesRoot = structuredClone(activeSurface(activeTab(state)).root);

    state = reduceWorkspace(state, { type: "switch-surface" });
    expect(activeTab(state).activeSurface).toBe("terminal");
    expect(collectPaneIds(activeSurface(activeTab(state)).root)).toEqual(["pane-terminal-start-1"]);
    state = reduceWorkspace(state, {
      type: "split-pane",
      paneId: "pane-terminal-start-1",
      direction: "vertical",
      pane: { id: "local-2", kind: "terminal", title: "Local shell" },
    });

    state = reduceWorkspace(state, { type: "switch-surface" });
    expect(activeTab(state).activeSurface).toBe("files");
    expect(activeSurface(activeTab(state)).root).toEqual(filesRoot);
    expect(collectPaneIds(activeTab(state).surfaces.terminal.root)).toEqual([
      "pane-terminal-start-1",
      "local-2",
    ]);
  });
});
