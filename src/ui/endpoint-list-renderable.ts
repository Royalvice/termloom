import {
  bg,
  bold,
  BoxRenderable,
  dim,
  fg,
  type KeyEvent,
  MouseButton,
  type RenderContext,
  ScrollBoxRenderable,
  t,
  TextRenderable,
} from "@opentui/core";
import type { HostConnectionStatus } from "../ssh/host-catalog.js";
import { theme } from "./theme.js";

export type EndpointListItem =
  | {
      key: "local";
      kind: "local";
      label: string;
    }
  | {
      key: string;
      kind: "ssh";
      label: string;
      alias: string;
      status: HostConnectionStatus;
      missing: boolean;
    };

export interface EndpointListRenderableOptions {
  id: string;
  items?: readonly EndpointListItem[];
  onSelection?: (index: number, item: EndpointListItem | undefined) => void;
  onActivate?: (index: number, item: EndpointListItem) => void;
  onContextMenu?: (index: number, item: EndpointListItem, event: { x: number; y: number }) => void;
}

export interface EndpointStatusVisual {
  marker: string;
  label: string;
  color: string;
}

export class EndpointListRenderable extends BoxRenderable {
  private readonly scroll: ScrollBoxRenderable;
  private readonly rows: TextRenderable[] = [];
  private itemsValue: readonly EndpointListItem[];
  private selectedIndex = 0;
  private hoveredIndex: number | undefined;
  private columnWidth = 28;
  private readonly onSelectionValue:
    | ((index: number, item: EndpointListItem | undefined) => void)
    | undefined;
  private readonly onActivateValue: ((index: number, item: EndpointListItem) => void) | undefined;
  private readonly onContextMenuValue:
    | ((index: number, item: EndpointListItem, event: { x: number; y: number }) => void)
    | undefined;

  public constructor(ctx: RenderContext, options: EndpointListRenderableOptions) {
    super(ctx, {
      id: options.id,
      width: "100%",
      flexGrow: 1,
      minHeight: 1,
      flexDirection: "column",
      focusable: true,
      backgroundColor: theme.surface,
      overflow: "hidden",
    });
    this.itemsValue = options.items ?? [];
    this.onSelectionValue = options.onSelection;
    this.onActivateValue = options.onActivate;
    this.onContextMenuValue = options.onContextMenu;
    this.scroll = new ScrollBoxRenderable(ctx, {
      id: `${options.id}-scroll`,
      width: "100%",
      height: "100%",
      scrollY: true,
      scrollX: false,
      viewportCulling: true,
      rootOptions: { backgroundColor: theme.surface },
      contentOptions: { flexDirection: "column", width: "100%" },
    });
    this.scroll.verticalScrollBar.visible = false;
    this.add(this.scroll);
    this.rebuildRows();
  }

  public get items(): readonly EndpointListItem[] {
    return this.itemsValue;
  }

  public get selected(): EndpointListItem | undefined {
    return this.itemsValue[this.selectedIndex];
  }

  public getSelectedIndex(): number {
    return this.selectedIndex;
  }

  public setSelectedIndex(index: number, notify = false): void {
    if (this.itemsValue.length === 0) {
      this.selectedIndex = 0;
      return;
    }
    const next = Math.max(0, Math.min(this.itemsValue.length - 1, index));
    if (next === this.selectedIndex) return;
    this.selectedIndex = next;
    this.updateRows();
    this.scroll.scrollChildIntoView(`${this.id}-row-${this.selectedIndex}`);
    if (notify) this.onSelectionValue?.(this.selectedIndex, this.selected);
  }

  public setItems(items: readonly EndpointListItem[], selectedKey?: string): void {
    this.itemsValue = items;
    const selected = selectedKey
      ? items.findIndex((item) => item.key === selectedKey)
      : Math.min(this.selectedIndex, Math.max(0, items.length - 1));
    this.selectedIndex = Math.max(0, selected);
    this.hoveredIndex = undefined;
    this.rebuildRows();
  }

  public move(offset: number): void {
    this.setSelectedIndex(this.selectedIndex + offset, true);
  }

  public activate(): void {
    const selected = this.selected;
    if (selected) this.onActivateValue?.(this.selectedIndex, selected);
  }

  public refreshAppearance(): void {
    this.backgroundColor = theme.surface;
    this.scroll.backgroundColor = theme.surface;
    this.updateRows();
  }

