import { z } from "zod";

export const WORKSPACE_SCHEMA_VERSION = 1;

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

export const PaneSchema = z.discriminatedUnion("kind", [
  TerminalPaneSchema,
  FilesPaneSchema,
  PreviewPaneSchema,
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

export const WorkspaceTabSchema = z
  .object({
    id: IdentifierSchema,
    title: z.string().min(1),
    root: LayoutNodeSchema,
    activePaneId: IdentifierSchema,
  })
  .strict();

export const WorkspaceSnapshotSchema = z
  .object({
    schemaVersion: z.literal(WORKSPACE_SCHEMA_VERSION),
    activeTabId: IdentifierSchema,
    tabs: z.array(WorkspaceTabSchema).min(1),
    panes: z.record(IdentifierSchema, PaneSchema),
    sidebar: z
      .object({
        visible: z.boolean(),
        width: z.number().int().min(18).max(60),
        section: z.enum(["hosts", "sessions", "files"]),
      })
      .strict(),
    updatedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((snapshot, context) => {
    if (!snapshot.tabs.some((tab) => tab.id === snapshot.activeTabId)) {
      context.addIssue({ code: "custom", message: "activeTabId does not reference a tab" });
    }
    const referenced = new Set<string>();
    const visit = (node: LayoutNode, local: Set<string>) => {
      if (node.type === "pane") {
        if (referenced.has(node.paneId)) {
          context.addIssue({ code: "custom", message: `Pane ${node.paneId} is referenced twice` });
        }
        referenced.add(node.paneId);
        local.add(node.paneId);
      } else {
        visit(node.first, local);
        visit(node.second, local);
      }
    };
    for (const tab of snapshot.tabs) {
      const local = new Set<string>();
      visit(tab.root, local);
      if (!local.has(tab.activePaneId)) {
        context.addIssue({
          code: "custom",
          message: `Tab ${tab.id} activePaneId does not reference its layout`,
        });
      }
    }
    for (const paneId of referenced) {
      if (!snapshot.panes[paneId]) {
        context.addIssue({ code: "custom", message: `Layout references missing pane ${paneId}` });
      }
    }
    for (const paneId of Object.keys(snapshot.panes)) {
      if (!referenced.has(paneId)) {
        context.addIssue({ code: "custom", message: `Unreferenced pane ${paneId}` });
      }
    }
  });

export type WorkspaceTab = z.infer<typeof WorkspaceTabSchema>;
export type WorkspaceSnapshot = z.infer<typeof WorkspaceSnapshotSchema>;

export function createDefaultWorkspace(sidebarWidth = 28): WorkspaceSnapshot {
  const paneId = "pane-local-1";
  const tabId = "tab-1";
  return WorkspaceSnapshotSchema.parse({
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    activeTabId: tabId,
    tabs: [
      {
        id: tabId,
        title: "Local",
        root: { type: "pane", paneId },
        activePaneId: paneId,
      },
    ],
    panes: {
      [paneId]: { id: paneId, kind: "terminal", title: "Local shell" },
    },
    sidebar: { visible: true, width: sidebarWidth, section: "hosts" },
    updatedAt: new Date().toISOString(),
  });
}
