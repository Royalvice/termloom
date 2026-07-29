import { homedir } from "node:os";
import { z } from "zod";

export const WORKSPACE_SCHEMA_VERSION = 3;

const IdentifierSchema = z
  .string()
  .min(1)
  .regex(/^[a-zA-Z0-9._:-]+$/);

export const WorkspaceTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("local") }).strict(),
  z.object({ kind: z.literal("ssh"), hostId: IdentifierSchema }).strict(),
]);
export type WorkspaceTarget = z.infer<typeof WorkspaceTargetSchema>;

export const TerminalPaneSchema = z
  .object({
    id: IdentifierSchema,
    kind: z.literal("terminal"),
    title: z.string().min(1),
    target: WorkspaceTargetSchema,
    tmuxSession: z.string().min(1).optional(),
    cwd: z.string().min(1).optional(),
  })
  .strict();

export const FilesPaneSchema = z
  .object({
    id: IdentifierSchema,
    kind: z.literal("files"),
    title: z.string().min(1),
    target: WorkspaceTargetSchema,
    path: z.string().min(1),
    selectedPath: z.string().min(1).optional(),
    previewPath: z.string().min(1).optional(),
    previewScrollOffset: z.number().int().min(0).optional(),
  })
  .strict();

export const PreviewPaneSchema = z
  .object({
    id: IdentifierSchema,
    kind: z.literal("preview"),
    title: z.string().min(1),
    target: WorkspaceTargetSchema,
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
    target: WorkspaceTargetSchema,
  })
  .strict();

const SshTargetSchema = z.object({ kind: z.literal("ssh"), hostId: IdentifierSchema }).strict();

export const TerminalLauncherPaneSchema = z
  .object({
    id: IdentifierSchema,
    kind: z.literal("terminal-launcher"),
    title: z.string().min(1),
    target: SshTargetSchema,
  })
  .strict();

export const SessionPickerPaneSchema = z
  .object({
    id: IdentifierSchema,
    kind: z.literal("session-picker"),
    title: z.string().min(1),
    target: SshTargetSchema,
  })
  .strict();

export const PaneSchema = z.discriminatedUnion("kind", [
  TerminalPaneSchema,
  FilesPaneSchema,
  PreviewPaneSchema,
  StartPaneSchema,
  TerminalLauncherPaneSchema,
  SessionPickerPaneSchema,
]);
export type PaneState = z.infer<typeof PaneSchema>;

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
    target: WorkspaceTargetSchema,
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

const LegacyTerminalPaneSchema = z
  .object({
    id: IdentifierSchema,
    kind: z.literal("terminal"),
    title: z.string().min(1),
    hostId: IdentifierSchema.optional(),
    tmuxSession: z.string().min(1).optional(),
    cwd: z.string().min(1).optional(),
  })
  .strict();
const LegacyFilesPaneSchema = z
  .object({
    id: IdentifierSchema,
    kind: z.literal("files"),
    title: z.string().min(1),
    hostId: IdentifierSchema,
    path: z.string().min(1),
    selectedPath: z.string().min(1).optional(),
  })
  .strict();
const LegacyPreviewPaneSchema = z
  .object({
    id: IdentifierSchema,
    kind: z.literal("preview"),
    title: z.string().min(1),
    hostId: IdentifierSchema,
    path: z.string().min(1),
    scrollOffset: z.number().int().min(0).default(0),
  })
  .strict();
const LegacyStartPaneSchema = z
  .object({
    id: IdentifierSchema,
    kind: z.literal("start"),
    title: z.string().min(1),
    surface: z.enum(["files", "terminal"]),
    hostId: IdentifierSchema.optional(),
  })
  .strict();
const LegacySessionPickerPaneSchema = z
  .object({
    id: IdentifierSchema,
    kind: z.literal("session-picker"),
    title: z.string().min(1),
    hostId: IdentifierSchema,
  })
  .strict();
const LegacyPaneV1Schema = z.discriminatedUnion("kind", [
  LegacyTerminalPaneSchema,
  LegacyFilesPaneSchema,
  LegacyPreviewPaneSchema,
]);
const LegacyPaneV2Schema = z.discriminatedUnion("kind", [
  LegacyTerminalPaneSchema,
  LegacyFilesPaneSchema,
  LegacyPreviewPaneSchema,
  LegacyStartPaneSchema,
  LegacySessionPickerPaneSchema,
]);

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
    panes: z.record(IdentifierSchema, LegacyPaneV1Schema),
    sidebar: SidebarSchema,
    updatedAt: z.string().datetime(),
  })
  .strict();
export const WorkspaceSnapshotV1Schema =
  WorkspaceSnapshotV1BaseSchema.superRefine(validateLegacyV1);

const WorkspaceTabV2Schema = z
  .object({
    id: IdentifierSchema,
    title: z.string().min(1),
    hostId: IdentifierSchema.optional(),
    activeSurface: z.enum(["files", "terminal"]),
    surfaces: z
      .object({ files: WorkspaceSurfaceSchema, terminal: WorkspaceSurfaceSchema })
      .strict(),
  })
  .strict();
