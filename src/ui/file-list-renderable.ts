import { extname } from "node:path";
import {
  BoxRenderable,
  type CliRenderer,
  type KeyEvent,
  MouseButton,
  ScrollBoxRenderable,
  TextAttributes,
  TextRenderable,
} from "@opentui/core";
import type { FileEntry } from "../files/file-provider.js";
import { theme } from "./theme.js";

export interface FileListOptions {
  id: string;
  entries?: readonly FileEntry[];
  emptyLabel?: string;
  onSelection?: (entry: FileEntry | undefined) => void;
  onActivate?: (entry: FileEntry) => void;
  onContextMenu?: (event: { x: number; y: number }, entry: FileEntry | undefined) => void;
}

export class FileListRenderable extends BoxRenderable {
  private readonly scroll: ScrollBoxRenderable;
  private readonly rows: TextRenderable[] = [];
  private entriesValue: readonly FileEntry[];
  private selectedIndex = 0;
  private hoveredIndex: number | undefined;
  private columnWidth = 40;
  private lastClick: { index: number; at: number } | undefined;
  private readonly emptyLabel: string;
  private readonly onSelectionValue: ((entry: FileEntry | undefined) => void) | undefined;
  private readonly onActivateValue: ((entry: FileEntry) => void) | undefined;
  private readonly onContextMenuValue:
    | ((event: { x: number; y: number }, entry: FileEntry | undefined) => void)
    | undefined;

  public constructor(renderer: CliRenderer, options: FileListOptions) {
    super(renderer, {
      id: options.id,
      width: "100%",
      height: "100%",
      flexDirection: "column",
      focusable: true,
      backgroundColor: theme.background,
      overflow: "hidden",
      onMouseDown: (event) => {
        if (event.button !== MouseButton.RIGHT) return;
        this.onContextMenuValue?.({ x: event.x, y: event.y }, undefined);
        event.preventDefault();
        event.stopPropagation();
      },
    });
    this.entriesValue = options.entries ?? [];
    this.emptyLabel = options.emptyLabel ?? "Empty folder";
    this.onSelectionValue = options.onSelection;
    this.onActivateValue = options.onActivate;
    this.onContextMenuValue = options.onContextMenu;
    this.scroll = new ScrollBoxRenderable(renderer, {
      id: `${options.id}-scroll`,
      width: "100%",
      height: "100%",
      scrollY: true,
      scrollX: false,
      viewportCulling: true,
      rootOptions: { backgroundColor: theme.background },
      contentOptions: { flexDirection: "column", width: "100%" },
    });
    this.add(this.scroll);
    this.rebuildRows();
  }

  public get entries(): readonly FileEntry[] {
    return this.entriesValue;
  }

  public get selected(): FileEntry | undefined {
    return this.entriesValue[this.selectedIndex];
  }

  public setEntries(entries: readonly FileEntry[], selectedPath?: string): void {
    this.entriesValue = entries;
    const restored = selectedPath
      ? entries.findIndex((entry) => entry.path === selectedPath)
      : Math.min(this.selectedIndex, Math.max(0, entries.length - 1));
    this.selectedIndex = Math.max(0, restored);
    this.hoveredIndex = undefined;
    this.lastClick = undefined;
    this.rebuildRows();
    this.onSelectionValue?.(this.selected);
  }

  public move(offset: number): void {
    if (this.entriesValue.length === 0) return;
    const next = Math.max(0, Math.min(this.entriesValue.length - 1, this.selectedIndex + offset));
    if (next === this.selectedIndex) return;
    this.select(next, true);
  }

  public activate(): void {
    const selected = this.selected;
    if (selected) this.onActivateValue?.(selected);
  }

