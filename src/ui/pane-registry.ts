import { BoxRenderable, type CliRenderer, type Renderable } from "@opentui/core";
import type { PaneState, WorkspaceSnapshot } from "../workspace/schema.js";
import type { PaneViewFactory } from "./pane-factory.js";
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

  public destroy(): void {
    for (const view of this.views.values()) view.frame.destroyRecursively();
    this.views.clear();
  }
}

function isTerminalRenderable(
  renderable: Renderable | undefined,
): renderable is import("../terminal/terminal-renderable.js").TerminalRenderable {
  return Boolean(renderable && "sendInput" in renderable && "terminal" in renderable);
}