const WorkspaceSnapshotV2BaseSchema = z
  .object({
    schemaVersion: z.literal(2),
    activeTabId: IdentifierSchema,
    tabs: z.array(WorkspaceTabV2Schema).min(1),
    panes: z.record(IdentifierSchema, LegacyPaneV2Schema),
    sidebar: SidebarSchema,
    updatedAt: z.string().datetime(),
  })
  .strict();
export const WorkspaceSnapshotV2Schema =
  WorkspaceSnapshotV2BaseSchema.superRefine(validateLegacyV2);

export type WorkspaceSurface = z.infer<typeof WorkspaceSurfaceSchema>;
export type WorkspaceTab = z.infer<typeof WorkspaceTabSchema>;
export type WorkspaceSnapshot = z.infer<typeof WorkspaceSnapshotSchema>;
export type WorkspaceSnapshotV1 = z.infer<typeof WorkspaceSnapshotV1Schema>;
export type WorkspaceSnapshotV2 = z.infer<typeof WorkspaceSnapshotV2Schema>;
export type WorkspaceSurfaceName = WorkspaceTab["activeSurface"];

export function createDefaultWorkspace(sidebarWidth = 28, homePath = homedir()): WorkspaceSnapshot {
  return createLocalWorkspace(sidebarWidth, homePath);
}

