import {
  CliRenderEvents,
  type OptimizedBuffer,
  Renderable,
  type RenderableOptions,
  RGBA,
  type RenderContext,
} from "@opentui/core";
import { KittyFrameEncoder, Screen as KittyMotionScreen } from "kitty-motion";
import terminalImage from "term-img";
import { TermLoomError } from "../core/errors.js";
import type { MediaAdapterName, MediaOutput, RgbFrame } from "./types.js";

export interface MediaSurfaceOptions extends RenderableOptions<MediaSurfaceRenderable> {
  adapter: MediaAdapterName;
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
) => KittyScreen;

type ItermImageEncoder = (png: Uint8Array, width: number, height: number) => string;

export class MediaSurfaceRenderable extends Renderable {
  public readonly adapter: MediaAdapterName;
  private readonly output: MediaOutput | undefined;
  private readonly background: RGBA;
  private readonly kittyScreenFactory: KittyScreenFactory;
  private readonly itermImageEncoder: ItermImageEncoder;
  private readonly pngEncoder = new KittyFrameEncoder();
  private frame: RgbFrame | undefined;
  private kittyScreen: KittyScreen | undefined;
  private itermPayload: string | undefined;
  private readonly onRendererFrame: () => void;

  public constructor(ctx: RenderContext, options: MediaSurfaceOptions) {
    super(ctx, { ...options, overflow: "hidden" });
    this.adapter = options.adapter;
    this.output = options.output;
    this.background = RGBA.fromHex(options.background ?? "#11111b");
    this.kittyScreenFactory = options.kittyScreenFactory ?? createKittyScreen;
    this.itermImageEncoder = options.itermImageEncoder ?? encodeItermImage;
    this.onRendererFrame = () => {
      this.flushKittyPlaceholders();
      this.flushItermImage();
    };
    if (this.adapter !== "truecolor-cells") {
      this.ctx.on(CliRenderEvents.FRAME, this.onRendererFrame);
    }
  }

  public setFrame(frame: RgbFrame): void {
    validateFrame(frame);
    this.frame = frame;
    if (this.adapter === "kitty") this.pushKittyFrame(frame);
    if (this.adapter === "iterm2") {
      const png = this.pngEncoder.encodeImage(frame.rgb, frame.width, frame.height, 5);
      this.itermPayload = this.itermImageEncoder(
        png,
        Math.max(1, this.width),
        Math.max(1, this.height),
      );
    }
    this.requestRender();
  }

  public inspectFrame(): RgbFrame | undefined {
    return this.frame ? { ...this.frame, rgb: new Uint8Array(this.frame.rgb) } : undefined;
  }

  protected override onResize(width: number, height: number): void {
    super.onResize(width, height);
    if (this.adapter === "kitty" && this.kittyScreen) {
      this.kittyScreen.setRegion(region(width, height));
      if (this.frame) this.kittyScreen.pushFrame(this.frame.rgb);
    }
    if (this.adapter === "iterm2" && this.frame) {
      const png = this.pngEncoder.encodeImage(
        this.frame.rgb,
        this.frame.width,
        this.frame.height,
        5,
      );
      this.itermPayload = this.itermImageEncoder(png, Math.max(1, width), Math.max(1, height));
    }
  }

  protected override renderSelf(buffer: OptimizedBuffer): void {
    this.clear(buffer);
    if (!this.frame) return;
    if (this.adapter === "truecolor-cells") this.drawTruecolor(buffer, this.frame);
    else this.drawExternalSentinels(buffer);
  }

  protected override destroySelf(): void {
    if (this.adapter !== "truecolor-cells") {
      this.ctx.off(CliRenderEvents.FRAME, this.onRendererFrame);
    }
    this.kittyScreen?.dispose();
    this.kittyScreen = undefined;
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

  private pushKittyFrame(frame: RgbFrame): void {
    const output = this.requireOutput("Kitty graphics");
    if (!this.kittyScreen) {
      this.kittyScreen = this.kittyScreenFactory(frame, output, region(this.width, this.height));
    }
    this.kittyScreen.pushFrame(frame.rgb);
  }

  private flushKittyPlaceholders(): void {
    if (this.adapter !== "kitty" || this.isDestroyed) return;
    const screen = this.kittyScreen;
    const surface = screen ? this.visibleSurfaceRegion() : undefined;
    const rows = screen && surface ? screen.getPlaceholderRows() : [];
    const display = screen && surface ? screen.getDisplaySize() : undefined;
    const nextRegion =
      surface && display ? externalRegion(surface, display, rows.length) : undefined;
    if (!nextRegion) return;
    let payload = "\x1b7";
    for (let rowIndex = 0; rowIndex < nextRegion.height; rowIndex += 1) {
      payload += `\x1b[${nextRegion.y + rowIndex + 1};${nextRegion.x + 1}H${rows[rowIndex] ?? ""}`;
    }
    this.requireOutput("Kitty graphics").write(`${payload}\x1b8`);
  }

  private flushItermImage(): void {
    if (this.adapter !== "iterm2" || this.isDestroyed) return;
    const output = this.requireOutput("iTerm2 inline images");
    const nextRegion = this.visibleItermRegion();
    if (!nextRegion || !this.itermPayload) return;
    // iTerm2 images are cell content rather than an independently addressable
    // placement. Re-emit after every OpenTUI frame so a modal, scroll, or pane
    // repaint cannot leave a stale or erased image behind.
    output.write(positioned(nextRegion.x, nextRegion.y, this.itermPayload));
  }

  private visibleItermRegion(): CellRegion | undefined {
    return this.visibleSurfaceRegion();
  }

  private visibleSurfaceRegion(): CellRegion | undefined {
    if (!this.visible) return;
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
      ancestor = ancestor.parent;
    }
    return candidate;
  }

  private requireOutput(capability: string): MediaOutput {
    if (this.output) return this.output;
    throw new TermLoomError({
      code: "CAPABILITY_UNSUPPORTED",
      message: `${capability} requires a terminal output stream`,
    });
  }
}

function createKittyScreen(
  frame: RgbFrame,
  output: MediaOutput,
  targetRegion: { offsetCol: number; offsetRow: number; cols: number; rows: number },
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
    dirtyRects: true,
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
