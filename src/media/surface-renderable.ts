import {
  CliRenderEvents,
  type OptimizedBuffer,
  Renderable,
  type RenderableOptions,
  RootRenderable,
  RGBA,
  type RenderContext,
} from "@opentui/core";
import { KittyFrameEncoder, Screen as KittyMotionScreen } from "kitty-motion";
import terminalImage from "term-img";
import { TermLoomError } from "../core/errors.js";
import type { MediaAdapterName, MediaAdapterSelection, MediaOutput, RgbFrame } from "./types.js";

export interface MediaSurfaceOptions extends RenderableOptions<MediaSurfaceRenderable> {
  adapter: MediaAdapterName;
  terminal?: MediaAdapterSelection["terminal"];
  output?: MediaOutput;
  background?: string;
  kittyScreenFactory?: KittyScreenFactory;
  itermImageEncoder?: ItermImageEncoder;
}

interface KittyScreen {
  pushFrame(frame: Uint8Array): void;
  setRegion(region: { offsetCol: number; offsetRow: number; cols: number; rows: number }): void;
  getDisplaySize(): { cols: number; rows: number };
  getPlaceholderRows(): string[];
  dispose(): void;
}

interface CellRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

type KittyScreenFactory = (
  frame: RgbFrame,
  output: MediaOutput,
  region: { offsetCol: number; offsetRow: number; cols: number; rows: number },
  terminal: MediaAdapterSelection["terminal"],
) => KittyScreen;

type ItermImageEncoder = (png: Uint8Array, width: number, height: number) => string;

export class MediaSurfaceRenderable extends Renderable {
  public readonly adapter: MediaAdapterName;
  private readonly outputGate: MediaOutputGate | undefined;
  private readonly terminal: MediaAdapterSelection["terminal"];
  private readonly background: RGBA;
  private readonly kittyScreenFactory: KittyScreenFactory;
  private readonly itermImageEncoder: ItermImageEncoder;
  private readonly pngEncoder = new KittyFrameEncoder();
  private frame: RgbFrame | undefined;
  private kittyScreen: KittyScreen | undefined;
  private kittySourceSize: string | undefined;
  private itermPayload: string | undefined;
  private itermPayloadKey: string | undefined;
  private readonly onRendererFrame: () => void;
  private frameListenerAttached = false;
  private presented = true;
  private frameDirty = false;
  private placementDirty = true;
  private frameVersion = 0;
  private lastSurfaceRegion: CellRegion | undefined;
  private lastExternalRegion: CellRegion | undefined;
  private droppedFrames = 0;
  private encodedFrames = 0;

  public constructor(ctx: RenderContext, options: MediaSurfaceOptions) {
    super(ctx, { ...options, overflow: "hidden" });
    this.adapter = options.adapter;
    this.terminal = options.terminal ?? "generic";
    this.outputGate = options.output
      ? new MediaOutputGate(options.output, () => {
          if (!this.isDestroyed && this.presented) {
            this.requestRender();
          }
        })
      : undefined;
    this.background = RGBA.fromHex(options.background ?? "#11111b");
    this.kittyScreenFactory = options.kittyScreenFactory ?? createKittyScreen;
    this.itermImageEncoder = options.itermImageEncoder ?? encodeItermImage;
    this.onRendererFrame = () => this.flushExternal();
    this.attachFrameListener();
  }

  public setFrame(frame: RgbFrame): void {
    validateFrame(frame);
    if (this.frameDirty) this.droppedFrames += 1;
    this.frame = frame;
    this.frameVersion += 1;
    this.frameDirty = true;
    this.requestRender();
  }

  public setPresented(presented: boolean): void {
    if (this.presented === presented || this.isDestroyed) return;
    this.presented = presented;
    if (presented) {
      this.frameDirty = Boolean(this.frame);
      this.placementDirty = true;
      this.attachFrameListener();
      this.requestRender();
      return;
    }
    this.detachFrameListener();
    this.clearExternalPlacement();
  }

