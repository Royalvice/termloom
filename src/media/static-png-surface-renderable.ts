import {
  CliRenderEvents,
  type OptimizedBuffer,
  Renderable,
  type RenderableOptions,
  RGBA,
  RootRenderable,
  type RenderContext,
} from "@opentui/core";
import terminalImage from "term-img";
import type { MediaAdapterName, MediaOutput } from "./types.js";

const APC = "\x1b_G";
const ST = "\x1b\\";
const KITTY_CHUNK_BYTES = 4_096;
let nextImageId = 20_000;

export interface StaticPngSurfaceOptions extends RenderableOptions<StaticPngSurfaceRenderable> {
  adapter: MediaAdapterName;
  output?: MediaOutput;
  sourceWidth: number;
  sourceHeight: number;
  background?: string;
  itermImageEncoder?: (png: Uint8Array, width: number, height: number) => string;
}

/**
 * A document tile surface that keeps the Markdown raster in the terminal's
 * pixel plane. It deliberately does not decode PNG in Bun: Kitty receives the
 * helper's PNG bytes unchanged. Cell terminals are handled by the existing
 * RGB media surface until a native PNG decoder is added to the helper bundle.
 */
export class StaticPngSurfaceRenderable extends Renderable {
  private readonly adapter: MediaAdapterName;
  private readonly output: MediaOutput | undefined;
  private readonly background: RGBA;
  private readonly itermImageEncoder: (png: Uint8Array, width: number, height: number) => string;
  private readonly imageId = nextImageId++;
  private png: Uint8Array | undefined;
  private frameDirty = false;
  private placementDirty = true;
  private presented = true;
  private listenerAttached = false;
  private lastRegion: CellRegion | undefined;
  private pendingPayload: string | undefined;
  private pendingCleanup = false;
  private backpressured = false;
  private drainAttached = false;
  private readonly onFrame = () => this.flushExternal();

  public constructor(ctx: RenderContext, options: StaticPngSurfaceOptions) {
    super(ctx, { ...options, overflow: "hidden" });
    this.adapter = options.adapter;
    this.output = options.output;
    positiveInteger(options.sourceWidth, "sourceWidth");
    positiveInteger(options.sourceHeight, "sourceHeight");
    this.background = RGBA.fromHex(options.background ?? "#11111b");
    this.itermImageEncoder = options.itermImageEncoder ?? encodeItermImage;
    this.attachFrameListener();
  }

  public setPng(png: Uint8Array): void {
    if (this.isDestroyed) return;
    if (png.byteLength === 0) throw new Error("PNG tile must not be empty");
    this.png = new Uint8Array(png);
    this.frameDirty = true;
    this.placementDirty = true;
    this.requestRender();
  }

  public setPresented(presented: boolean): void {
    if (this.presented === presented || this.isDestroyed) return;
    this.presented = presented;
    if (presented) {
      this.placementDirty = true;
      this.frameDirty = Boolean(this.png);
      this.attachFrameListener();
      this.requestRender();
    } else {
      this.detachFrameListener();
      this.clearExternalPlacement();
    }
  }

  public inspectReady(): boolean {
    return this.png !== undefined;
  }

  protected override onResize(width: number, height: number): void {
    super.onResize(width, height);
    this.placementDirty = true;
    if (this.png) this.frameDirty = true;
  }

  protected override renderSelf(buffer: OptimizedBuffer): void {
    this.clear(buffer);
    if (!this.png || this.adapter === "truecolor-cells") return;
    const foreground = RGBA.fromInts(205, 214, 244, 255);
    for (let row = 0; row < this.height; row += 1) {
      for (let column = 0; column < this.width; column += 1) {
        buffer.setCell(this.x + column, this.y + row, "\u00a0", foreground, this.background);
      }
    }
  }

  protected override destroySelf(): void {
    this.presented = false;
    this.detachFrameListener();
    this.clearExternalPlacement();
    this.detachDrain();
    super.destroySelf();
  }

  private clear(buffer: OptimizedBuffer): void {
    for (let row = 0; row < this.height; row += 1) {
      for (let column = 0; column < this.width; column += 1) {
        buffer.setCell(
          this.x + column,
          this.y + row,
          " ",
          RGBA.fromInts(205, 214, 244, 255),
          this.background,
        );
      }
    }
  }

  private flushExternal(): void {
    if (
      !this.presented ||
      this.isDestroyed ||
      !this.png ||
      !this.output ||
      this.adapter === "truecolor-cells"
    )
      return;
    const region = this.visibleRegion();
    if (!region) {
      this.clearExternalPlacement();
      return;
    }
    if (!this.frameDirty && !this.placementDirty && sameRegion(this.lastRegion, region)) return;
    if (this.backpressured) return;
    const payload =
      this.adapter === "iterm2"
        ? buildItermPng(this.png, this.itermImageEncoder, region)
        : buildKittyPng(this.png, this.imageId, region);
    if (!this.send(payload)) return;
    this.lastRegion = region;
    this.frameDirty = false;
    this.placementDirty = false;
  }

