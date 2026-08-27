import {
  decodePasteBytes,
  type KeyEvent,
  MouseButton,
  type MouseEvent,
  type OptimizedBuffer,
  Renderable,
  type RenderableOptions,
  RGBA,
  TextAttributes,
  type PasteEvent,
  type RenderContext,
} from "@opentui/core";
import { Terminal, type IBufferCell } from "@xterm/headless";
import { cellBackground, cellForeground, DEFAULT_TERMINAL_BG } from "./ansi-colors.js";
import type { Disposable, TerminalBackend, TerminalExit } from "./backend.js";
import {
  encodeKeyEvent,
  encodeMouseEvent,
  encodePaste,
  MouseProtocolTracker,
} from "./input-encoder.js";
import { terminalPathTokenMatches, type TerminalPathToken } from "./path-token.js";
import { theme } from "../ui/theme.js";

export interface TerminalRenderableOptions extends RenderableOptions<TerminalRenderable> {
  backend?: TerminalBackend;
  cols?: number;
  rows?: number;
  scrollback?: number;
  onBackendExit?: (event: TerminalExit) => void;
  onPathActivation?: (token: TerminalPathToken) => void | Promise<void>;
  onPathHover?: (token: TerminalPathToken | undefined) => void;
  /** Copy selected terminal text through the owning renderer/clipboard adapter. */
  onCopyToClipboard?: (text: string) => boolean;
}

interface TerminalPathHit {
  token: TerminalPathToken;
  row: number;
  startColumn: number;
  endColumn: number;
}

interface TerminalLineSnapshot {
  text: string;
  characterAtColumn: readonly number[];
}

interface TerminalLogicalRowSnapshot extends TerminalLineSnapshot {
  textStart: number;
}

interface TerminalCellPosition {
  row: number;
  column: number;
}

interface TerminalSelectionRange {
  start: TerminalCellPosition;
  end: TerminalCellPosition;
}

export interface TerminalCellSnapshot {
  chars: string;
  width: number;
  foreground: number;
  background: number;
  bold: boolean;
  italic: boolean;
  dim: boolean;
  underline: boolean;
  inverse: boolean;
}

export class TerminalRenderable extends Renderable {
  public readonly terminal: Terminal;
  private backend: TerminalBackend | undefined;
  private backendDisposables: Disposable[] = [];
  private readonly terminalDisposables: Array<{ dispose(): void }> = [];
  private readonly mouseTracker = new MouseProtocolTracker();
  private disposeMouseTracker: (() => void) | undefined;
  private readonly onBackendExit: ((event: TerminalExit) => void) | undefined;
  private readonly onPathActivation:
    | ((token: TerminalPathToken) => void | Promise<void>)
    | undefined;
  private readonly onPathHover: ((token: TerminalPathToken | undefined) => void) | undefined;
  private readonly onCopyToClipboard: ((text: string) => boolean) | undefined;
  private suppressPathClickRelease = false;
  private hoveredPath: TerminalPathHit | undefined;
  private selectionAnchor: TerminalCellPosition | undefined;
  private selectionRange: TerminalSelectionRange | undefined;
  private selecting = false;
  private selectionMoved = false;

  public constructor(ctx: RenderContext, options: TerminalRenderableOptions) {
    super(ctx, { ...options, overflow: "hidden" });
    this.focusable = true;
    this.onBackendExit = options.onBackendExit;
    this.onPathActivation = options.onPathActivation;
    this.onPathHover = options.onPathHover;
    this.onCopyToClipboard = options.onCopyToClipboard;
    this.terminal = new Terminal({
      allowProposedApi: true,
      cols: Math.max(1, Math.floor(options.cols ?? 80)),
      rows: Math.max(1, Math.floor(options.rows ?? 24)),
      scrollback: options.scrollback ?? 10_000,
      cursorBlink: false,
      cursorStyle: "block",
      logLevel: "off",
    });
    this.disposeMouseTracker = this.mouseTracker.install(this.terminal);
    this.terminalDisposables.push(
      this.terminal.onWriteParsed(() => this.requestRender()),
      this.terminal.onBinary((data) =>
        this.writeToBackend(Buffer.from(data, "binary").toString("latin1")),
      ),
    );
    if (options.backend) this.attachBackend(options.backend);
  }

