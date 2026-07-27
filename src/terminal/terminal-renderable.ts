import {
  decodePasteBytes,
  type KeyEvent,
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

export interface TerminalRenderableOptions extends RenderableOptions<TerminalRenderable> {
  backend?: TerminalBackend;
  cols?: number;
  rows?: number;
  scrollback?: number;
  onBackendExit?: (event: TerminalExit) => void;
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

  public constructor(ctx: RenderContext, options: TerminalRenderableOptions) {
    super(ctx, { ...options, overflow: "hidden" });
    this.focusable = true;
    this.onBackendExit = options.onBackendExit;
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
    const encoded = encodeKeyEvent(key, this.terminal);
    if (encoded.length === 0) return false;
    this.writeToBackend(encoded);
    return true;
  }

  public override handlePaste(event: PasteEvent): void {
    event.preventDefault();
    this.writeToBackend(
      encodePaste(decodePasteBytes(event.bytes), this.terminal.modes.bracketedPasteMode),
    );
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
    const tracking = this.terminal.modes.mouseTrackingMode;
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

    const encoded = encodeMouseEvent(
      event,
      event.x - this.x,
      event.y - this.y,
      this.mouseTracker.current,
    );
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
      for (let column = 0; column < maxCols; column += 1) {
        const cell = line?.getCell(column);
        if (cell?.getWidth() === 0) continue;
        this.drawCell(buffer, cell, column, row);
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
    if (cell.isBlink()) attributes |= TextAttributes.BLINK;
    if (cell.isStrikethrough()) attributes |= TextAttributes.STRIKETHROUGH;
    if (cell.isInverse()) [foreground, background] = [background, foreground];

    const isCursor =
      this.focused &&
      this.terminal.buffer.active.cursorX === column &&
      this.terminal.buffer.active.cursorY === row;
    if (isCursor) [foreground, background] = [background, foreground];
    const chars = cell.isInvisible() ? " " : cell.getChars() || " ";
    buffer.setCell(this.x + column, this.y + row, chars, foreground, background, attributes);
  }

  private writeToBackend(data: string): void {
    if (!this.backend || this.backend.closed) return;
    this.backend.write(data);
  }
}

const cellForegroundFallback = RGBA.fromInts(205, 214, 244, 255);