  private visibleRegion(): CellRegion | undefined {
    if (!this.visible || this.width <= 0 || this.height <= 0) return;
    const candidate = {
      x: this.screenX,
      y: this.screenY,
      width: this.width,
      height: this.height,
    };
    if (
      candidate.x < 0 ||
      candidate.y < 0 ||
      candidate.x + candidate.width > this.ctx.width ||
      candidate.y + candidate.height > this.ctx.height
    )
      return;
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
      )
        return;
      if (ancestor instanceof RootRenderable) attachedToRoot = true;
      ancestor = ancestor.parent;
    }
    return attachedToRoot ? candidate : undefined;
  }

  private send(payload: string): boolean {
    if (!this.output || this.backpressured) return false;
    const writable = this.output.write(payload);
    if (!writable) {
      this.backpressured = true;
      this.attachDrain();
      return false;
    }
    return true;
  }

  private clearExternalPlacement(): void {
    if (!this.output || !this.lastRegion) return;
    const payload =
      this.adapter === "iterm2" ? clearRegion(this.lastRegion) : deleteKittyImage(this.imageId);
    if (this.backpressured) {
      this.pendingPayload = payload;
      this.pendingCleanup = true;
      return;
    }
    if (!this.send(payload)) {
      this.pendingPayload = payload;
      this.pendingCleanup = true;
      return;
    }
    this.lastRegion = undefined;
    this.frameDirty = Boolean(this.png);
    this.placementDirty = true;
  }

  private attachFrameListener(): void {
    if (
      this.listenerAttached ||
      !this.presented ||
      this.isDestroyed ||
      this.adapter === "truecolor-cells"
    )
      return;
    this.ctx.on(CliRenderEvents.FRAME, this.onFrame);
    this.listenerAttached = true;
  }

  private detachFrameListener(): void {
    if (!this.listenerAttached) return;
    this.ctx.off(CliRenderEvents.FRAME, this.onFrame);
    this.listenerAttached = false;
  }

  private attachDrain(): void {
    if (this.drainAttached || !this.output) return;
    this.drainAttached = true;
    this.output.once("drain", this.onDrain);
  }

  private detachDrain(): void {
    if (!this.drainAttached || !this.output) return;
    this.output.off?.("drain", this.onDrain);
    this.drainAttached = false;
  }

  private readonly onDrain = (): void => {
    this.backpressured = false;
    this.detachDrain();
    if (this.pendingPayload) {
      const pending = this.pendingPayload;
      const cleanup = this.pendingCleanup;
      this.pendingPayload = undefined;
      this.pendingCleanup = false;
      if (!this.send(pending)) {
        this.pendingPayload = pending;
        this.pendingCleanup = cleanup;
        return;
      }
      if (cleanup) {
        this.lastRegion = undefined;
        this.frameDirty = Boolean(this.png);
        this.placementDirty = true;
      }
      return;
    }
    this.requestRender();
  };
}

function buildKittyPng(png: Uint8Array, imageId: number, region: CellRegion): string {
  const encoded = Buffer.from(png).toString("base64");
  let payload = `\x1b7\x1b[${region.y + 1};${region.x + 1}H`;
  for (let offset = 0; offset < encoded.length; offset += KITTY_CHUNK_BYTES) {
    const chunk = encoded.slice(offset, offset + KITTY_CHUNK_BYTES);
    const first = offset === 0;
    const last = offset + KITTY_CHUNK_BYTES >= encoded.length;
    const control = first
      ? "a=T,f=100,i=" +
        imageId +
        ",p=1,q=2,C=1,c=" +
        region.width +
        ",r=" +
        region.height +
        ",m=" +
        (last ? "0" : "1")
      : `m=${last ? "0" : "1"}`;
    payload += `${APC + control};${chunk}${ST}`;
  }
  return `${payload}\x1b8`;
}

function deleteKittyImage(imageId: number): string {
  return `${APC}a=d,d=I,i=${imageId},q=2${ST}`;
}

function buildItermPng(
  png: Uint8Array,
  encoder: (png: Uint8Array, width: number, height: number) => string,
  region: CellRegion,
): string {
  return `\x1b7\x1b[${region.y + 1};${region.x + 1}H${encoder(png, region.width, region.height)}\x1b8`;
}

function encodeItermImage(png: Uint8Array, width: number, height: number): string {
  return terminalImage(png, {
    width,
    height,
    preserveAspectRatio: true,
    fallback: () => {
      throw new Error("The current terminal did not accept the iTerm2 inline image protocol");
    },
  });
}

function clearRegion(region: CellRegion): string {
  let payload = "\x1b7";
  for (let row = 0; row < region.height; row += 1) {
    payload += `\x1b[${region.y + row + 1};${region.x + 1}H${" ".repeat(region.width)}`;
  }
  return `${payload}\x1b8`;
}

interface CellRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

function sameRegion(left: CellRegion | undefined, right: CellRegion): boolean {
  return Boolean(
    left &&
      left.x === right.x &&
      left.y === right.y &&
      left.width === right.width &&
      left.height === right.height,
  );
}

function contains(container: CellRegion, child: CellRegion): boolean {
  return (
    child.x >= container.x &&
    child.y >= container.y &&
    child.x + child.width <= container.x + container.width &&
    child.y + child.height <= container.y + container.height
  );
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be positive`);
  return value;
}
