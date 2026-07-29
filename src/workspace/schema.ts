import { z } from "zod";

export const WORKSPACE_SCHEMA_VERSION = 2;

const IdentifierSchema = z
  .string()
  .min(1)
  .regex(/^[a-zA-Z0-9._:-]+$/);

export const TerminalPaneSchema = z
  .object({
    id: IdentifierSchema,
    kind: z.literal("terminal"),
    title: z.string().min(1),
    hostId: IdentifierSchema.optional(),
    tmuxSession: z.string().min(1).optional(),
    cwd: z.string().min(1).optional(),
  })
  .strict();

export const FilesPaneSchema = z
  .object({
    id: IdentifierSchema,
    kind: z.literal("files"),
    title: z.string().min(1),
    hostId: IdentifierSchema,
    path: z.string().min(1),
    selectedPath: z.string().min(1).optional(),
  })
  .strict();

export const PreviewPaneSchema = z
  .object({
    id: IdentifierSchema,
    kind: z.literal("preview"),
    title: z.string().min(1),
    hostId: IdentifierSchema,
    path: z.string().min(1),
    scrollOffset: z.number().int().min(0).default(0),
  })
  .strict();

export const StartPaneSchema = z
  .object({
    id: IdentifierSchema,
    kind: z.literal("start"),
    title: z.string().min(1),
    surface: z.enum(["files", "terminal"]),
    hostId: IdentifierSchema.optional(),
  })
  .strict();

export const SessionPickerPaneSchema = z
  .object({
    id: IdentifierSchema,
    kind: z.literal("session-picker"),
    title: z.string().min(1),
    hostId: IdentifierSchema,
  })
  .strict();

export const PaneSchema = z.discriminatedUnion("kind", [
  TerminalPaneSchema,
  FilesPaneSchema,
  PreviewPaneSchema,
  StartPaneSchema,
  SessionPickerPaneSchema,
]);
export type PaneState = z.infer<typeof PaneSchema>;

const WorkspacePaneV1Schema = z.discriminatedUnion("kind", [
  TerminalPaneSchema,
  FilesPaneSchema,
  PreviewPaneSchema,
]);

export interface PaneNode {
  type: "pane";
  paneId: string;
}

export interface SplitNode {
  type: "split";
  id: string;
  direction: "horizontal" | "vertical";
  ratio: number;
  first: LayoutNode;
  second: LayoutNode;
}

export type LayoutNode = PaneNode | SplitNode;

export const LayoutNodeSchema: z.ZodType<LayoutNode> = z.lazy(() =>
  z.union([
    z.object({ type: z.literal("pane"), paneId: IdentifierSchema }).strict(),
    z
      .object({
        type: z.literal("split"),
        id: IdentifierSchema,
        direction: z.enum(["horizontal", "vertical"]),
        ratio: z.number().min(0.1).max(0.9),
        first: LayoutNodeSchema,
        second: LayoutNodeSchema,
      })
      .strict(),
  ]),
);

export const WorkspaceSurfaceSchema = z
  .object({
    root: LayoutNodeSchema,
    activePaneId: IdentifierSchema,
    focusedPaneId: IdentifierSchema.optional(),
  })
  .strict();

export const WorkspaceTabSchema = z
  .object({
    id: IdentifierSchema,
    title: z.string().min(1),
    hostId: IdentifierSchema.optional(),
    activeSurface: z.enum(["files", "terminal"]),
    surfaces: z
      .object({
        files: WorkspaceSurfaceSchema,
        terminal: WorkspaceSurfaceSchema,
      })
      .strict(),
  })
  .strict();

const SidebarSchema = z
  .object({
    visible: z.boolean(),
    width: z.number().int().min(18).max(60),
    section: z.enum(["hosts", "sessions", "files"]),
  })
  .strict();

const WorkspaceSnapshotBaseSchema = z
  .object({
    schemaVersion: z.literal(WORKSPACE_SCHEMA_VERSION),
    activeTabId: IdentifierSchema,
    tabs: z.array(WorkspaceTabSchema).min(1),
    panes: z.record(IdentifierSchema, PaneSchema),
    sidebar: SidebarSchema,
    updatedAt: z.string().datetime(),
  })
  .strict();

