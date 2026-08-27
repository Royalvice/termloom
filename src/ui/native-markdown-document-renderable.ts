import {
  BoxRenderable,
  CliRenderEvents,
  type RenderContext,
  type RenderableOptions,
  type Renderable,
  TextRenderable,
  TextAttributes,
} from "@opentui/core";
import {
  NativeMarkdownRenderer,
  type NativeMarkdownDocument,
} from "../document/native-renderer.js";
import type { MediaAdapterName, MediaOutput } from "../media/types.js";
import { StaticPngSurfaceRenderable } from "../media/static-png-surface-renderable.js";
import { theme } from "./theme.js";

const TILE_HEIGHT_PX = 640;
const PIXELS_PER_CELL_X = 10;
const INITIAL_TILE_WINDOW = 4;
const MAX_TILE_REQUESTS = 2;

export interface NativeMarkdownDocumentOptions
  extends RenderableOptions<NativeMarkdownDocumentRenderable> {
  markdown: string;
  baseDir?: string;
  adapter: MediaAdapterName;
  output?: MediaOutput;
  signal?: AbortSignal;
  onReady?: (metadata: NativeMarkdownDocument["metadata"]) => void;
  cleanup?: () => Promise<void>;
}

type TileSurface = {
  index: number;
  surface: StaticPngSurfaceRenderable;
  requested: boolean;
};

/**
 * Continuous Markdown document surface. The parent ScrollBox owns scrolling;
 * this renderable owns only the pixel tile stack and the lazy IPC requests.
 */
export class NativeMarkdownDocumentRenderable extends BoxRenderable {
  private readonly optionsValue: NativeMarkdownDocumentOptions;
  private rendererClient = new NativeMarkdownRenderer();
  private readonly tiles: TileSurface[] = [];
  private readonly overlays: Renderable[] = [];
  private readonly errorBlocks: TextRenderable[] = [];
  private abortController = new AbortController();
  private document: NativeMarkdownDocument | undefined;
  private generation = 0;
  private runningRequests = 0;
  private reloadTimer: ReturnType<typeof setTimeout> | undefined;
  private lastWidthCells = 0;
  private readonly onFrame = () => this.loadVisibleTiles();

  public constructor(ctx: RenderContext, options: NativeMarkdownDocumentOptions) {
    super(ctx, {
      id: options.id,
      width: "100%",
      flexDirection: "column",
      backgroundColor: theme.background,
      overflow: "hidden",
    });
    this.optionsValue = options;
    if (options.signal?.aborted) this.abortController.abort(options.signal.reason);
    else options.signal?.addEventListener("abort", this.abortFromParent, { once: true });
    ctx.on(CliRenderEvents.FRAME, this.onFrame);
    this.load();
  }

  protected override onResize(width: number, height: number): void {
    super.onResize(width, height);
    if (width > 0 && width !== this.lastWidthCells && this.document) {
      this.scheduleReload();
    }
  }

  protected override destroySelf(): void {
    this.generation += 1;
    this.abortController.abort();
    this.optionsValue.signal?.removeEventListener("abort", this.abortFromParent);
    this.ctx.off(CliRenderEvents.FRAME, this.onFrame);
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    for (const tile of this.tiles) tile.surface.destroyRecursively();
    this.tiles.length = 0;
    for (const error of this.errorBlocks) error.destroyRecursively();
    this.errorBlocks.length = 0;
    void this.rendererClient.close().finally(() => this.optionsValue.cleanup?.());
    super.destroySelf();
  }

  private readonly abortFromParent = (event: Event): void => {
    this.abortController.abort((event as { reason?: unknown }).reason);
  };

  private async load(): Promise<void> {
    const generation = ++this.generation;
    const signal = this.abortController.signal;
    try {
      const widthCells = Math.max(1, this.width || this.ctx.width);
      this.lastWidthCells = widthCells;
      const widthPx = Math.max(480, Math.round(widthCells * PIXELS_PER_CELL_X));
      this.document = await this.rendererClient.render({
        markdown: this.optionsValue.markdown,
        widthPx,
        tileHeightPx: TILE_HEIGHT_PX,
        ppi: 144,
        theme: "catppuccin",
        baseDir: this.optionsValue.baseDir,
        signal,
      });
      if (generation !== this.generation || this.isDestroyed || signal.aborted) return;
      this.createTileSurfaces(this.document);
      const documentWidthCells = Math.max(1, this.lastWidthCells);
      const pixelsPerCellY = (this.document.metadata.widthPx / documentWidthCells) * 2;
      // The ScrollBox must see the full document height, not only its viewport
      // height, otherwise scrolling stops at the first raster tile.
      this.height = Math.max(1, Math.ceil(this.document.metadata.totalHeightPx / pixelsPerCellY));
      this.optionsValue.onReady?.(this.document.metadata);
      this.requestRender();
      this.loadVisibleTiles();
    } catch (error) {
      if (generation !== this.generation || this.isDestroyed || signal.aborted) return;
      this.add(
        new TextRenderable(this.ctx, {
          id: `${this.id}-native-error`,
          width: "100%",
          content: `Native Markdown renderer error: ${errorMessage(error)}`,
          fg: theme.error,
          attributes: TextAttributes.BOLD,
        }),
      );
      this.requestRender();
    }
  }