  public override handleKeyPress(key: KeyEvent): boolean {
    if (key.eventType === "release" || key.ctrl || key.meta || key.super) return false;
    if (key.name === "up" || key.name === "k") {
      this.move(-1);
      return true;
    }
    if (key.name === "down" || key.name === "j") {
      this.move(1);
      return true;
    }
    if (key.name === "pageup") {
      this.move(-Math.max(1, this.height - 1));
      return true;
    }
    if (key.name === "pagedown") {
      this.move(Math.max(1, this.height - 1));
      return true;
    }
    if (key.name === "home") {
      this.setSelectedIndex(0, true);
      return true;
    }
    if (key.name === "end") {
      this.setSelectedIndex(this.itemsValue.length - 1, true);
      return true;
    }
    if (key.name === "return") {
      this.activate();
      return true;
    }
    return false;
  }

  protected override onResize(width: number, height: number): void {
    super.onResize(width, height);
    const next = Math.max(12, width);
    if (next === this.columnWidth) return;
    this.columnWidth = next;
    this.updateRows();
  }

  private rebuildRows(): void {
    for (const row of this.rows.splice(0)) {
      if (row.parent === this.scroll) this.scroll.remove(row);
      row.destroyRecursively();
    }
    if (this.itemsValue.length === 0) {
      const empty = new TextRenderable(this.ctx, {
        id: `${this.id}-empty`,
        width: "100%",
        height: 1,
        content: "  No SSH hosts found",
        fg: theme.muted,
        selectable: false,
      });
      this.rows.push(empty);
      this.scroll.add(empty);
      this.requestRender();
      return;
    }
    this.itemsValue.forEach((item, index) => {
      const row = new TextRenderable(this.ctx, {
        id: `${this.id}-row-${index}`,
        width: "100%",
        height: 1,
        content: endpointRowContent(item, this.columnWidth, index === this.selectedIndex),
        bg: index === this.selectedIndex ? theme.selectionStrong : theme.surface,
        selectable: false,
        onMouseOver: () => {
          this.hoveredIndex = index;
          this.updateRows();
          this.ctx.setMousePointer("pointer");
        },
        onMouseOut: () => {
          if (this.hoveredIndex === index) {
            this.hoveredIndex = undefined;
            this.updateRows();
          }
          this.ctx.setMousePointer("default");
        },
        onMouseDown: (event) => {
          this.setSelectedIndex(index, true);
          this.focus();
          if (event.button === MouseButton.RIGHT) {
            this.onContextMenuValue?.(index, item, { x: event.x, y: event.y });
          } else if (event.button === MouseButton.LEFT) {
            this.onActivateValue?.(index, item);
          } else {
            return;
          }
          event.preventDefault();
          event.stopPropagation();
        },
      });
      this.rows.push(row);
      this.scroll.add(row);
    });
    this.updateRows();
  }

  private updateRows(): void {
    this.rows.forEach((row, index) => {
      const item = this.itemsValue[index];
      if (!item) {
        row.bg = theme.surface;
        return;
      }
      const selected = index === this.selectedIndex;
      row.content = endpointRowContent(item, this.columnWidth, selected);
      row.bg = selected
        ? theme.selectionStrong
        : index === this.hoveredIndex
          ? theme.selection
          : theme.surface;
    });
    this.requestRender();
  }
}

export function endpointStatusVisual(item: EndpointListItem): EndpointStatusVisual {
  if (item.kind === "local") return { marker: "◆", label: "LOCAL", color: theme.accentSecondary };
  if (item.missing) return { marker: "!", label: "ERROR", color: theme.error };
  switch (item.status) {
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

function endpointRowContent(item: EndpointListItem, width: number, selected: boolean) {
  const visual = endpointStatusVisual(item);
  const selection = selected ? fg(theme.accent)("▌") : " ";
  if (item.kind === "local") {
    const type = bg(visual.color)(fg(theme.background)(bold(" LOCAL ")));
    const label = bold(fg(theme.foreground)(truncate(item.label, Math.max(1, width - 10))));
    return t`${selection}${type} ${label}`;
  }

  const type = bg(theme.accent)(fg(theme.background)(bold(" SSH ")));
  const status = fg(visual.color)(bold(`${visual.marker} ${visual.label.padEnd(5)}`));
  const prefixWidth = 16;
  const available = Math.max(1, width - prefixWidth);
  const showAlias =
    width >= 42 && item.label.toLocaleLowerCase() !== item.alias.toLocaleLowerCase();
  if (!showAlias) {
    const label = bold(fg(theme.foreground)(truncate(item.label, available)));
    return t`${selection}${type} ${status} ${label}`;
  }
  const aliasBudget = Math.max(6, Math.floor(available * 0.42));
  const labelBudget = Math.max(4, available - aliasBudget - 3);
  const label = bold(fg(theme.foreground)(truncate(item.label, labelBudget)));
  const alias = dim(fg(theme.muted)(` · ${truncate(item.alias, aliasBudget)}`));
  return t`${selection}${type} ${status} ${label}${alias}`;
}

function truncate(value: string, width: number): string {
  return value.length <= width ? value : `${value.slice(0, Math.max(0, width - 1))}…`;
}