export const WorkspaceSnapshotSchema = WorkspaceSnapshotBaseSchema.superRefine(
  (snapshot, context) => {
    if (!snapshot.tabs.some((tab) => tab.id === snapshot.activeTabId)) {
      context.addIssue({ code: "custom", message: "activeTabId does not reference a tab" });
    }
    const referenced = new Set<string>();
    for (const tab of snapshot.tabs) {
      for (const surfaceName of ["files", "terminal"] as const) {
        const surface = tab.surfaces[surfaceName];
        const local = new Set<string>();
        visitLayout(surface.root, (paneId) => {
          if (referenced.has(paneId)) {
            context.addIssue({ code: "custom", message: `Pane ${paneId} is referenced twice` });
          }
          referenced.add(paneId);
          local.add(paneId);
        });
        if (!local.has(surface.activePaneId)) {
          context.addIssue({
            code: "custom",
            message: `Tab ${tab.id} ${surfaceName} activePaneId does not reference its layout`,
          });
        }
        if (surface.focusedPaneId && !local.has(surface.focusedPaneId)) {
          context.addIssue({
            code: "custom",
            message: `Tab ${tab.id} ${surfaceName} focusedPaneId does not reference its layout`,
          });
        }
      }
    }
    validatePaneReferences(referenced, snapshot.panes, context);
  },
);

const WorkspaceTabV1Schema = z
  .object({
    id: IdentifierSchema,
    title: z.string().min(1),
    root: LayoutNodeSchema,
    activePaneId: IdentifierSchema,
  })
  .strict();

const WorkspaceSnapshotV1BaseSchema = z
  .object({
    schemaVersion: z.literal(1),
    activeTabId: IdentifierSchema,
    tabs: z.array(WorkspaceTabV1Schema).min(1),
    panes: z.record(IdentifierSchema, WorkspacePaneV1Schema),
    sidebar: SidebarSchema,
    updatedAt: z.string().datetime(),
  })
  .strict();

export const WorkspaceSnapshotV1Schema = WorkspaceSnapshotV1BaseSchema.superRefine(
  (snapshot, context) => {
    if (!snapshot.tabs.some((tab) => tab.id === snapshot.activeTabId)) {
      context.addIssue({ code: "custom", message: "activeTabId does not reference a tab" });
    }
    const referenced = new Set<string>();
    for (const tab of snapshot.tabs) {
      const local = new Set<string>();
      visitLayout(tab.root, (paneId) => {
        if (referenced.has(paneId)) {
          context.addIssue({ code: "custom", message: `Pane ${paneId} is referenced twice` });
        }
        referenced.add(paneId);
        local.add(paneId);
      });
      if (!local.has(tab.activePaneId)) {
        context.addIssue({
          code: "custom",
          message: `Tab ${tab.id} activePaneId does not reference its layout`,
        });
      }
    }
    validatePaneReferences(referenced, snapshot.panes, context);
  },
);

export type WorkspaceSurface = z.infer<typeof WorkspaceSurfaceSchema>;
export type WorkspaceTab = z.infer<typeof WorkspaceTabSchema>;
export type WorkspaceSnapshot = z.infer<typeof WorkspaceSnapshotSchema>;
export type WorkspaceSnapshotV1 = z.infer<typeof WorkspaceSnapshotV1Schema>;
export type WorkspaceSurfaceName = WorkspaceTab["activeSurface"];

export function createDefaultWorkspace(sidebarWidth = 28): WorkspaceSnapshot {
  const filesPaneId = "pane-files-start-1";
  const terminalPaneId = "pane-terminal-start-1";
  const tabId = "tab-1";
  return WorkspaceSnapshotSchema.parse({
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    activeTabId: tabId,
    tabs: [
      {
        id: tabId,
        title: "Start",
        activeSurface: "files",
        surfaces: {
          files: surfaceFor(filesPaneId),
          terminal: surfaceFor(terminalPaneId),
        },
      },
    ],
    panes: {
      [filesPaneId]: {
        id: filesPaneId,
        kind: "start",
        title: "Select a host",
        surface: "files",
      },
      [terminalPaneId]: {
        id: terminalPaneId,
        kind: "start",
        title: "Select a host",
        surface: "terminal",
      },
    },
    sidebar: { visible: true, width: sidebarWidth, section: "hosts" },
    updatedAt: new Date().toISOString(),
  });
}

export function createHostWorkspaceTab(options: {
  tabId: string;
  hostId: string;
  title: string;
  defaultPath: string;
}): { tab: WorkspaceTab; panes: PaneState[] } {
  const filesPaneId = `${options.tabId}-files`;
  const terminalPaneId = `${options.tabId}-sessions`;
  const panes: PaneState[] = [
    {
      id: filesPaneId,
      kind: "files",
      title: "Files",
      hostId: options.hostId,
      path: options.defaultPath,
    },
    {
      id: terminalPaneId,
      kind: "session-picker",
      title: "Sessions",
      hostId: options.hostId,
    },
  ];
  return {
    tab: {
      id: options.tabId,
      title: options.title,
      hostId: options.hostId,
      activeSurface: "files",
      surfaces: {
        files: surfaceFor(filesPaneId),
        terminal: surfaceFor(terminalPaneId),
      },
    },
    panes,
  };
}

