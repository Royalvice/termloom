import {
  BoxRenderable,
  MouseButton,
  type RenderContext,
  TextAttributes,
  TextRenderable,
} from "@opentui/core";
import type { HostConnectionStatus } from "../ssh/host-catalog.js";
import { theme } from "./theme.js";

export interface WorkspaceContextState {
  kind: "local" | "ssh";
  label: string;
  status: HostConnectionStatus | "local";
  missing?: boolean;
  index: number;
  total: number;
}

export interface WorkspaceContextBarOptions {
  id: string;
  onPrevious: () => void;
  onNext: () => void;
  onAdd: () => void;
  onClose: () => void;
}

export class WorkspaceContextBarRenderable extends BoxRenderable {
  private readonly typeBadge: TextRenderable;
  private readonly nameLabel: TextRenderable;
  private readonly statusBadge: TextRenderable;
  private readonly previousButton: TextRenderable;
  private readonly positionLabel: TextRenderable;
  private readonly nextButton: TextRenderable;
  private readonly addButton: TextRenderable;
  private readonly closeButton: TextRenderable;
  private stateValue: WorkspaceContextState = {
    kind: "local",
    label: "This Mac",
    status: "local",
    index: 0,
    total: 1,
  };

  public constructor(ctx: RenderContext, options: WorkspaceContextBarOptions) {
    super(ctx, {
      id: options.id,
      width: "100%",
      height: 1,
      flexDirection: "row",
      backgroundColor: theme.surface,
      overflow: "hidden",
    });
    this.typeBadge = new TextRenderable(ctx, {
      id: `${options.id}-type`,
      width: 7,
      height: 1,
      content: " LOCAL ",
      fg: theme.background,
      bg: theme.accentSecondary,
      attributes: TextAttributes.BOLD,
      selectable: false,
    });
    this.nameLabel = new TextRenderable(ctx, {
      id: `${options.id}-name`,
      flexGrow: 1,
      minWidth: 1,
      height: 1,
      content: " This Mac",
      fg: theme.foreground,
      bg: theme.surface,
      attributes: TextAttributes.BOLD,
      selectable: false,
      overflow: "hidden",
    });
    this.statusBadge = new TextRenderable(ctx, {
      id: `${options.id}-status`,
      width: 10,
      height: 1,
      content: "◆ ON MAC",
      fg: theme.accentSecondary,
      bg: theme.surface,
      attributes: TextAttributes.BOLD,
      selectable: false,
    });
    this.previousButton = this.button(`${options.id}-previous`, " ‹ ", options.onPrevious);
    this.positionLabel = new TextRenderable(ctx, {
      id: `${options.id}-position`,
      width: 7,
      height: 1,
      content: " 1 / 1 ",
      fg: theme.muted,
      bg: theme.surfaceRaised,
      selectable: false,
    });
    this.nextButton = this.button(`${options.id}-next`, " › ", options.onNext);
    this.addButton = this.button(`${options.id}-add`, " + ", options.onAdd);
    this.closeButton = this.button(`${options.id}-close`, " × ", options.onClose);

    this.add(this.typeBadge);
    this.add(this.nameLabel);
    this.add(this.statusBadge);
    this.add(this.previousButton);
    this.add(this.positionLabel);
    this.add(this.nextButton);
    this.add(this.addButton);
    this.add(this.closeButton);
    this.updateContent();
  }

  public setState(state: WorkspaceContextState): void {
    this.stateValue = { ...state };
    this.updateContent();
  }

  public refreshAppearance(): void {
    this.backgroundColor = theme.surface;
    this.nameLabel.bg = theme.surface;
    this.statusBadge.bg = theme.surface;
    this.positionLabel.bg = theme.surfaceRaised;
    for (const button of [this.previousButton, this.nextButton, this.addButton, this.closeButton]) {
      button.bg = theme.surfaceRaised;
    }
    this.updateContent();
  }

  protected override onResize(width: number, height: number): void {
    super.onResize(width, height);
    this.nameLabel.visible = width >= 34;
    this.addButton.visible = width >= 42;
    this.previousButton.visible = width >= 29;
    this.nextButton.visible = width >= 29;
    this.positionLabel.width = width >= 38 ? 7 : 5;
    this.updateContent();
  }

  private updateContent(): void {
    const state = this.stateValue;
    const visual = workspaceStatusVisual(state.status, state.missing ?? false);
    const local = state.kind === "local";
    this.typeBadge.content = local ? " LOCAL " : " SSH   ";
    this.typeBadge.bg = local ? theme.accentSecondary : theme.accent;
    this.typeBadge.fg = theme.background;
    this.nameLabel.content = ` ${state.label}`;
    this.nameLabel.fg = theme.foreground;
    this.statusBadge.content = `${visual.marker} ${visual.label.padEnd(6)} `;
    this.statusBadge.fg = visual.color;
    const current = Math.max(1, Math.min(state.total, state.index + 1));
    this.positionLabel.content =
      this.positionLabel.width >= 7 ? ` ${current} / ${state.total} ` : `${current}/${state.total}`;
    const canCycle = state.total > 1;
    this.previousButton.fg = canCycle ? theme.accent : theme.muted;
    this.nextButton.fg = canCycle ? theme.accent : theme.muted;
    this.addButton.fg = theme.accent;
    this.closeButton.fg = state.total > 1 ? theme.error : theme.muted;
    this.requestRender();
  }

  private button(id: string, content: string, run: () => void): TextRenderable {
    const button = new TextRenderable(this.ctx, {
      id,
      width: 3,
      height: 1,
      content,
      fg: theme.accent,
      bg: theme.surfaceRaised,
      attributes: TextAttributes.BOLD,
      selectable: false,
      onMouseDown: (event) => {
        if (event.button !== MouseButton.LEFT) return;
        run();
        event.preventDefault();
        event.stopPropagation();
      },
    });
    button.onMouseOver = () => {
      button.bg = theme.selection;
      this.ctx.setMousePointer("pointer");
    };
    button.onMouseOut = () => {
      button.bg = theme.surfaceRaised;
      this.ctx.setMousePointer("default");
    };
    return button;
  }
}

export function workspaceStatusVisual(
  status: HostConnectionStatus | "local",
  missing = false,
): { marker: string; label: string; color: string } {
  if (missing) return { marker: "!", label: "ERROR", color: theme.error };
  switch (status) {
    case "local":
      return { marker: "◆", label: "ON MAC", color: theme.accentSecondary };
    case "connected":
      return { marker: "●", label: "READY", color: theme.success };
    case "authenticating":
      return { marker: "◐", label: "AUTH", color: theme.warning };
    case "resolving":
      return { marker: "◌", label: "LOAD", color: theme.accent };
    case "reconnecting":
      return { marker: "◌", label: "RETRY", color: theme.warning };
    case "error":
      return { marker: "!", label: "ERROR", color: theme.error };
    case "idle":
      return { marker: "○", label: "IDLE", color: theme.muted };
  }
}
