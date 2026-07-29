import {
  BoxRenderable,
  CliRenderEvents,
  type CliRenderer,
  type KeyEvent,
  MouseButton,
  TextAttributes,
  TextRenderable,
} from "@opentui/core";
import { theme } from "./theme.js";

export interface ContextMenuAction {
  id: string;
  label: string;
  shortcut?: string;
  disabled?: boolean;
  run: () => void;
}

export interface ContextMenuRequest {
  x: number;
  y: number;
  title?: string;
  actions: readonly ContextMenuAction[];
}

export class DismissibleOverlayController {
  private contextMenu: ContextMenuOverlay | undefined;
  private restoreFocus: (() => void) | undefined;
  private readonly dismissForResize = () => this.dismiss();
  private readonly dismissForBlur = () => this.dismiss();

  public constructor(
    private readonly renderer: CliRenderer,
    private readonly root: BoxRenderable,
  ) {
    renderer.on(CliRenderEvents.RESIZE, this.dismissForResize);
    renderer.on(CliRenderEvents.BLUR, this.dismissForBlur);
  }

  public get isOpen(): boolean {
    return Boolean(this.contextMenu);
  }

  public openContextMenu(request: ContextMenuRequest, restoreFocus: () => void): void {
    if (this.contextMenu) {
      this.dismiss();
      return;
    }
    const menu = new ContextMenuOverlay(this.renderer, {
      ...request,
      viewportWidth: this.renderer.width,
      viewportHeight: this.renderer.height,
      onDismiss: () => this.dismiss(),
      onRun: (action) => {
        this.dismiss();
        action.run();
      },
    });
    this.contextMenu = menu;
    this.restoreFocus = restoreFocus;
    this.root.add(menu);
    menu.focus();
    this.renderer.requestRender();
  }

  public dismiss(options: { restoreFocus?: boolean } = {}): void {
    const menu = this.contextMenu;
    if (!menu) return;
    const restore = this.restoreFocus;
    this.contextMenu = undefined;
    this.restoreFocus = undefined;
    if (menu.parent === this.root) this.root.remove(menu);
    menu.destroyRecursively();
    if (options.restoreFocus !== false) restore?.();
    this.renderer.requestRender();
  }

  public destroy(): void {
    this.dismiss({ restoreFocus: false });
    this.renderer.off(CliRenderEvents.RESIZE, this.dismissForResize);
    this.renderer.off(CliRenderEvents.BLUR, this.dismissForBlur);
  }
}

interface ContextMenuOverlayOptions extends ContextMenuRequest {
  viewportWidth: number;
  viewportHeight: number;
  onDismiss: () => void;
  onRun: (action: ContextMenuAction) => void;
}

class ContextMenuOverlay extends BoxRenderable {
  private selectedIndex = 0;
  private readonly rows: TextRenderable[] = [];
  private readonly actions: readonly ContextMenuAction[];
  private readonly onDismissValue: () => void;
  private readonly onRunValue: (action: ContextMenuAction) => void;

  public constructor(renderer: CliRenderer, options: ContextMenuOverlayOptions) {
    super(renderer, {
      id: `context-overlay-${crypto.randomUUID()}`,
      position: "absolute",
      left: 0,
      top: 0,
      width: "100%",
      height: "100%",
      zIndex: 1_000,
      focusable: true,
      onMouseDown: (event) => {
        options.onDismiss();
        event.preventDefault();
        event.stopPropagation();
      },
    });
    this.actions = options.actions;
    this.onDismissValue = options.onDismiss;
    this.onRunValue = options.onRun;
    this.selectedIndex = Math.max(
      0,
      options.actions.findIndex((action) => !action.disabled),
    );
    const widestAction = options.actions.reduce(
      (maximum, action) =>
        Math.max(maximum, action.label.length + (action.shortcut ? action.shortcut.length + 3 : 0)),
      0,
    );
    const menuWidth = Math.max(22, Math.min(48, widestAction + 4));
    const menuHeight = Math.max(3, options.actions.length + 2);
    const left = clamp(options.x, 0, Math.max(0, options.viewportWidth - menuWidth));
    const top = clamp(options.y, 0, Math.max(0, options.viewportHeight - menuHeight));
    const menu = new BoxRenderable(renderer, {
      id: `${this.id}-menu`,
      position: "absolute",
      left,
      top,
      width: menuWidth,
      height: menuHeight,
      zIndex: 1,
      flexDirection: "column",
      border: true,
      borderStyle: "rounded",
      borderColor: theme.accent,
      title: options.title ? ` ${options.title} ` : undefined,
      backgroundColor: theme.surfaceRaised,
      onMouseDown: (event) => {
        event.preventDefault();
        event.stopPropagation();
      },
    });
    options.actions.forEach((action, index) => {
      const row = new TextRenderable(renderer, {
        id: `${this.id}-action-${action.id}`,
        height: 1,
        width: "100%",
        content: actionLabel(action, menuWidth - 2),
        fg: action.disabled ? theme.muted : theme.foreground,
        bg: theme.surfaceRaised,
        attributes: action.disabled ? TextAttributes.DIM : undefined,
        onMouseOver: () => {
          if (action.disabled) return;
          this.selectedIndex = index;
          this.updateRows();
          renderer.setMousePointer("pointer");
        },
        onMouseOut: () => renderer.setMousePointer("default"),
        onMouseDown: (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (event.button === MouseButton.RIGHT) {
            options.onDismiss();
            return;
          }
          if (event.button !== MouseButton.LEFT || action.disabled) return;
          this.selectedIndex = index;
          options.onRun(action);
        },
      });
      this.rows.push(row);
      menu.add(row);
    });
    this.add(menu);
    this.updateRows();
  }

  public override handleKeyPress(key: KeyEvent): boolean {
    if (key.eventType === "release") return false;
    if (key.name === "escape") {
      this.onDismissValue();
      return true;
    }
    if (key.name === "up" || key.name === "k") {
      this.move(-1);
      return true;
    }
    if (key.name === "down" || key.name === "j") {
      this.move(1);
      return true;
    }
    if (key.name === "return") {
      const action = this.actions[this.selectedIndex];
      if (action && !action.disabled) this.onRunValue(action);
      return true;
    }
    return false;
  }

  private move(offset: number): void {
    if (!this.actions.some((action) => !action.disabled)) return;
    let next = this.selectedIndex;
    do {
      next = (next + offset + this.actions.length) % this.actions.length;
    } while (this.actions[next]?.disabled);
    this.selectedIndex = next;
    this.updateRows();
  }

  private updateRows(): void {
    this.rows.forEach((row, index) => {
      const selected = index === this.selectedIndex && !this.actions[index]?.disabled;
      row.bg = selected ? theme.selection : theme.surfaceRaised;
      row.fg = this.actions[index]?.disabled
        ? theme.muted
        : selected
          ? theme.accent
          : theme.foreground;
    });
    this.requestRender();
  }
}

function actionLabel(action: ContextMenuAction, width: number): string {
  const shortcut = action.shortcut ?? "";
  const available = Math.max(1, width - shortcut.length - (shortcut ? 1 : 0));
  const label =
    action.label.length > available ? `${action.label.slice(0, available - 1)}…` : action.label;
  return ` ${label.padEnd(available)}${shortcut ? ` ${shortcut}` : ""}`.slice(0, width);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, Math.floor(value)));
}