  public attachBackend(backend: TerminalBackend): void {
    this.detachBackend(false);
    this.backend = backend;
    backend.resize(this.terminal.cols, this.terminal.rows);
    this.backendDisposables = [
      backend.onData((data) => {
        this.terminal.write(data);
      }),
      backend.onExit((event) => {
        this.onBackendExit?.(event);
        this.requestRender();
      }),
    ];
  }

  public detachBackend(kill: boolean): void {
    for (const disposable of this.backendDisposables) disposable.dispose();
    this.backendDisposables = [];
    if (kill) this.backend?.kill();
    this.backend = undefined;
  }

  public async feed(data: string | Uint8Array): Promise<void> {
    const value = typeof data === "string" ? data : new TextDecoder().decode(data);
    await new Promise<void>((resolve) => this.terminal.write(value, resolve));
    this.requestRender();
  }

  public override handleKeyPress(key: KeyEvent): boolean {
    if (key.eventType === "release") return true;
    if (isCommandKey(key) && key.name === "c") {
      const selected = this.getSelectedText();
      if (selected) this.onCopyToClipboard?.(selected);
      key.preventDefault?.();
      return true;
    }
    if (this.selectionRange) this.clearSelection();
    const encoded = encodeKeyEvent(key, this.terminal);
    if (encoded.length === 0) return false;
    this.writeToBackend(encoded);
    return true;
  }

  public override handlePaste(event: PasteEvent): void {
    event.preventDefault();
    this.clearSelection();
    this.writeToBackend(
      encodePaste(decodePasteBytes(event.bytes), this.terminal.modes.bracketedPasteMode),
    );
  }

  public sendInput(data: string): void {
    this.writeToBackend(data);
  }

  /** Returns the currently highlighted terminal text in reading order. */
  public override getSelectedText(): string {
    const range = this.selectionRange;
    if (!range) return "";
    const active = this.terminal.buffer.active;
    const lines: string[] = [];
    for (let row = range.start.row; row <= range.end.row; row += 1) {
      const line = active.getLine(row);
      if (!line) {
        lines.push("");
        continue;
      }
      const firstColumn = row === range.start.row ? range.start.column : 0;
      const lastColumn = row === range.end.row ? range.end.column : this.terminal.cols - 1;
      let text = "";
      for (let column = firstColumn; column <= lastColumn; column += 1) {
        const cell = line.getCell(column);
        if (!cell || cell.getWidth() === 0) continue;
        text += cell.getChars() || " ";
      }
      lines.push(text.trimEnd());
    }
    return lines.join("\n");
  }

  /** Clears the terminal's custom mouse selection and its highlight. */
  public clearSelection(): void {
    if (!this.selectionRange && !this.selectionAnchor) return;
    this.selectionAnchor = undefined;
    this.selectionRange = undefined;
    this.selecting = false;
    this.selectionMoved = false;
    this.requestRender();
  }

  public inspectCell(x: number, y: number): TerminalCellSnapshot | null {
    const line = this.terminal.buffer.active.getLine(this.terminal.buffer.active.viewportY + y);
    const cell = line?.getCell(x);
    if (!cell) return null;
    return {
      chars: cell.getChars(),
      width: cell.getWidth(),
      foreground: cell.getFgColor(),
      background: cell.getBgColor(),
      bold: Boolean(cell.isBold()),
      italic: Boolean(cell.isItalic()),
      dim: Boolean(cell.isDim()),
      underline: Boolean(cell.isUnderline()),
      inverse: Boolean(cell.isInverse()),
    };
  }

  /** Returns the trusted absolute path token under a terminal-local cell, if any. */
  public pathAtCell(x: number, y: number): TerminalPathToken | undefined {
    return this.pathHitAtCell(x, y)?.token;
  }

  /** Clears visual path affordance when this terminal is detached from its surface. */
  public clearPathHover(): void {
    this.setHoveredPath(undefined);
  }

  private pathHitAtCell(x: number, y: number): TerminalPathHit | undefined {
    const column = Math.floor(x);
    const row = Math.floor(y);
    if (column < 0 || row < 0 || column >= this.terminal.cols || row >= this.terminal.rows) {
      return undefined;
    }
    return this.pathHitsAtRow(row).find(
      (candidate) => column >= candidate.startColumn && column < candidate.endColumn,
    );
  }