  public inspectOutputState(): {
    presented: boolean;
    framePending: boolean;
    backpressured: boolean;
    droppedFrames: number;
    encodedFrames: number;
    drainListenerAttached: boolean;
  } {
    return {
      presented: this.presented,
      framePending: this.frameDirty,
      backpressured: this.outputGate?.isBackpressured ?? false,
      droppedFrames: this.droppedFrames,
      encodedFrames: this.encodedFrames,
      drainListenerAttached: this.outputGate?.hasDrainListener ?? false,
    };
  }

  public inspectFrame(): RgbFrame | undefined {
    return this.frame ? { ...this.frame, rgb: new Uint8Array(this.frame.rgb) } : undefined;
  }

  protected override onResize(width: number, height: number): void {
    super.onResize(width, height);
    this.placementDirty = true;
    if (this.frame) this.frameDirty = true;
  }

  protected override renderSelf(buffer: OptimizedBuffer): void {
    this.clear(buffer);
    if (!this.frame) return;
    if (this.adapter === "truecolor-cells") {
      this.drawTruecolor(buffer, this.frame);
      this.frameDirty = false;
    } else {
      this.drawExternalSentinels(buffer);
      // CliRenderEvents.FRAME fires after renderNative() commits this buffer. Emitting a Kitty or
      // iTerm placement here would let the normal sentinel cells overwrite a one-shot still frame.
    }
  }

  protected override destroySelf(): void {
    this.presented = false;
    this.detachFrameListener();
    this.clearExternalPlacement();
    this.outputGate?.close();
    super.destroySelf();
  }

  private clear(buffer: OptimizedBuffer): void {
    const foreground = RGBA.fromInts(205, 214, 244, 255);
    for (let row = 0; row < this.height; row += 1) {
      for (let column = 0; column < this.width; column += 1) {
        buffer.setCell(this.x + column, this.y + row, " ", foreground, this.background);
      }
    }
  }

  private drawTruecolor(buffer: OptimizedBuffer, frame: RgbFrame): void {
    if (this.width <= 0 || this.height <= 0) return;
    const target = fit(frame.width, frame.height, this.width, this.height * 2);
    const offsetX = Math.floor((this.width - target.width) / 2);
    const offsetPixelY = Math.floor((this.height * 2 - target.height) / 2);
    const firstRow = Math.floor(offsetPixelY / 2);
    for (let row = 0; row < Math.ceil(target.height / 2); row += 1) {
      const upperTargetY = row * 2;
      const lowerTargetY = Math.min(target.height - 1, upperTargetY + 1);
      const sourceUpperY = sampleCoordinate(upperTargetY, target.height, frame.height);
      const sourceLowerY = sampleCoordinate(lowerTargetY, target.height, frame.height);
      for (let column = 0; column < target.width; column += 1) {
        const sourceX = sampleCoordinate(column, target.width, frame.width);
        const upper = pixel(frame, sourceX, sourceUpperY);
        const lower = pixel(frame, sourceX, sourceLowerY);
        buffer.setCell(
          this.x + offsetX + column,
          this.y + firstRow + row,
          "▀",
          RGBA.fromInts(upper[0], upper[1], upper[2], 255),
          RGBA.fromInts(lower[0], lower[1], lower[2], 255),
        );
      }
    }
  }

  private drawExternalSentinels(buffer: OptimizedBuffer): void {
    const display = this.adapter === "kitty" ? this.kittyScreen?.getDisplaySize() : undefined;
    const width = Math.min(this.width, display?.cols ?? this.width);
    const height = Math.min(this.height, display?.rows ?? this.height);
    const offsetX = Math.max(0, Math.floor((this.width - width) / 2));
    const offsetY = Math.max(0, Math.floor((this.height - height) / 2));
    const foreground = RGBA.fromInts(205, 214, 244, 255);
    for (let row = 0; row < height; row += 1) {
      for (let column = 0; column < width; column += 1) {
        buffer.setCell(
          this.x + offsetX + column,
          this.y + offsetY + row,
          "\u00a0",
          foreground,
          this.background,
        );
      }
    }
  }

  private flushExternal(): void {
    if (!this.presented || this.isDestroyed || this.adapter === "truecolor-cells") return;
    const surface = this.visibleSurfaceRegion();
    if (!surface) return;
    if (this.outputGate?.isBackpressured) return;
    if (this.adapter === "kitty") this.flushKitty(surface);
    else this.flushItermImage(surface);
  }