  private createTileSurfaces(document: NativeMarkdownDocument): void {
    for (const overlay of this.overlays) {
      overlay.destroyRecursively();
    }
    this.overlays.length = 0;
    for (const tile of this.tiles) tile.surface.destroyRecursively();
    this.tiles.length = 0;
    for (const error of this.errorBlocks) error.destroyRecursively();
    this.errorBlocks.length = 0;
    const widthCells = Math.max(1, this.lastWidthCells);
    const pixelsPerCellY = (document.metadata.widthPx / widthCells) * 2;
    for (let index = 0; index < document.metadata.tileCount; index += 1) {
      const remaining = document.metadata.totalHeightPx - index * document.metadata.tileHeightPx;
      const sourceHeightPx = Math.max(1, Math.min(document.metadata.tileHeightPx, remaining));
      const heightCells = Math.max(1, Math.ceil(sourceHeightPx / pixelsPerCellY));
      const surface = new StaticPngSurfaceRenderable(this.ctx, {
        id: `${this.id}-native-tile-${index}`,
        width: "100%",
        height: heightCells,
        adapter: this.optionsValue.adapter,
        output: this.optionsValue.output,
        sourceWidth: document.metadata.widthPx,
        sourceHeight: sourceHeightPx,
        background: theme.background,
      });
      this.add(surface);
      this.tiles.push({ index, surface, requested: false });
    }
  }

  public addOverlay(renderable: Renderable, top: number, height = 14): void {
    if (this.isDestroyed) {
      renderable.destroyRecursively();
      return;
    }
    renderable.position = "absolute";
    renderable.top = Math.max(0, Math.floor(top));
    renderable.left = 0;
    renderable.right = undefined;
    renderable.bottom = undefined;
    renderable.width = "100%";
    renderable.height = height;
    renderable.marginTop = 0;
    renderable.zIndex = 50;
    this.overlays.push(renderable);
    this.add(renderable);
    this.requestRender();
  }

  private loadVisibleTiles(): void {
    if (!this.document || this.isDestroyed || this.abortController.signal.aborted) return;
    const candidates = this.tiles.filter(
      (tile) => !tile.requested && (tile.surface.visible || tile.index < INITIAL_TILE_WINDOW),
    );
    const generation = this.generation;
    while (this.runningRequests < MAX_TILE_REQUESTS && candidates.length > 0) {
      const tile = candidates.shift();
      if (!tile) break;
      tile.requested = true;
      this.runningRequests += 1;
      void this.loadTile(tile, generation).finally(() => {
        this.runningRequests -= 1;
        this.loadVisibleTiles();
      });
    }
  }

  private async loadTile(tile: TileSurface, generation: number): Promise<void> {
    const document = this.document;
    if (!document || this.abortController.signal.aborted) return;
    try {
      const png = await document.tile(tile.index);
      if (generation !== this.generation || this.isDestroyed || this.abortController.signal.aborted)
        return;
      tile.surface.setPng(png);
    } catch (error) {
      if (generation !== this.generation || this.isDestroyed || this.abortController.signal.aborted)
        return;
      tile.surface.destroyRecursively();
      tile.requested = true;
      const errorBlock = new TextRenderable(this.ctx, {
        id: `${this.id}-native-tile-error-${tile.index}`,
        width: "100%",
        content: `Native Markdown tile error: ${errorMessage(error)}`,
        fg: theme.error,
      });
      this.errorBlocks.push(errorBlock);
      this.add(errorBlock);
    }
  }

  private scheduleReload(): void {
    if (this.reloadTimer) return;
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = undefined;
      this.generation += 1;
      this.abortController.abort();
      this.abortController = new AbortController();
      if (this.optionsValue.signal?.aborted) {
        this.abortController.abort(this.optionsValue.signal.reason);
      } else {
        this.optionsValue.signal?.addEventListener("abort", this.abortFromParent, { once: true });
      }
      this.document = undefined;
      for (const overlay of this.overlays) overlay.destroyRecursively();
      this.overlays.length = 0;
      for (const tile of this.tiles) tile.surface.destroyRecursively();
      this.tiles.length = 0;
      for (const error of this.errorBlocks) error.destroyRecursively();
      this.errorBlocks.length = 0;
      void this.rendererClient.close();
      this.rendererClient = new NativeMarkdownRenderer();
      this.load();
    }, 0);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