export function migrateWorkspaceV1(snapshot: WorkspaceSnapshotV1): WorkspaceSnapshot {
  if (isPristineLocalWorkspace(snapshot)) {
    const migrated = createDefaultWorkspace(snapshot.sidebar.width);
    migrated.sidebar = structuredClone(snapshot.sidebar);
    migrated.updatedAt = snapshot.updatedAt;
    return WorkspaceSnapshotSchema.parse(migrated);
  }

  const panes: Record<string, PaneState> = structuredClone(snapshot.panes);
  const usedIds = new Set(Object.keys(panes));
  const tabs: WorkspaceTab[] = snapshot.tabs.map((tab) => {
    const activePane = snapshot.panes[tab.activePaneId];
    if (!activePane) throw new Error(`Missing active v1 pane ${tab.activePaneId}`);
    const hostId =
      activePane.hostId ??
      collectLayoutPaneIds(tab.root)
        .map((paneId) => snapshot.panes[paneId])
        .find((pane) => pane?.hostId)?.hostId;
    const activeSurface: WorkspaceSurfaceName =
      activePane.kind === "terminal" ? "terminal" : "files";
    const placeholderSurface: WorkspaceSurfaceName =
      activeSurface === "files" ? "terminal" : "files";
    const placeholderId = uniqueMigrationPaneId(tab.id, placeholderSurface, usedIds);
    const placeholder = migrationPlaceholder(placeholderId, placeholderSurface, hostId);
    panes[placeholderId] = placeholder;
    const preservedSurface: WorkspaceSurface = {
      root: structuredClone(tab.root),
      activePaneId: tab.activePaneId,
      focusedPaneId: tab.activePaneId,
    };
    return {
      id: tab.id,
      title: tab.title,
      ...(hostId ? { hostId } : {}),
      activeSurface,
      surfaces:
        activeSurface === "files"
          ? { files: preservedSurface, terminal: surfaceFor(placeholderId) }
          : { files: surfaceFor(placeholderId), terminal: preservedSurface },
    };
  });

  return WorkspaceSnapshotSchema.parse({
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    activeTabId: snapshot.activeTabId,
    tabs,
    panes,
    sidebar: snapshot.sidebar,
    updatedAt: snapshot.updatedAt,
  });
}

function migrationPlaceholder(
  id: string,
  surface: WorkspaceSurfaceName,
  hostId: string | undefined,
): PaneState {
  if (surface === "terminal" && hostId) {
    return { id, kind: "session-picker", title: "Sessions", hostId };
  }
  if (surface === "files" && hostId) {
    return { id, kind: "files", title: "Files", hostId, path: "." };
  }
  return {
    id,
    kind: "start",
    title: "Select a host",
    surface,
    ...(hostId ? { hostId } : {}),
  };
}

function isPristineLocalWorkspace(snapshot: WorkspaceSnapshotV1): boolean {
  const tab = snapshot.tabs[0];
  const pane = snapshot.panes["pane-local-1"];
  return (
    snapshot.tabs.length === 1 &&
    Object.keys(snapshot.panes).length === 1 &&
    snapshot.activeTabId === "tab-1" &&
    tab?.id === "tab-1" &&
    tab.title === "Local" &&
    tab.activePaneId === "pane-local-1" &&
    tab.root.type === "pane" &&
    tab.root.paneId === "pane-local-1" &&
    pane?.kind === "terminal" &&
    pane.title === "Local shell" &&
    !pane.hostId &&
    !pane.tmuxSession &&
    !pane.cwd
  );
}

function surfaceFor(paneId: string): WorkspaceSurface {
  return { root: { type: "pane", paneId }, activePaneId: paneId, focusedPaneId: paneId };
}

function collectLayoutPaneIds(node: LayoutNode): string[] {
  return node.type === "pane"
    ? [node.paneId]
    : [...collectLayoutPaneIds(node.first), ...collectLayoutPaneIds(node.second)];
}

function uniqueMigrationPaneId(
  tabId: string,
  surface: WorkspaceSurfaceName,
  usedIds: Set<string>,
): string {
  const base = `pane-${tabId}-${surface}-start`;
  let candidate = base;
  let suffix = 2;
  while (usedIds.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  usedIds.add(candidate);
  return candidate;
}

function visitLayout(node: LayoutNode, visit: (paneId: string) => void): void {
  if (node.type === "pane") {
    visit(node.paneId);
    return;
  }
  visitLayout(node.first, visit);
  visitLayout(node.second, visit);
}

function validatePaneReferences(
  referenced: ReadonlySet<string>,
  panes: Readonly<Record<string, unknown>>,
  context: z.core.$RefinementCtx,
): void {
  for (const paneId of referenced) {
    if (!panes[paneId]) {
      context.addIssue({ code: "custom", message: `Layout references missing pane ${paneId}` });
    }
  }
  for (const paneId of Object.keys(panes)) {
    if (!referenced.has(paneId)) {
      context.addIssue({ code: "custom", message: `Unreferenced pane ${paneId}` });
    }
  }
}