  private flushKitty(surface: CellRegion): void {
    const frame = this.frame;
    if (!frame) return;
    if (
      !this.frameDirty &&
      !this.placementDirty &&
      sameRegionValue(this.lastSurfaceRegion, surface)
    )
      return;
    const gate = this.requireOutput("Kitty graphics");
    const sourceSize = `${frame.width}x${frame.height}`;
    if (this.kittyScreen && this.kittySourceSize !== sourceSize) {
      this.kittyScreen.dispose();
      this.kittyScreen = undefined;
      this.kittySourceSize = undefined;
    }
    if (!this.kittyScreen) {
      this.kittyScreen = this.kittyScreenFactory(
        frame,
        gate,
        region(this.width, this.height),
        this.terminal,
      );
      this.kittySourceSize = sourceSize;
      this.placementDirty = true;
    }
    if (this.placementDirty) this.kittyScreen.setRegion(region(this.width, this.height));
    if (this.frameDirty) {
      this.kittyScreen.pushFrame(frame.rgb);
      this.frameDirty = false;
      this.encodedFrames += 1;
    }
    if (gate.isBackpressured) return;
    const rows = this.kittyScreen.getPlaceholderRows();
    const display = this.kittyScreen.getDisplaySize();
    const nextRegion = externalRegion(surface, display, rows.length);
    let payload = "\x1b7";
    for (let rowIndex = 0; rowIndex < nextRegion.height; rowIndex += 1) {
      payload += `\x1b[${nextRegion.y + rowIndex + 1};${nextRegion.x + 1}H${rows[rowIndex] ?? ""}`;
    }
    if (!gate.send(`${payload}\x1b8`)) return;
    this.lastExternalRegion = nextRegion;
    this.lastSurfaceRegion = surface;
    this.placementDirty = false;
  }

  private flushItermImage(nextRegion: CellRegion): void {
    const frame = this.frame;
    if (!frame) return;
    if (
      !this.frameDirty &&
      !this.placementDirty &&
      sameRegionValue(this.lastExternalRegion, nextRegion)
    )
      return;
    const output = this.requireOutput("iTerm2 inline images");
    if (this.lastExternalRegion && !sameRegion(this.lastExternalRegion, nextRegion)) {
      if (!output.send(clearRegion(this.lastExternalRegion))) return;
      this.lastExternalRegion = undefined;
    }
    const payloadKey = `${this.frameVersion}:${nextRegion.width}x${nextRegion.height}`;
    if (this.itermPayloadKey !== payloadKey) {
      const png = this.pngEncoder.encodeImage(frame.rgb, frame.width, frame.height, 5);
      this.itermPayload = this.itermImageEncoder(
        png,
        Math.max(1, nextRegion.width),
        Math.max(1, nextRegion.height),
      );
      this.itermPayloadKey = payloadKey;
      this.encodedFrames += 1;
    }
    if (
      !this.itermPayload ||
      !output.send(positioned(nextRegion.x, nextRegion.y, this.itermPayload))
    )
      return;
    this.frameDirty = false;
    this.placementDirty = false;
    this.lastExternalRegion = nextRegion;
    this.lastSurfaceRegion = nextRegion;
  }

  private visibleSurfaceRegion(): CellRegion | undefined {
    if (!this.presented || !this.visible) return;
    const candidate = {
      x: this.screenX,
      y: this.screenY,
      width: this.width,
      height: this.height,
    };
    if (
      candidate.width <= 0 ||
      candidate.height <= 0 ||
      candidate.x < 0 ||
      candidate.y < 0 ||
      candidate.x + candidate.width > this.ctx.width ||
      candidate.y + candidate.height > this.ctx.height
    ) {
      return;
    }
    let ancestor = this.parent;
    let attachedToRoot = false;
    while (ancestor) {
      if (!ancestor.visible) return;
      if (
        ancestor.overflow !== "visible" &&
        !contains(
          {
            x: ancestor.screenX,
            y: ancestor.screenY,
            width: ancestor.width,
            height: ancestor.height,
          },
          candidate,
        )
      ) {
        return;
      }
      if (ancestor instanceof RootRenderable) attachedToRoot = true;
      ancestor = ancestor.parent;
    }
    return attachedToRoot ? candidate : undefined;
  }

