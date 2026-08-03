import { TermLoomError } from "../core/errors.js";
import { isDeepStrictEqual } from "node:util";
import type {
  LayoutNode,
  PaneState,
  WorkspaceSnapshot,
  WorkspaceSurface,
  WorkspaceSurfaceName,
  WorkspaceTab,
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
  switch (action.type) {
    case "focus-pane": {
      const tab = activeTab(current);
      const surface = activeSurface(tab);
      if (!layoutContains(surface.root, action.paneId))
        invalid(`Pane ${action.paneId} is not in active tab`);
      if (surface.activePaneId === action.paneId && surface.focusedPaneId === action.paneId) {
        return current;
      }
      return updateActiveSurface(current, {
        ...surface,
        activePaneId: action.paneId,
        focusedPaneId: action.paneId,
      });
    }
    case "split-pane": {
      const tab = activeTab(current);
      const surface = activeSurface(tab);
      if (current.panes[action.pane.id]) invalid(`Pane ${action.pane.id} already exists`);
      const replacement = replacePane(surface.root, action.paneId, (leaf) => ({
        type: "split",
        id: uniqueId("split"),
        direction: action.direction,
        ratio: 0.5,
        first: leaf,
        second: { type: "pane", paneId: action.pane.id },
      }));
      if (!replacement.changed) invalid(`Pane ${action.paneId} is not in active tab`);
      return updateActiveSurface(
        current,
        {
          ...surface,
          root: replacement.node,
          activePaneId: action.pane.id,
          focusedPaneId: action.pane.id,
        },
        { ...current.panes, [action.pane.id]: action.pane },
      );
    }
    case "close-pane": {
      const tab = activeTab(current);
      const surface = activeSurface(tab);
      if (surface.root.type === "pane" && surface.root.paneId === action.paneId) {
        invalid("Cannot close the only pane in a tab");
      }
      const removed = removePane(surface.root, action.paneId);
      if (!removed.changed || !removed.node) invalid(`Pane ${action.paneId} is not in active tab`);
      const { [action.paneId]: _removedPane, ...panes } = current.panes;
      const activePaneId = firstPaneId(removed.node);
      return updateActiveSurface(
        current,
        { ...surface, root: removed.node, activePaneId, focusedPaneId: activePaneId },
        panes,
      );
    }
    case "resize-split": {
      const surface = activeSurface(activeTab(current));
      const result = updateSplit(surface.root, action.splitId, action.ratio);
      if (!result.found) invalid(`Split ${action.splitId} does not exist`);
      if (!result.changed) return current;
      return updateActiveSurface(current, { ...surface, root: result.node });
    }
    case "swap-panes": {
      const tab = activeTab(current);
      const surface = activeSurface(tab);
      if (!layoutContains(surface.root, action.firstPaneId)) {
        invalid(`Pane ${action.firstPaneId} is not in active tab`);
      }
      if (!layoutContains(surface.root, action.secondPaneId)) {
        invalid(`Pane ${action.secondPaneId} is not in active tab`);
      }
      if (action.firstPaneId === action.secondPaneId) return current;
      return updateActiveSurface(current, {
        ...surface,
        root: swapPaneIds(surface.root, action.firstPaneId, action.secondPaneId),
      });
    }
    case "add-tab": {
      if (current.tabs.some((tab) => tab.id === action.tab.id))
        invalid(`Tab ${action.tab.id} exists`);
      const panes = { ...current.panes };
      for (const pane of action.panes) {
        if (panes[pane.id]) invalid(`Pane ${pane.id} already exists`);
        panes[pane.id] = pane;
      }
      return changed(current, {
        tabs: [...current.tabs, action.tab],
        panes,
        activeTabId: action.tab.id,
      });
    }
    case "activate-tab": {
      if (!current.tabs.some((tab) => tab.id === action.tabId))
        invalid(`Tab ${action.tabId} does not exist`);
      if (current.activeTabId === action.tabId) return current;
      return changed(current, { activeTabId: action.tabId });
    }
    case "close-tab": {
      if (current.tabs.length === 1) invalid("Cannot close the only tab");
      const tabIndex = current.tabs.findIndex((candidate) => candidate.id === action.tabId);
      const tab = current.tabs[tabIndex];
      if (!tab) invalid(`Tab ${action.tabId} does not exist`);
      const panes = { ...current.panes };
      for (const paneId of [
        ...collectPaneIds(tab.surfaces.files.root),
        ...collectPaneIds(tab.surfaces.terminal.root),
      ]) {
        delete panes[paneId];
      }
      const tabs = current.tabs.filter((candidate) => candidate.id !== action.tabId);
      const activeTabId =
        current.activeTabId === action.tabId
          ? (tabs[Math.min(tabIndex, tabs.length - 1)]?.id ?? "")
          : current.activeTabId;
      return changed(current, { tabs, panes, activeTabId });
    }
    case "update-pane": {
      const existing = current.panes[action.pane.id];
      if (!existing) invalid(`Pane ${action.pane.id} does not exist`);
      if (existing === action.pane || isDeepStrictEqual(existing, action.pane)) return current;
      return changed(current, { panes: { ...current.panes, [action.pane.id]: action.pane } });
    }
    case "switch-surface": {
      const tab = activeTab(current);
      return updateTab(current, tab.id, {
        ...tab,
        activeSurface: tab.activeSurface === "files" ? "terminal" : "files",
      });
    }
    case "set-active-surface": {
      const tab = activeTab(current);
      if (tab.activeSurface === action.surface) return current;
      return updateTab(current, tab.id, { ...tab, activeSurface: action.surface });
    }
    case "toggle-sidebar": {
      return changed(current, {
        sidebar: { ...current.sidebar, visible: !current.sidebar.visible },
      });
    }
    case "set-sidebar-width": {
      const width = Math.max(18, Math.min(60, Math.round(action.width)));
      if (current.sidebar.width === width) return current;
      return changed(current, { sidebar: { ...current.sidebar, width } });
    }
    case "select-sidebar-section": {
      if (current.sidebar.section === action.section) return current;
      return changed(current, {
        sidebar: { ...current.sidebar, section: action.section },
      });
    }
  }
}