export function createLocalWorkspace(sidebarWidth = 28, homePath = homedir()): WorkspaceSnapshot {
  const filesPaneId = "pane-local-files-1";
  const terminalPaneId = "pane-local-terminal-1";
  const tabId = "tab-local";
  const target = { kind: "local" } as const;
  return WorkspaceSnapshotSchema.parse({
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    activeTabId: tabId,
    tabs: [
      {
        id: tabId,
        title: "Local",
        target,
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
        kind: "files",
        title: "Files",
        target,
        path: homePath,
      },
      [terminalPaneId]: {
        id: terminalPaneId,
        kind: "terminal",
        title: "Local shell",
        target,
        cwd: homePath,
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
  const terminalPaneId = `${options.tabId}-launcher`;
  const target = { kind: "ssh", hostId: options.hostId } as const;
  const panes: PaneState[] = [
    {
      id: filesPaneId,
      kind: "files",
      title: "Files",
      target,
      path: options.defaultPath,
    },
    {
      id: terminalPaneId,
      kind: "terminal-launcher",
      title: "Terminal",
      target,
    },
  ];
  return {
    tab: {
      id: options.tabId,
      title: options.title,
      target,
      activeSurface: "files",
      surfaces: {
        files: surfaceFor(filesPaneId),
        terminal: surfaceFor(terminalPaneId),
      },
    },
    panes,
  };
}

export function migrateWorkspaceV1(
  snapshot: WorkspaceSnapshotV1,
  homePath = homedir(),
): WorkspaceSnapshot {
  if (isPristineLocalWorkspaceV1(snapshot)) {
    const migrated = createLocalWorkspace(snapshot.sidebar.width, homePath);
    migrated.sidebar = structuredClone(snapshot.sidebar);
    migrated.updatedAt = snapshot.updatedAt;
    return WorkspaceSnapshotSchema.parse(migrated);
  }

  const panes: Record<string, PaneState> = {};
  const usedIds = new Set(Object.keys(snapshot.panes));
  const tabs: WorkspaceTab[] = snapshot.tabs.map((tab) => {
    const hostId = hostForLegacyLayout(tab.root, snapshot.panes);
    const target: WorkspaceTarget = hostId ? { kind: "ssh", hostId } : { kind: "local" };
    for (const paneId of collectLayoutPaneIds(tab.root)) {
      const pane = snapshot.panes[paneId];
      if (!pane) throw new Error(`Missing v1 pane ${paneId}`);
      panes[paneId] = convertLegacyPane(pane, target, homePath);
    }
    const activePane = snapshot.panes[tab.activePaneId];
    if (!activePane) throw new Error(`Missing active v1 pane ${tab.activePaneId}`);
    const activeSurface: WorkspaceSurfaceName =
      activePane.kind === "terminal" ? "terminal" : "files";
    const otherSurface: WorkspaceSurfaceName = activeSurface === "files" ? "terminal" : "files";
    const placeholderId = uniqueMigrationPaneId(tab.id, otherSurface, usedIds);
    panes[placeholderId] = surfacePlaceholder(placeholderId, otherSurface, target, homePath);
    const preserved: WorkspaceSurface = {
      root: structuredClone(tab.root),
      activePaneId: tab.activePaneId,
      focusedPaneId: tab.activePaneId,
    };
    return {
      id: tab.id,
      title: tab.title,
      target,
      activeSurface,
      surfaces:
        activeSurface === "files"
          ? { files: preserved, terminal: surfaceFor(placeholderId) }
          : { files: surfaceFor(placeholderId), terminal: preserved },
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

export function migrateWorkspaceV2(
  snapshot: WorkspaceSnapshotV2,
  homePath = homedir(),
): WorkspaceSnapshot {
  const isPristineStart =
    snapshot.tabs.length === 1 &&
    snapshot.tabs[0]?.id === snapshot.activeTabId &&
    !snapshot.tabs[0]?.hostId &&
    Object.values(snapshot.panes).every((pane) => pane.kind === "start");
  if (isPristineStart) {
    const migrated = createLocalWorkspace(snapshot.sidebar.width, homePath);
    migrated.sidebar = structuredClone(snapshot.sidebar);
    migrated.updatedAt = snapshot.updatedAt;
    return WorkspaceSnapshotSchema.parse(migrated);
  }

  const panes: Record<string, PaneState> = {};
  const tabs: WorkspaceTab[] = snapshot.tabs.map((tab) => {
    const hostId = tab.hostId ?? hostForV2Tab(tab, snapshot.panes);
    const target: WorkspaceTarget = hostId ? { kind: "ssh", hostId } : { kind: "local" };
    for (const surfaceName of ["files", "terminal"] as const) {
      for (const paneId of collectLayoutPaneIds(tab.surfaces[surfaceName].root)) {
        const pane = snapshot.panes[paneId];
        if (!pane) throw new Error(`Missing v2 pane ${paneId}`);
        panes[paneId] = convertLegacyPane(pane, target, homePath);
      }
    }
    return {
      id: tab.id,
      title: target.kind === "local" && tab.title === "Start" ? "Local" : tab.title,
      target,
      activeSurface: tab.activeSurface,
      surfaces: structuredClone(tab.surfaces),
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

type LegacyPane = z.infer<typeof LegacyPaneV2Schema>;

function convertLegacyPane(
  pane: LegacyPane,
  fallbackTarget: WorkspaceTarget,
  homePath: string,
): PaneState {
  const target: WorkspaceTarget =
    "hostId" in pane && pane.hostId
      ? { kind: "ssh", hostId: pane.hostId }
      : structuredClone(fallbackTarget);
  switch (pane.kind) {
    case "terminal":
      return {
        id: pane.id,
        kind: "terminal",
        title: pane.title,
        target,
        ...(pane.tmuxSession ? { tmuxSession: pane.tmuxSession } : {}),
        ...(pane.cwd ? { cwd: pane.cwd } : {}),
      };
    case "files":
      return {
        id: pane.id,
        kind: "files",
        title: pane.title,
        target,
        path: pane.path,
        ...(pane.selectedPath ? { selectedPath: pane.selectedPath } : {}),
      };
    case "preview":
      return {
        id: pane.id,
        kind: "preview",
        title: pane.title,
        target,
        path: pane.path,
        scrollOffset: pane.scrollOffset,
      };
    case "session-picker": {
      const remote = sshTarget(target, pane.hostId);
      return {
        id: pane.id,
        kind: "terminal-launcher",
        title: "Terminal",
        target: remote,
      };
    }
    case "start":
      return surfacePlaceholder(pane.id, pane.surface, target, homePath);
  }
}

function surfacePlaceholder(
  id: string,
  surface: WorkspaceSurfaceName,
  target: WorkspaceTarget,
  homePath: string,
): PaneState {
  if (surface === "files") {
    return {
      id,
      kind: "files",
      title: "Files",
      target,
      path: target.kind === "local" ? homePath : ".",
    };
  }
  if (target.kind === "ssh") {
    return { id, kind: "terminal-launcher", title: "Terminal", target };
  }
  return { id, kind: "terminal", title: "Local shell", target, cwd: homePath };
}

function sshTarget(
  target: WorkspaceTarget,
  hostId?: string,
): Extract<WorkspaceTarget, { kind: "ssh" }> {
  if (hostId) return { kind: "ssh", hostId };
  if (target.kind === "ssh") return target;
  throw new Error("Remote pane is missing its SSH host id");
}

function isPristineLocalWorkspaceV1(snapshot: WorkspaceSnapshotV1): boolean {
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
  return {
    root: { type: "pane", paneId },
    activePaneId: paneId,
    focusedPaneId: paneId,
  };
}

function collectLayoutPaneIds(node: LayoutNode): string[] {
  return node.type === "pane"
    ? [node.paneId]
    : [...collectLayoutPaneIds(node.first), ...collectLayoutPaneIds(node.second)];
}

function hostForLegacyLayout(
  root: LayoutNode,
  panes: Readonly<Record<string, LegacyPane>>,
): string | undefined {
  return collectLayoutPaneIds(root)
    .map((paneId) => panes[paneId])
    .find((pane) => pane && "hostId" in pane && pane.hostId)?.hostId;
}

function hostForV2Tab(
  tab: z.infer<typeof WorkspaceTabV2Schema>,
  panes: Readonly<Record<string, LegacyPane>>,
): string | undefined {
  for (const surface of [tab.surfaces.files, tab.surfaces.terminal]) {
    const hostId = hostForLegacyLayout(surface.root, panes);
    if (hostId) return hostId;
  }
  return undefined;
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

function validateLegacyV1(
  snapshot: z.infer<typeof WorkspaceSnapshotV1BaseSchema>,
  context: z.core.$RefinementCtx,
): void {
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
}

function validateLegacyV2(
  snapshot: z.infer<typeof WorkspaceSnapshotV2BaseSchema>,
  context: z.core.$RefinementCtx,
): void {
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
