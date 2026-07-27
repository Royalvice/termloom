import { TermLoomError } from "../core/errors.js";
import {
  type LayoutNode,
  type PaneState,
  type WorkspaceSnapshot,
  type WorkspaceTab,
  WorkspaceSnapshotSchema,
} from "./schema.js";

export type WorkspaceAction =
  | { type: "focus-pane"; paneId: string }
  | { type: "split-pane"; paneId: string; direction: "horizontal" | "vertical"; pane: PaneState }
  | { type: "close-pane"; paneId: string }
  | { type: "resize-split"; splitId: string; ratio: number }
  | { type: "add-tab"; tab: WorkspaceTab; panes: readonly PaneState[] }
  | { type: "activate-tab"; tabId: string }
  | { type: "close-tab"; tabId: string }
  | { type: "update-pane"; pane: PaneState }
  | { type: "toggle-sidebar" }
  | { type: "select-sidebar-section"; section: "hosts" | "sessions" | "files" };

export function reduceWorkspace(
  current: WorkspaceSnapshot,
  action: WorkspaceAction,
): WorkspaceSnapshot {
  const state = structuredClone(current);
  switch (action.type) {
    case "focus-pane": {
      const tab = activeTab(state);
      if (!layoutContains(tab.root, action.paneId))
        invalid(`Pane ${action.paneId} is not in active tab`);
      tab.activePaneId = action.paneId;
      break;
    }
    case "split-pane": {
      const tab = activeTab(state);
      if (state.panes[action.pane.id]) invalid(`Pane ${action.pane.id} already exists`);
      const replacement = replacePane(tab.root, action.paneId, (leaf) => ({
        type: "split",
        id: uniqueId("split"),
        direction: action.direction,
        ratio: 0.5,
        first: leaf,
        second: { type: "pane", paneId: action.pane.id },
      }));
      if (!replacement.changed) invalid(`Pane ${action.paneId} is not in active tab`);
      tab.root = replacement.node;
      tab.activePaneId = action.pane.id;
      state.panes[action.pane.id] = action.pane;
      break;
    }
    case "close-pane": {
      const tab = activeTab(state);
      if (tab.root.type === "pane" && tab.root.paneId === action.paneId) {
        invalid("Cannot close the only pane in a tab");
      }
      const removed = removePane(tab.root, action.paneId);
      if (!removed.changed || !removed.node) invalid(`Pane ${action.paneId} is not in active tab`);
      tab.root = removed.node;
      delete state.panes[action.paneId];
      tab.activePaneId = firstPaneId(tab.root);
      break;
    }
    case "resize-split": {
      const result = updateSplit(activeTab(state).root, action.splitId, action.ratio);
      if (!result.changed) invalid(`Split ${action.splitId} does not exist`);
      activeTab(state).root = result.node;
      break;
    }
    case "add-tab": {
      if (state.tabs.some((tab) => tab.id === action.tab.id))
        invalid(`Tab ${action.tab.id} exists`);
      for (const pane of action.panes) {
        if (state.panes[pane.id]) invalid(`Pane ${pane.id} already exists`);
        state.panes[pane.id] = pane;
      }
      state.tabs.push(action.tab);
      state.activeTabId = action.tab.id;
      break;
    }
    case "activate-tab": {
      if (!state.tabs.some((tab) => tab.id === action.tabId))
        invalid(`Tab ${action.tabId} does not exist`);
      state.activeTabId = action.tabId;
      break;
    }
    case "close-tab": {
      if (state.tabs.length === 1) invalid("Cannot close the only tab");
      const tab = state.tabs.find((candidate) => candidate.id === action.tabId);
      if (!tab) invalid(`Tab ${action.tabId} does not exist`);
      for (const paneId of collectPaneIds(tab.root)) delete state.panes[paneId];
      state.tabs = state.tabs.filter((candidate) => candidate.id !== action.tabId);
      if (state.activeTabId === action.tabId) state.activeTabId = state.tabs[0]?.id ?? "";
      break;
    }
    case "update-pane": {
      if (!state.panes[action.pane.id]) invalid(`Pane ${action.pane.id} does not exist`);
      state.panes[action.pane.id] = action.pane;
      break;
    }
    case "toggle-sidebar": {
      state.sidebar.visible = !state.sidebar.visible;
      break;
    }
    case "select-sidebar-section": {
      state.sidebar.section = action.section;
      break;
    }
  }
  state.updatedAt = new Date().toISOString();
  return WorkspaceSnapshotSchema.parse(state);
}

export function activeTab(state: WorkspaceSnapshot): WorkspaceTab {
  const tab = state.tabs.find((candidate) => candidate.id === state.activeTabId);
  if (!tab) return invalid(`Active tab ${state.activeTabId} does not exist`);
  return tab;
}

export function collectPaneIds(node: LayoutNode): string[] {
  if (node.type === "pane") return [node.paneId];
  return [...collectPaneIds(node.first), ...collectPaneIds(node.second)];
}

function layoutContains(node: LayoutNode, paneId: string): boolean {
  return node.type === "pane"
    ? node.paneId === paneId
    : layoutContains(node.first, paneId) || layoutContains(node.second, paneId);
}

function firstPaneId(node: LayoutNode): string {
  return node.type === "pane" ? node.paneId : firstPaneId(node.first);
}

function replacePane(
  node: LayoutNode,
  paneId: string,
  replace: (leaf: LayoutNode & { type: "pane" }) => LayoutNode,
): { node: LayoutNode; changed: boolean } {
  if (node.type === "pane") {
    return node.paneId === paneId
      ? { node: replace(node), changed: true }
      : { node, changed: false };
  }
  const first = replacePane(node.first, paneId, replace);
  if (first.changed) return { node: { ...node, first: first.node }, changed: true };
  const second = replacePane(node.second, paneId, replace);
  return second.changed
    ? { node: { ...node, second: second.node }, changed: true }
    : { node, changed: false };
}

function removePane(
  node: LayoutNode,
  paneId: string,
): { node: LayoutNode | null; changed: boolean } {
  if (node.type === "pane") {
    return node.paneId === paneId ? { node: null, changed: true } : { node, changed: false };
  }
  const first = removePane(node.first, paneId);
  if (first.changed) {
    return {
      node: first.node ? { ...node, first: first.node } : node.second,
      changed: true,
    };
  }
  const second = removePane(node.second, paneId);
  if (second.changed) {
    return {
      node: second.node ? { ...node, second: second.node } : node.first,
      changed: true,
    };
  }
  return { node, changed: false };
}

function updateSplit(
  node: LayoutNode,
  splitId: string,
  ratio: number,
): { node: LayoutNode; changed: boolean } {
  if (node.type === "pane") return { node, changed: false };
  if (node.id === splitId) {
    return { node: { ...node, ratio: Math.max(0.1, Math.min(0.9, ratio)) }, changed: true };
  }
  const first = updateSplit(node.first, splitId, ratio);
  if (first.changed) return { node: { ...node, first: first.node }, changed: true };
  const second = updateSplit(node.second, splitId, ratio);
  return second.changed
    ? { node: { ...node, second: second.node }, changed: true }
    : { node, changed: false };
}

function uniqueId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function invalid(message: string): never {
  throw new TermLoomError({ code: "WORKSPACE_INVALID", message });
}