function changed(
  current: WorkspaceSnapshot,
  update: Partial<Omit<WorkspaceSnapshot, "schemaVersion" | "updatedAt">>,
): WorkspaceSnapshot {
  return { ...current, ...update, updatedAt: new Date().toISOString() };
}

function updateTab(
  current: WorkspaceSnapshot,
  tabId: string,
  tab: WorkspaceTab,
  panes: WorkspaceSnapshot["panes"] = current.panes,
): WorkspaceSnapshot {
  const index = current.tabs.findIndex((candidate) => candidate.id === tabId);
  if (index < 0) return invalid(`Tab ${tabId} does not exist`);
  const tabs = current.tabs.slice();
  tabs[index] = tab;
  return changed(current, { tabs, panes });
}

function updateActiveSurface(
  current: WorkspaceSnapshot,
  surface: WorkspaceSurface,
  panes: WorkspaceSnapshot["panes"] = current.panes,
): WorkspaceSnapshot {
  const tab = activeTab(current);
  return updateTab(
    current,
    tab.id,
    {
      ...tab,
      surfaces: { ...tab.surfaces, [tab.activeSurface]: surface },
    },
    panes,
  );
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
): { node: LayoutNode; found: boolean; changed: boolean } {
  if (node.type === "pane") return { node, found: false, changed: false };
  if (node.id === splitId) {
    const nextRatio = Math.max(0.1, Math.min(0.9, ratio));
    return nextRatio === node.ratio
      ? { node, found: true, changed: false }
      : { node: { ...node, ratio: nextRatio }, found: true, changed: true };
  }
  const first = updateSplit(node.first, splitId, ratio);
  if (first.found) {
    return first.changed
      ? { node: { ...node, first: first.node }, found: true, changed: true }
      : { node, found: true, changed: false };
  }
  const second = updateSplit(node.second, splitId, ratio);
  if (!second.found) return { node, found: false, changed: false };
  return second.changed
    ? { node: { ...node, second: second.node }, found: true, changed: true }
    : { node, found: true, changed: false };
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