  private attachFrameListener(): void {
    if (
      this.adapter === "truecolor-cells" ||
      this.frameListenerAttached ||
      !this.presented ||
      this.isDestroyed
    )
      return;
    this.ctx.on(CliRenderEvents.FRAME, this.onRendererFrame);
    this.frameListenerAttached = true;
  }

  private detachFrameListener(): void {
    if (!this.frameListenerAttached) return;
    this.ctx.off(CliRenderEvents.FRAME, this.onRendererFrame);
    this.frameListenerAttached = false;
  }

  private clearExternalPlacement(): void {
    if (this.kittyScreen) {
      this.kittyScreen.dispose();
      this.kittyScreen = undefined;
      this.kittySourceSize = undefined;
    }
    if (this.adapter === "iterm2" && this.lastExternalRegion && this.outputGate) {
      this.outputGate.buffer(clearRegion(this.lastExternalRegion));
    }
    this.lastExternalRegion = undefined;
    this.lastSurfaceRegion = undefined;
    this.itermPayload = undefined;
    this.itermPayloadKey = undefined;
    this.placementDirty = true;
  }

  private requireOutput(capability: string): MediaOutputGate {
    if (this.outputGate) return this.outputGate;
    throw new TermLoomError({
      code: "CAPABILITY_UNSUPPORTED",
      message: `${capability} requires a terminal output stream`,
    });
  }
}

class MediaOutputGate implements MediaOutput {
  private readonly pending: string[] = [];
  private backpressured = false;
  private drainAttached = false;
  private closed = false;

  public constructor(
    private readonly output: MediaOutput,
    private readonly onWritable: () => void,
  ) {}

  public get isBackpressured(): boolean {
    return this.backpressured;
  }

  public get hasDrainListener(): boolean {
    return this.drainAttached;
  }

  /** Kitty screen output must finish the current protocol payload even after write() backpressure. */
  public write(chunk: string): boolean {
    if (this.closed) return false;
    if (this.backpressured) {
      this.pending.push(chunk);
      return true;
    }
    this.writeUnderlying(chunk);
    return true;
  }

  public once(event: "drain", listener: () => void): unknown {
    return this.output.once(event, listener);
  }

  public off(event: "drain", listener: () => void): unknown {
    return this.output.off?.(event, listener);
  }

  /** Send one complete surface payload. False means it must be retried after drain. */
  public send(chunk: string): boolean {
    if (this.closed || this.backpressured) return false;
    this.writeUnderlying(chunk);
    return true;
  }

  /** Queue teardown output behind the one in-flight payload without accepting new media frames. */
  public buffer(chunk: string): void {
    if (this.closed) return;
    if (this.backpressured) this.pending.push(chunk);
    else this.writeUnderlying(chunk);
  }

  public close(): void {
    this.closed = true;
    if (!this.backpressured && this.pending.length === 0) this.detachDrain();
  }

  private writeUnderlying(chunk: string): void {
    const writable = this.output.write(chunk);
    if (writable) return;
    this.backpressured = true;
    this.attachDrain();
  }

  private attachDrain(): void {
    if (this.drainAttached) return;
    this.drainAttached = true;
    this.output.once("drain", this.handleDrain);
  }

  private detachDrain(): void {
    if (!this.drainAttached) return;
    this.output.off?.("drain", this.handleDrain);
    this.drainAttached = false;
  }

  private readonly handleDrain = (): void => {
    this.drainAttached = false;
    this.backpressured = false;
    while (this.pending.length > 0 && !this.backpressured) {
      const chunk = this.pending.shift();
      if (chunk !== undefined) this.writeUnderlying(chunk);
    }
    if (this.backpressured) return;
    if (this.closed) {
      this.detachDrain();
      return;
    }
    this.onWritable();
  };
}

