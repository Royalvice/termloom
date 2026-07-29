import { TermLoomError } from "../core/errors.js";
import {
  type LayoutNode,
  type PaneState,
  type WorkspaceSnapshot,
  WorkspaceSnapshotSchema,
  type WorkspaceSurface,
  type WorkspaceSurfaceName,
  type WorkspaceTab,
} from "./schema.js";

export type WorkspaceAction =
  | { type: "focus-pane"; paneId: string }
  | { type: "split-pane"; paneId: string; direction: "horizontal" | "vertical"; pane: PaneState }
  | { type: "close-pane"; paneId: string }
  | { type: "resize-split"; splitId: string; ratio: number }
  | { type: "swap-panes"; firstPaneId: string; secondPaneId: string }
  | { type: "add-tab"; tab: WorkspaceTab; panes: readonly PaneState[] }
  | { type: "activate-tab"; tabId: string }
  | { type: "close-tab"; tabId: string }
  | { type: "update-pane"; pane: PaneState }
  | { type: "switch-surface" }
  | { type: "set-active-surface"; surface: WorkspaceSurfaceName }
  | { type: "toggle-sidebar" }
  | { type: "set-sidebar-width"; width: number }
  | { type: "select-sidebar-section"; section: "hosts" | "sessions" | "files" };

export function reduceWorkspace(
  current: WorkspaceSnapshot,
  action: WorkspaceAction,
): WorkspaceSnapshot {
  const state = structuredClone(current);
  switch (action.type) {
    case "focus-pane": {
      const tab = activeTab(state);
      const surface = activeSurface(tab);
      if (!layoutContains(surface.root, action.paneId))
        invalid(`Pane ${action.paneId} is not in active tab`);
      surface.activePaneId = action.paneId;
      surface.focusedPaneId = action.paneId;
      break;
    }
    case "split-pane": {
      const tab = activeTab(state);
      const surface = activeSurface(tab);
      if (state.panes[action.pane.id]) invalid(`Pane ${action.pane.id} already exists`);
      const replacement = replacePane(surface.root, action.paneId, (leaf) => ({
        type: "split",
        id: uniqueId("split"),
        direction: action.direction,
        ratio: 0.5,
        first: leaf,
        second: { type: "pane", paneId: action.pane.id },
      }));
      if (!replacement.changed) invalid(`Pane ${action.paneId} is not in active tab`);
      surface.root = replacement.node;
      surface.activePaneId = action.pane.id;
      surface.focusedPaneId = action.pane.id;
      state.panes[action.pane.id] = action.pane;
      break;
    }
    case "close-pane": {
      const tab = activeTab(state);
      const surface = activeSurface(tab);
      if (surface.root.type === "pane" && surface.root.paneId === action.paneId) {
        invalid("Cannot close the only pane in a tab");
      }
      const removed = removePane(surface.root, action.paneId);
      if (!removed.changed || !removed.node) invalid(`Pane ${action.paneId} is not in active tab`);
      surface.root = removed.node;
      delete state.panes[action.paneId];
      surface.activePaneId = firstPaneId(surface.root);
      surface.focusedPaneId = surface.activePaneId;
      break;
    }
    case "resize-split": {
      const surface = activeSurface(activeTab(state));
      const result = updateSplit(surface.root, action.splitId, action.ratio);
      if (!result.changed) invalid(`Split ${action.splitId} does not exist`);
      surface.root = result.node;
      break;
    }
    case "swap-panes": {
      const tab = activeTab(state);
      const surface = activeSurface(tab);
      if (action.firstPaneId === action.secondPaneId) invalid("Cannot swap a pane with itself");
      if (!layoutContains(surface.root, action.firstPaneId)) {
        invalid(`Pane ${action.firstPaneId} is not in active tab`);
      }
      if (!layoutContains(surface.root, action.secondPaneId)) {
        invalid(`Pane ${action.secondPaneId} is not in active tab`);
      }
      surface.root = swapPaneIds(surface.root, action.firstPaneId, action.secondPaneId);
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
      const tabIndex = state.tabs.findIndex((candidate) => candidate.id === action.tabId);
      const tab = state.tabs[tabIndex];
      if (!tab) invalid(`Tab ${action.tabId} does not exist`);
      for (const paneId of [
        ...collectPaneIds(tab.surfaces.files.root),
        ...collectPaneIds(tab.surfaces.terminal.root),
      ]) {
        delete state.panes[paneId];
      }
      state.tabs = state.tabs.filter((candidate) => candidate.id !== action.tabId);
      if (state.activeTabId === action.tabId) {
        state.activeTabId = state.tabs[Math.min(tabIndex, state.tabs.length - 1)]?.id ?? "";
      }
      break;
    }
    case "update-pane": {
      if (!state.panes[action.pane.id]) invalid(`Pane ${action.pane.id} does not exist`);
      state.panes[action.pane.id] = action.pane;
      break;
    }
    case "switch-surface": {
      const tab = activeTab(state);
      tab.activeSurface = tab.activeSurface === "files" ? "terminal" : "files";
      break;
    }
    case "set-active-surface": {
      activeTab(state).activeSurface = action.surface;
      break;
    }
    case "toggle-sidebar": {
      state.sidebar.visible = !state.sidebar.visible;
      break;
    }
    case "set-sidebar-width": {
      state.sidebar.width = Math.max(18, Math.min(60, Math.round(action.width)));
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

export function activeSurface(tab: WorkspaceTab): WorkspaceSurface {
  return tab.surfaces[tab.activeSurface];
}

export function collectPaneIds(node: LayoutNode): string[] {
  if (node.type === "pane") return [node.paneId];
  return [...collectPaneIds(node.first), ...collectPaneIds(node.second)];
}

export function nearestSplitForPane(
  node: LayoutNode,
  paneId: string,
): { split: Extract<LayoutNode, { type: "split" }>; side: "first" | "second" } | undefined {
  if (node.type === "pane") return undefined;
  const directSide = childContains(node.first, paneId)
    ? "first"
    : childContains(node.second, paneId)
      ? "second"
      : undefined;
  if (!directSide) return undefined;
  const child = node[directSide];
  return nearestSplitForPane(child, paneId) ?? { split: node, side: directSide };
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

function swapPaneIds(node: LayoutNode, firstPaneId: string, secondPaneId: string): LayoutNode {
  if (node.type === "pane") {
    if (node.paneId === firstPaneId) return { ...node, paneId: secondPaneId };
    if (node.paneId === secondPaneId) return { ...node, paneId: firstPaneId };
    return node;
  }
  return {
    ...node,
    first: swapPaneIds(node.first, firstPaneId, secondPaneId),
    second: swapPaneIds(node.second, firstPaneId, secondPaneId),
  };
}

function childContains(node: LayoutNode, paneId: string): boolean {
  return layoutContains(node, paneId);
}

function uniqueId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function invalid(message: string): never {
  throw new TermLoomError({ code: "WORKSPACE_INVALID", message });
}
