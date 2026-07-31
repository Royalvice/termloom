import { BoxRenderable, type CliRenderer, type Renderable } from "@opentui/core";
import type { ReconnectConfig } from "../config/schema.js";
import { RemoteTerminalRenderable } from "../connection/remote-terminal-renderable.js";
import type { PaneState, WorkspaceSnapshot } from "../workspace/schema.js";
import type { PaneViewFactory } from "./pane-factory.js";
import { FileBrowserRenderable, type FileBrowserCommand } from "./file-browser-renderable.js";
import { RichDocumentRenderable, type RichDocumentServices } from "./rich-document-renderable.js";
import { theme } from "./theme.js";

interface PaneView {
  state: PaneState;
  frame: BoxRenderable;
  content: Renderable;
}

export class PaneRegistry {
  private readonly views = new Map<string, PaneView>();

  public constructor(
    private readonly renderer: CliRenderer,
    private readonly factory: PaneViewFactory,
    private readonly onFocusPane: (paneId: string) => void,
  ) {}

  public frame(pane: PaneState): BoxRenderable {
    const existing = this.views.get(pane.id);
    if (existing) {
      if (paneIdentity(existing.state) !== paneIdentity(pane)) {
        existing.frame.destroyRecursively();
        this.views.delete(pane.id);
        return this.frame(pane);
      }
      existing.state = pane;
      existing.frame.title = pane.title;
      return existing.frame;
    }
    const content = this.factory.create(pane);
    const frame = new BoxRenderable(this.renderer, {
      id: `frame-${pane.id}`,
      title: pane.title,
      titleColor: theme.foreground,
      border: true,
      borderStyle: "rounded",
      borderColor: theme.border,
      focusedBorderColor: theme.activeBorder,
      focusable: true,
      width: "100%",
      height: "100%",
      overflow: "hidden",
      backgroundColor: theme.background,
      onMouseDown: () => this.onFocusPane(pane.id),
    });
    frame.add(content);
    this.views.set(pane.id, { state: pane, frame, content });
    return frame;
  }

  public detachAll(): void {
    for (const view of this.views.values()) view.frame.parent?.remove(view.frame);
  }

  public reconcile(snapshot: WorkspaceSnapshot): void {
    for (const [paneId, view] of this.views) {
      if (snapshot.panes[paneId]) continue;
      view.frame.destroyRecursively();
      this.views.delete(paneId);
    }
  }

  public focus(paneId: string): void {
    for (const [id, view] of this.views) {
      view.frame.borderColor = id === paneId ? theme.activeBorder : theme.border;
    }
    const target = this.views.get(paneId);
    if (!target) return;
    if (target.content.focusable) target.content.focus();
    else target.frame.focus();
  }

  public owns(renderable: Renderable): boolean {
    for (const view of this.views.values()) {
      if (view.frame === renderable) return true;
    }
    return false;
  }

  public terminal(
    paneId: string,
  ): import("../terminal/terminal-renderable.js").TerminalRenderable | null {
    const content = this.views.get(paneId)?.content;
    return isTerminalRenderable(content) ? content : null;
  }

  public hasPlayingMedia(): boolean {
    for (const view of this.views.values()) {
      if (view.content instanceof RichDocumentRenderable && view.content.hasPlayingMedia())
        return true;
    }
    return false;
  }

  public fileCommands(paneId: string): FileBrowserCommand[] {
    const content = this.views.get(paneId)?.content;
    return content instanceof FileBrowserRenderable ? content.contextCommands() : [];
  }

  public fileBrowser(paneId: string): FileBrowserRenderable | null {
    const content = this.views.get(paneId)?.content;
    return content instanceof FileBrowserRenderable ? content : null;
  }

  public async refreshHost(hostId: string): Promise<void> {
    const refreshes: Promise<void>[] = [];
    for (const view of this.views.values()) {
      if (view.state.target.kind !== "ssh" || view.state.target.hostId !== hostId) continue;
      if (
        (view.state.kind === "files" || view.state.kind === "session-picker") &&
        hasRefresh(view.content)
      ) {
        refreshes.push(Promise.resolve(view.content.refresh()));
      }
    }
    await Promise.all(refreshes);
  }

  public async applyRuntimeConfig(
    reconnect: ReconnectConfig,
    preview?: RichDocumentServices,
  ): Promise<void> {
    this.factory.updateRuntimeConfig?.(reconnect, preview);
    const reloads: Promise<void>[] = [];
    for (const view of this.views.values()) {
      if (view.content instanceof RemoteTerminalRenderable) {
        view.content.updateReconnectConfig(reconnect);
      } else if (preview && view.content instanceof RichDocumentRenderable) {
        reloads.push(view.content.applyServices(preview));
      }
    }
    await Promise.all(reloads);
  }

  public refreshAppearance(): void {
    for (const view of this.views.values()) {
      view.frame.backgroundColor = theme.background;
      view.frame.borderColor = theme.border;
      view.frame.focusedBorderColor = theme.activeBorder;
      view.frame.titleColor = theme.foreground;
      const content = view.content as Renderable & { refreshAppearance?: () => void };
      content.refreshAppearance?.();
    }
  }

  public destroy(): void {
    for (const view of this.views.values()) view.frame.destroyRecursively();
    this.views.clear();
  }
}

function hasRefresh(
  renderable: Renderable,
): renderable is Renderable & { refresh(): Promise<void> | void } {
  return "refresh" in renderable && typeof renderable.refresh === "function";
}

function paneIdentity(pane: PaneState): string {
  switch (pane.kind) {
    case "terminal":
      return [pane.kind, targetIdentity(pane.target), pane.tmuxSession, pane.cwd].join("\0");
    case "files":
      return [pane.kind, targetIdentity(pane.target)].join("\0");
    case "preview":
      return [pane.kind, targetIdentity(pane.target), pane.path].join("\0");
    case "session-picker":
      return [pane.kind, targetIdentity(pane.target)].join("\0");
    case "terminal-launcher":
      return [pane.kind, targetIdentity(pane.target)].join("\0");
    case "start":
      return [pane.kind, pane.surface, targetIdentity(pane.target)].join("\0");
  }
}

function targetIdentity(target: PaneState["target"]): string {
  return target.kind === "local" ? "local" : `ssh:${target.hostId}`;
}

function isTerminalRenderable(
  renderable: Renderable | undefined,
): renderable is import("../terminal/terminal-renderable.js").TerminalRenderable {
  return Boolean(renderable && "sendInput" in renderable && "terminal" in renderable);
}
