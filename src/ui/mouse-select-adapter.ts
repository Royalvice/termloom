import {
  MouseButton,
  type MouseEvent,
  type SelectRenderable,
  type TabSelectRenderable,
} from "@opentui/core";

export interface MouseSelectAdapterOptions {
  onClick?: (index: number, event: MouseEvent) => void;
  onDoubleClick?: (index: number, event: MouseEvent) => void;
  onContextMenu?: (index: number, event: MouseEvent) => void;
  doubleClickMs?: number;
}

interface SelectInternals {
  scrollOffset: number;
  linesPerItem: number;
}

interface TabInternals {
  scrollOffset: number;
}

export function attachMouseSelect(
  select: SelectRenderable,
  options: MouseSelectAdapterOptions = {},
): () => void {
  let lastClick = { index: -1, row: -1, at: 0 };
  select.onMouseDown = (event) => {
    const hit = selectIndexAt(select, event);
    if (!hit) return;
    if (event.button === MouseButton.RIGHT) {
      select.setSelectedIndex(hit.index);
      select.focus();
      options.onContextMenu?.(hit.index, event);
      consume(event);
      return;
    }
    if (event.button !== MouseButton.LEFT) return;
    const now = Date.now();
    const isDouble =
      lastClick.row === hit.row && now - lastClick.at <= (options.doubleClickMs ?? 400);
    const index = isDouble ? lastClick.index : hit.index;
    select.setSelectedIndex(index);
    select.focus();
    lastClick = { index, row: hit.row, at: now };
    options.onClick?.(index, event);
    if (isDouble) {
      if (options.onDoubleClick) options.onDoubleClick(index, event);
      else select.selectCurrent();
      lastClick = { index: -1, row: -1, at: 0 };
    }
    consume(event);
  };
  select.onMouseScroll = (event) => {
    lastClick = { index: -1, row: -1, at: 0 };
    const direction = event.scroll?.direction;
    if (direction === "up") select.moveUp(3);
    else if (direction === "down") select.moveDown(3);
    else return;
    select.focus();
    consume(event);
  };
  return () => {
    select.onMouseDown = undefined;
    select.onMouseScroll = undefined;
  };
}

export function attachMouseTabs(
  tabs: TabSelectRenderable,
  options: MouseSelectAdapterOptions = {},
): () => void {
  let lastClick = { index: -1, at: 0 };
  tabs.onMouseDown = (event) => {
    if (event.button !== MouseButton.LEFT && event.button !== MouseButton.RIGHT) return;
    const index = tabIndexAt(tabs, event);
    if (index === undefined) return;
    tabs.setSelectedIndex(index);
    tabs.focus();
    if (event.button === MouseButton.RIGHT) {
      options.onContextMenu?.(index, event);
      consume(event);
      return;
    }
    const now = Date.now();
    const isDouble =
      lastClick.index === index && now - lastClick.at <= (options.doubleClickMs ?? 400);
    lastClick = { index, at: now };
    options.onClick?.(index, event);
    if (isDouble) {
      if (options.onDoubleClick) options.onDoubleClick(index, event);
      else tabs.selectCurrent();
      lastClick = { index: -1, at: 0 };
    }
    consume(event);
  };
  tabs.onMouseScroll = (event) => {
    const direction = event.scroll?.direction;
    if (direction === "up" || direction === "left") tabs.moveLeft();
    else if (direction === "down" || direction === "right") tabs.moveRight();
    else return;
    consume(event);
  };
  return () => {
    tabs.onMouseDown = undefined;
    tabs.onMouseScroll = undefined;
  };
}

function selectIndexAt(
  select: SelectRenderable,
  event: MouseEvent,
): { index: number; row: number } | undefined {
  const internals = select as unknown as SelectInternals;
  const localY = event.y - select.y;
  const linesPerItem = Math.max(1, internals.linesPerItem ?? (select.showDescription ? 2 : 1));
  if (localY < 0 || localY >= select.height) return undefined;
  const row = Math.floor(localY / linesPerItem);
  const index = (internals.scrollOffset ?? 0) + row;
  return index >= 0 && index < select.options.length ? { index, row } : undefined;
}

function tabIndexAt(tabs: TabSelectRenderable, event: MouseEvent): number | undefined {
  const internals = tabs as unknown as TabInternals;
  const localX = event.x - tabs.x;
  if (localX < 0 || localX >= tabs.width) return undefined;
  const index = (internals.scrollOffset ?? 0) + Math.floor(localX / tabs.getTabWidth());
  return index >= 0 && index < tabs.options.length ? index : undefined;
}

function consume(event: MouseEvent): void {
  event.preventDefault();
  event.stopPropagation();
}