  public get cursor(): { x: number; y: number; buffer: "normal" | "alternate" } {
    const active = this.terminal.buffer.active;
    return { x: active.cursorX, y: active.cursorY, buffer: active.type };
  }

  protected override onResize(width: number, height: number): void {
    super.onResize(width, height);
    const cols = Math.max(1, Math.floor(width));
    const rows = Math.max(1, Math.floor(height));
    if (cols === this.terminal.cols && rows === this.terminal.rows) return;
    this.terminal.resize(cols, rows);
    this.backend?.resize(cols, rows);
  }

  protected override onMouseEvent(event: MouseEvent): void {
    const localX = event.x - this.x;
    const localY = event.y - this.y;
    if (event.type === "move" || event.type === "over") {
      const hit = this.pathHitAtCell(localX, localY);
      this.setHoveredPath(hit);
      this.ctx.setMousePointer(hit ? "pointer" : "default");
    } else if (event.type === "out") {
      this.clearPathHover();
      this.ctx.setMousePointer("default");
    }
    if (
      event.type === "down" &&
      event.button === MouseButton.LEFT &&
      event.modifiers.ctrl &&
      this.onPathActivation
    ) {
      const hit = this.pathHitAtCell(localX, localY);
      if (hit) {
        this.suppressPathClickRelease = true;
        void Promise.resolve(this.onPathActivation(hit.token)).catch(() => undefined);
        event.preventDefault();
        event.stopPropagation();
        return;
      }
    }
    if (
      this.suppressPathClickRelease &&
      event.button === MouseButton.LEFT &&
      (event.type === "up" || event.type === "drag" || event.type === "drag-end")
    ) {
      if (event.type === "up" || event.type === "drag-end") this.suppressPathClickRelease = false;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const tracking = this.terminal.modes.mouseTrackingMode;

    if (this.handleSelectionMouseEvent(event, localX, localY, tracking)) return;

    if (tracking === "none") {
      if (event.type === "scroll") {
        this.terminal.scrollLines(event.scroll?.direction === "up" ? -3 : 3);
        this.requestRender();
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }

    if (tracking === "x10" && event.type !== "down" && event.type !== "scroll") return;
    if (tracking === "vt200" && (event.type === "move" || event.type === "drag")) return;
    if (tracking === "drag" && event.type === "move") return;

    const encoded = encodeMouseEvent(event, localX, localY, this.mouseTracker.current);
    if (!encoded) return;
    this.writeToBackend(encoded);
    event.preventDefault();
    event.stopPropagation();
  }

  protected override renderSelf(buffer: OptimizedBuffer): void {
    const active = this.terminal.buffer.active;
    const maxRows = Math.min(this.height, this.terminal.rows);
    const maxCols = Math.min(this.width, this.terminal.cols);
    for (let row = 0; row < maxRows; row += 1) {
      const line = active.getLine(active.viewportY + row);
      const pathHits = this.pathHitsAtRow(row);
      for (let column = 0; column < maxCols; column += 1) {
        const cell = line?.getCell(column);
        if (cell?.getWidth() === 0) continue;
        const pathHit = pathHits.find(
          (candidate) => column >= candidate.startColumn && column < candidate.endColumn,
        );
        this.drawCell(
          buffer,
          cell,
          column,
          row,
          Boolean(pathHit),
          this.isHoveredPathColumn(column, row),
          this.isSelectedCell(active.viewportY + row, column),
        );
      }
    }
  }

  protected override destroySelf(): void {
    this.detachBackend(true);
    for (const disposable of this.terminalDisposables) disposable.dispose();
    this.disposeMouseTracker?.();
    this.disposeMouseTracker = undefined;
    this.terminal.dispose();
  }

  private drawCell(
    buffer: OptimizedBuffer,
    cell: IBufferCell | undefined,
    column: number,
    row: number,
    pathLink: boolean,
    hoveredPath: boolean,
    selected: boolean,
  ): void {
    if (!cell) {
      buffer.setCell(
        this.x + column,
        this.y + row,
        " ",
        cellForegroundFallback,
        DEFAULT_TERMINAL_BG,
      );
      return;
    }
    let foreground = cellForeground(cell);
    let background = cellBackground(cell);
    let attributes = TextAttributes.NONE;
    if (cell.isBold()) attributes |= TextAttributes.BOLD;
    if (cell.isItalic()) attributes |= TextAttributes.ITALIC;
    if (cell.isDim()) attributes |= TextAttributes.DIM;
    if (cell.isUnderline()) attributes |= TextAttributes.UNDERLINE;
    // Visible absolute paths are always underlined, so users can discover the
    // local/remote Files jump without hunting for an invisible hover target.
    // Hover strengthens the existing terminal text without replacing ANSI
    // foreground/background colors emitted by the focused program.
    if (pathLink) attributes |= TextAttributes.UNDERLINE;
    if (hoveredPath) attributes |= TextAttributes.BOLD;
    if (cell.isBlink()) attributes |= TextAttributes.BLINK;
    if (cell.isStrikethrough()) attributes |= TextAttributes.STRIKETHROUGH;
    if (cell.isInverse()) [foreground, background] = [background, foreground];

    const isCursor =
      this.focused &&
      this.terminal.buffer.active.cursorX === column &&
      this.terminal.buffer.active.cursorY === row;
    if (isCursor) [foreground, background] = [background, foreground];
    if (selected) {
      foreground = RGBA.fromHex(theme.foreground);
      background = RGBA.fromHex(theme.selectionStrong);
    }
    const chars = cell.isInvisible() ? " " : cell.getChars() || " ";
    buffer.setCell(this.x + column, this.y + row, chars, foreground, background, attributes);
  }

  private isHoveredPathColumn(column: number, row: number): boolean {
    const hovered = this.hoveredPath;
    return Boolean(
      hovered && hovered.row === row && column >= hovered.startColumn && column < hovered.endColumn,
    );
  }

  private pathHitsAtRow(row: number): TerminalPathHit[] {
    const logical = this.logicalLineSnapshotAtRow(row);
    if (!logical) return [];
    const snapshot = logical.rows.get(row);
    if (!snapshot) return [];
    const rowStart = snapshot.textStart;
    const rowEnd = rowStart + snapshot.text.length;
    return terminalPathTokenMatches(logical.text).flatMap((match) => {
      const segmentStart = Math.max(match.start, rowStart);
      const segmentEnd = Math.min(match.end, rowEnd);
      if (segmentStart >= segmentEnd) return [];
      const startColumn = snapshot.characterAtColumn.findIndex(
        (value) => rowStart + value >= segmentStart,
      );
      if (startColumn < 0) return [];
      const endColumn = snapshot.characterAtColumn.findIndex(
        (value) => rowStart + value >= segmentEnd,
      );
      return [
        {
          token: match.token,
          row,
          startColumn,
          endColumn: endColumn < 0 ? this.terminal.cols : endColumn,
        },
      ];
    });
  }

  private logicalLineSnapshotAtRow(
    row: number,
  ): { text: string; rows: ReadonlyMap<number, TerminalLogicalRowSnapshot> } | undefined {
    const buffer = this.terminal.buffer.active;
    const absoluteRow = buffer.viewportY + row;
    if (!buffer.getLine(absoluteRow)) return undefined;

    let firstRow = absoluteRow;
    while (firstRow > 0 && buffer.getLine(firstRow)?.isWrapped) firstRow -= 1;
    let lastRow = absoluteRow;
    while (lastRow + 1 < buffer.length && buffer.getLine(lastRow + 1)?.isWrapped) lastRow += 1;

    let text = "";
    const rows = new Map<number, TerminalLogicalRowSnapshot>();
    for (let bufferRow = firstRow; bufferRow <= lastRow; bufferRow += 1) {
      const snapshot = this.lineSnapshotAtBufferRow(bufferRow);
      if (!snapshot) continue;
      const viewportRow = bufferRow - buffer.viewportY;
      rows.set(viewportRow, { ...snapshot, textStart: text.length });
      text += snapshot.text;
    }
    return { text, rows };
  }

  private lineSnapshotAtBufferRow(row: number): TerminalLineSnapshot | undefined {
    const line = this.terminal.buffer.active.getLine(row);
    if (!line) return undefined;

    let text = "";
    const characterAtColumn: number[] = [];
    let previousCharacter = 0;
    for (let column = 0; column < this.terminal.cols; column += 1) {
      const cell = line.getCell(column);
      if (!cell || cell.getWidth() === 0) {
        characterAtColumn[column] = previousCharacter;
        continue;
      }
      const start = text.length;
      characterAtColumn[column] = start;
      for (
        let offset = 1;
        offset < cell.getWidth() && column + offset < this.terminal.cols;
        offset += 1
      ) {
        characterAtColumn[column + offset] = start;
      }
      text += cell.getChars() || " ";
      previousCharacter = start;
    }
    return { text, characterAtColumn };
  }

  private setHoveredPath(next: TerminalPathHit | undefined): void {
    const previous = this.hoveredPath;
    if (
      previous?.row === next?.row &&
      previous?.startColumn === next?.startColumn &&
      previous?.endColumn === next?.endColumn &&
      previous?.token.path === next?.token.path
    ) {
      return;
    }
    this.hoveredPath = next;
    this.onPathHover?.(next?.token);
    this.requestRender();
  }

  private writeToBackend(data: string): void {
    if (!this.backend || this.backend.closed) return;
    this.backend.write(data);
  }

  private handleSelectionMouseEvent(
    event: MouseEvent,
    localX: number,
    localY: number,
    tracking: string,
  ): boolean {
    const canSelect = tracking === "none" || event.modifiers.shift;
    if (
      event.type === "down" &&
      event.button === MouseButton.LEFT &&
      canSelect &&
      !event.modifiers.ctrl &&
      !event.modifiers.alt
    ) {
      this.focus();
      this.selectionAnchor = this.selectionPoint(localX, localY);
      this.selectionRange = {
        start: this.selectionAnchor,
        end: this.selectionAnchor,
      };
      this.selecting = true;
      this.selectionMoved = false;
      event.preventDefault();
      event.stopPropagation();
      this.requestRender();
      return true;
    }

    if (this.selecting && (event.type === "drag" || event.type === "move")) {
      const next = this.selectionPoint(localX, localY);
      this.selectionRange = normalizeSelection(this.selectionAnchor, next);
      this.selectionMoved = this.selectionMoved || !samePosition(this.selectionAnchor, next);
      event.preventDefault();
      event.stopPropagation();
      this.requestRender();
      return true;
    }

    if (
      this.selecting &&
      (event.type === "up" || event.type === "drag-end" || event.type === "drop")
    ) {
      const next = this.selectionPoint(localX, localY);
      this.selectionRange = normalizeSelection(this.selectionAnchor, next);
      this.selecting = false;
      if (!this.selectionMoved) this.clearSelection();
      event.preventDefault();
      event.stopPropagation();
      this.requestRender();
      return true;
    }
    return false;
  }

  private selectionPoint(localX: number, localY: number): TerminalCellPosition {
    return {
      row: Math.max(
        0,
        Math.min(
          this.terminal.buffer.active.length - 1,
          this.terminal.buffer.active.viewportY + Math.floor(localY),
        ),
      ),
      column: Math.max(0, Math.min(this.terminal.cols - 1, Math.floor(localX))),
    };
  }

  private isSelectedCell(row: number, column: number): boolean {
    const range = this.selectionRange;
    if (!range || row < range.start.row || row > range.end.row) return false;
    const first = row === range.start.row ? range.start.column : 0;
    const last = row === range.end.row ? range.end.column : this.terminal.cols - 1;
    return column >= first && column <= last;
  }
}

const cellForegroundFallback = RGBA.fromInts(205, 214, 244, 255);

function normalizeSelection(
  anchor: TerminalCellPosition | undefined,
  active: TerminalCellPosition,
): TerminalSelectionRange {
  if (!anchor) return { start: active, end: active };
  const before =
    anchor.row < active.row || (anchor.row === active.row && anchor.column <= active.column);
  return before ? { start: anchor, end: active } : { start: active, end: anchor };
}

function samePosition(
  left: TerminalCellPosition | undefined,
  right: TerminalCellPosition,
): boolean {
  return Boolean(left && left.row === right.row && left.column === right.column);
}

function isCommandKey(key: KeyEvent): boolean {
  return key.super === true || (process.platform === "darwin" && key.meta);
}