  public refreshAppearance(): void {
    this.backgroundColor = theme.background;
    this.scroll.backgroundColor = theme.background;
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
      this.move(-Math.max(1, this.height - 2));
      return true;
    }
    if (key.name === "pagedown") {
      this.move(Math.max(1, this.height - 2));
      return true;
    }
    if (key.name === "home") {
      this.select(0, true);
      return true;
    }
    if (key.name === "end") {
      this.select(Math.max(0, this.entriesValue.length - 1), true);
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
    if (this.entriesValue.length === 0) {
      const empty = new TextRenderable(this.ctx, {
        id: `${this.id}-empty`,
        width: "100%",
        height: 1,
        content: `  ${this.emptyLabel}`,
        fg: theme.muted,
        attributes: TextAttributes.DIM,
      });
      this.rows.push(empty);
      this.scroll.add(empty);
      this.requestRender();
      return;
    }
    this.entriesValue.forEach((entry, index) => {
      const row = new TextRenderable(this.ctx, {
        id: `${this.id}-row-${index}`,
        width: "100%",
        height: 1,
        content: formatFileRow(entry, this.columnWidth, index === this.selectedIndex),
        fg: fileColor(entry),
        bg: theme.background,
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
          this.select(index, false);
          if (event.button === MouseButton.RIGHT) {
            this.lastClick = undefined;
            this.onContextMenuValue?.({ x: event.x, y: event.y }, entry);
          } else if (event.button === MouseButton.LEFT) {
            const now = Date.now();
            if (this.lastClick?.index === index && now - this.lastClick.at <= 350) {
              this.lastClick = undefined;
              this.onActivateValue?.(entry);
            } else {
              this.lastClick = { index, at: now };
            }
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

  private select(index: number, scrollIntoView: boolean): void {
    if (this.entriesValue.length === 0) return;
    this.selectedIndex = Math.max(0, Math.min(this.entriesValue.length - 1, index));
    this.updateRows();
    if (scrollIntoView) this.scroll.scrollChildIntoView(`${this.id}-row-${this.selectedIndex}`);
    this.onSelectionValue?.(this.selected);
  }

  private updateRows(): void {
    this.rows.forEach((row, index) => {
      const entry = this.entriesValue[index];
      if (!entry) {
        row.fg = theme.muted;
        row.bg = theme.background;
        return;
      }
      const selected = index === this.selectedIndex;
      row.content = formatFileRow(entry, this.columnWidth, selected);
      row.fg = fileColor(entry);
      row.bg = selected
        ? theme.selectionStrong
        : index === this.hoveredIndex
          ? theme.selection
          : theme.background;
      row.attributes = selected ? TextAttributes.BOLD : TextAttributes.NONE;
    });
    this.requestRender();
  }
}

export type FileVisualKind =
  | "directory"
  | "text"
  | "image"
  | "video"
  | "archive"
  | "source"
  | "executable"
  | "unknown";

export function fileVisualKind(entry: FileEntry): FileVisualKind {
  if (entry.isDirectory) return "directory";
  if (entry.mode !== undefined && (entry.mode & 0o111) !== 0) return "executable";
  const extension = extname(entry.name).toLocaleLowerCase();
  if ([".md", ".markdown", ".txt", ".rst", ".log"].includes(extension)) return "text";
  if ([".png", ".jpg", ".jpeg", ".webp", ".svg", ".bmp", ".tiff"].includes(extension)) {
    return "image";
  }
  if ([".gif", ".mp4", ".mov", ".mkv", ".webm", ".m4v"].includes(extension)) {
    return "video";
  }
  if ([".zip", ".tar", ".gz", ".bz2", ".xz", ".7z", ".rar", ".tgz"].includes(extension)) {
    return "archive";
  }
  if (
    [
      ".ts",
      ".tsx",
      ".js",
      ".jsx",
      ".py",
      ".rs",
      ".go",
      ".c",
      ".h",
      ".cpp",
      ".hpp",
      ".java",
      ".swift",
      ".sh",
      ".zsh",
      ".fish",
      ".json",
      ".toml",
      ".yaml",
      ".yml",
      ".xml",
      ".ini",
      ".conf",
    ].includes(extension)
  ) {
    return "source";
  }
  if (entry.mimeType?.startsWith("text/")) return "text";
  if (entry.mimeType?.startsWith("image/"))
    return entry.mimeType === "image/gif" ? "video" : "image";
  if (entry.mimeType?.startsWith("video/")) return "video";
  return "unknown";
}

function fileColor(entry: FileEntry): string {
  switch (fileVisualKind(entry)) {
    case "directory":
      return theme.accent;
    case "text":
      return theme.success;
    case "image":
      return "#89dceb";
    case "video":
      return theme.warning;
    case "archive":
      return theme.accentSecondary;
    case "source":
      return theme.muted;
    case "executable":
      return theme.error;
    case "unknown":
      return theme.foreground;
  }
}

function fileIcon(entry: FileEntry): string {
  if (entry.isSymbolicLink) return "↗";
  switch (fileVisualKind(entry)) {
    case "directory":
      return "▸";
    case "text":
      return "≡";
    case "image":
      return "▧";
    case "video":
      return "▶";
    case "archive":
      return "◆";
    case "source":
      return "λ";
    case "executable":
      return "*";
    case "unknown":
      return "·";
  }
}

function formatFileRow(entry: FileEntry, width: number, selected: boolean): string {
  const icon = fileIcon(entry);
  const rail = selected ? "▌" : " ";
  if (width < 30) return `${rail}${icon} ${truncate(entry.name, Math.max(1, width - 3))}`;
  const size = entry.isDirectory ? "—" : formatBytes(entry.size);
  const modified = entry.modifiedAt ? formatModified(entry.modifiedAt) : "";
  const sizeWidth = 9;
  const dateWidth = width >= 54 ? 16 : 0;
  const nameWidth = Math.max(4, width - 4 - sizeWidth - (dateWidth ? dateWidth + 1 : 0));
  return `${rail}${icon} ${truncate(entry.name, nameWidth).padEnd(nameWidth)} ${size.padStart(sizeWidth)}${
    dateWidth ? ` ${modified.padStart(dateWidth)}` : ""
  }`;
}

function truncate(value: string, width: number): string {
  return value.length <= width ? value : `${value.slice(0, Math.max(0, width - 1))}…`;
}

function formatModified(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  const hour = String(value.getHours()).padStart(2, "0");
  const minute = String(value.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day} ${hour}:${minute}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)}K`;
  if (bytes < 1_073_741_824) return `${(bytes / 1_048_576).toFixed(1)}M`;
  return `${(bytes / 1_073_741_824).toFixed(1)}G`;
}