function createKittyScreen(
  frame: RgbFrame,
  output: MediaOutput,
  targetRegion: { offsetCol: number; offsetRow: number; cols: number; rows: number },
  terminal: MediaAdapterSelection["terminal"],
): KittyScreen {
  return new KittyMotionScreen({
    sourceWidth: frame.width,
    sourceHeight: frame.height,
    output,
    colorSpace: "rgb24",
    renderMode: "kitty",
    embedded: true,
    placement: "unicode",
    region: targetRegion,
    autoResize: false,
    autoDispose: false,
    fileTransfer: false,
    // Ghostty 1.3.1 supports Kitty Graphics and Unicode placeholders, but not
    // the a=f animation-frame edit action. Re-transmit complete frames there;
    // placeholder cells continue to reference the replaced image id.
    dirtyRects: terminal !== "ghostty",
    compression: "png",
    workerFactory: () => null,
  });
}

function encodeItermImage(png: Uint8Array, width: number, height: number): string {
  return terminalImage(png, {
    width,
    height,
    preserveAspectRatio: true,
    fallback: () => {
      throw new TermLoomError({
        code: "CAPABILITY_UNSUPPORTED",
        message: "The current terminal did not accept the iTerm2 inline image protocol",
      });
    },
  });
}

function validateFrame(frame: RgbFrame): void {
  if (!Number.isInteger(frame.width) || !Number.isInteger(frame.height)) {
    throw new Error("RGB frame dimensions must be integers");
  }
  if (frame.width < 1 || frame.height < 1 || frame.rgb.length !== frame.width * frame.height * 3) {
    throw new Error("RGB frame dimensions do not match its byte length");
  }
}

function fit(sourceWidth: number, sourceHeight: number, maxWidth: number, maxHeight: number) {
  const scale = Math.min(maxWidth / sourceWidth, maxHeight / sourceHeight);
  return {
    width: Math.max(1, Math.min(maxWidth, Math.floor(sourceWidth * scale))),
    height: Math.max(1, Math.min(maxHeight, Math.floor(sourceHeight * scale))),
  };
}

function pixel(frame: RgbFrame, x: number, y: number): readonly [number, number, number] {
  const index = (y * frame.width + x) * 3;
  return [frame.rgb[index] ?? 0, frame.rgb[index + 1] ?? 0, frame.rgb[index + 2] ?? 0];
}

function sampleCoordinate(value: number, targetSize: number, sourceSize: number): number {
  return Math.min(sourceSize - 1, Math.floor(((value + 0.5) * sourceSize) / targetSize));
}

function region(width: number, height: number) {
  return {
    offsetCol: 1,
    offsetRow: 1,
    cols: Math.max(1, Math.floor(width)),
    rows: Math.max(1, Math.floor(height)),
  };
}

function positioned(x: number, y: number, payload: string): string {
  return `\x1b7\x1b[${y + 1};${x + 1}H${payload}\x1b8`;
}

function clearRegion(value: CellRegion): string {
  let payload = "\x1b7";
  const blank = " ".repeat(Math.max(0, value.width));
  for (let row = 0; row < value.height; row += 1) {
    payload += `\x1b[${value.y + row + 1};${value.x + 1}H${blank}`;
  }
  return `${payload}\x1b8`;
}

function sameRegion(left: CellRegion, right: CellRegion): boolean {
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  );
}

function sameRegionValue(left: CellRegion | undefined, right: CellRegion): boolean {
  return left !== undefined && sameRegion(left, right);
}

function externalRegion(
  surface: CellRegion,
  display: { cols: number; rows: number },
  availableRows: number,
): CellRegion {
  const width = Math.min(display.cols, surface.width);
  const height = Math.min(display.rows, surface.height, availableRows);
  return {
    x: surface.x + Math.max(0, Math.floor((surface.width - width) / 2)),
    y: surface.y + Math.max(0, Math.floor((surface.height - height) / 2)),
    width,
    height,
  };
}

function contains(container: CellRegion, child: CellRegion): boolean {
  return (
    child.x >= container.x &&
    child.y >= container.y &&
    child.x + child.width <= container.x + container.width &&
    child.y + child.height <= container.y + container.height
  );
}
