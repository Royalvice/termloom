import { extname } from "node:path";
import {
  BoxRenderable,
  CliRenderEvents,
  CodeRenderable,
  type CliRenderer,
  type KeyEvent,
  MarkdownRenderable,
  MouseButton,
  type MouseEvent,
  type Renderable,
  ScrollBoxRenderable,
  SyntaxStyle,
  TextAttributes,
  TextRenderable,
} from "@opentui/core";
import { errorMessage } from "../core/errors.js";
import type { DomainPermissionGate, DomainPermissionScope } from "../document/domain-permission.js";
import type {
  DocumentLocation,
  ResourceLocation,
  RichDocument,
  RichMathExpression,
  RichMedia,
} from "../document/model.js";
import { parseRichDocument } from "../document/parser.js";
import type { ResourceDescriptor, ResourceLoader } from "../document/resource-loader.js";
import type { I18n } from "../i18n/i18n.js";
import type { MediaDecoder } from "../media/decoder.js";
import type { FormulaRenderer } from "../media/formula-renderer.js";
import type { MpvControllerOptions } from "../media/mpv-controller.js";
import type { SvgRasterizer } from "../media/svg-rasterizer.js";
import type { MediaAdapterSelection, MediaOutput } from "../media/types.js";
import type { PaneState } from "../workspace/schema.js";
import {
  DocumentMediaBlockRenderable,
  FormulaMediaBlockRenderable,
  type MediaBlockDependencies,
} from "./media-block-renderable.js";
import { theme } from "./theme.js";

type PreviewPaneState = Extract<PaneState, { kind: "preview" }>;
type LazyDocumentBlock = DocumentMediaBlockRenderable | FormulaMediaBlockRenderable;
type LazyBlockState = {
  status: "idle" | "queued" | "running" | "done";
  inPreloadRange: boolean;
  controller?: AbortController;
  task?: Promise<void>;
};
const BINARY_SNIFF_BYTES = 8 * 1024;
const TEXT_CHUNK_BYTES = 512 * 1024;
const TEXT_PREVIEW_HARD_LIMIT = 8 * 1024 * 1024;

export interface RichDocumentOptions {
  id: string;
  pane: PreviewPaneState;
  i18n: I18n;
  onPaneUpdate?: (pane: PreviewPaneState) => void;
  signal?: AbortSignal;
}

export interface RichDocumentServices {
  loader: ResourceLoader;
  permissions: DomainPermissionGate;
  decoder: MediaDecoder;
  rasterizer: SvgRasterizer;
  formula: FormulaRenderer;
  adapter: MediaAdapterSelection;
  output?: MediaOutput;
  videoFramesPerSecond?: number;
  autoplayGif?: boolean;
  mpv?: MpvControllerOptions;
}

export interface RichDocumentOptions extends RichDocumentServices {}

export class RichDocumentRenderable extends BoxRenderable {
  private pane: PreviewPaneState;
  private readonly options: RichDocumentOptions;
  private readonly scroll: ScrollBoxRenderable;
  private readonly status: TextRenderable;
  private readonly permissionActions: BoxRenderable;
  private readonly allowOnceButton: TextRenderable;
  private readonly allowPersistButton: TextRenderable;
  private readonly loadMoreButton: TextRenderable;
  private readonly pendingPermissions = new Map<string, Set<() => void>>();
  private readonly mediaBlocks: DocumentMediaBlockRenderable[] = [];
  private readonly formulaBlocks: FormulaMediaBlockRenderable[] = [];
  private readonly lazyBlocks = new Map<LazyDocumentBlock, LazyBlockState>();
  private readonly lazyQueue: LazyDocumentBlock[] = [];
  private runningLazyTasks = 0;
  private viewportFramePending = false;
  private readonly onViewportFrame = () => {
    if (this.viewportFramePending) this.ctx.off(CliRenderEvents.FRAME, this.onViewportFrame);
    this.viewportFramePending = false;
    this.evaluateLazyBlocks();
  };
  private presented = true;
  private loadAbort = new AbortController();
  private loadPromise: Promise<void> = Promise.resolve();
  private readonly disposalTasks = new Set<Promise<unknown>>();
  private readonly abortForParent: () => void;
  private textPreview:
    | {
        descriptor: ResourceDescriptor;
        location: ResourceLocation;
        bytesLoaded: number;
        bytes: Uint8Array;
        markdown: boolean;
      }
    | undefined;
  private selectedMediaIndex = -1;
  private fullscreenOrigin:
    | { block: DocumentMediaBlockRenderable; parent: Renderable; index: number }
    | undefined;
  private generation = 0;

  public constructor(renderer: CliRenderer, options: RichDocumentOptions) {
    super(renderer, {
      id: options.id,
      width: "100%",
      height: "100%",
      flexDirection: "column",
      focusable: true,
      backgroundColor: theme.background,
      overflow: "hidden",
    });
    this.pane = options.pane;
    this.options = options;
    this.abortForParent = () => this.loadAbort.abort();
    if (options.signal?.aborted) this.loadAbort.abort(options.signal.reason);
    else options.signal?.addEventListener("abort", this.abortForParent, { once: true });
    this.add(
      new TextRenderable(renderer, {
        id: `${options.id}-header`,
        height: 1,
        width: "100%",
        content: `${targetLabel(options.pane.target)}:${options.pane.path}`,
        fg: theme.accent,
        attributes: TextAttributes.BOLD,
      }),
    );
    this.scroll = new PersistentScrollBoxRenderable(
      renderer,
      {
        id: `${options.id}-scroll`,
        width: "100%",
        flexGrow: 1,
        scrollY: true,
        scrollX: false,
        viewportCulling: true,
        rootOptions: { backgroundColor: theme.background },
        contentOptions: { flexDirection: "column", width: "100%" },
      },
      () => this.handleScroll(),
    );
    this.add(this.scroll);
    const footer = new BoxRenderable(renderer, {
      id: `${options.id}-footer`,
      height: 2,
      width: "100%",
      flexDirection: "column",
      backgroundColor: theme.surfaceRaised,
    });
    this.status = new TextRenderable(renderer, {
      id: `${options.id}-status`,
      height: 1,
      width: "100%",
      content: options.i18n.t("preview.loading"),
      fg: theme.muted,
      attributes: TextAttributes.DIM,
    });
    footer.add(this.status);
    this.permissionActions = new BoxRenderable(renderer, {
      id: `${options.id}-permission-actions`,
      height: 1,
      width: "100%",
      flexDirection: "row",
      visible: false,
      backgroundColor: theme.surfaceRaised,
    });
    this.allowOnceButton = this.actionButton(
      renderer,
      "allow-once",
      " Allow once ",
      () => void this.approvePending("once"),
    );
    this.permissionActions.add(this.allowOnceButton);
    this.loadMoreButton = this.actionButton(
      renderer,
      "load-more",
      " Load next 512 KiB ",
      () => void this.loadNextTextChunk(),
    );
    this.loadMoreButton.visible = false;
    this.permissionActions.add(this.loadMoreButton);
    this.allowPersistButton = this.actionButton(
      renderer,
      "allow-persist",
      " Always allow domain ",
      () => void this.approvePending("persist"),
    );
    this.permissionActions.add(this.allowPersistButton);
    footer.add(this.permissionActions);
    this.add(footer);
    this.loadPromise = this.load();
  }

  public override handleKeyPress(key: KeyEvent): boolean {
    if (key.ctrl || key.meta || key.super || key.eventType === "release") return false;
    if (key.name === "o" && !key.shift) {
      void this.approvePending("once");
      return true;
    }
    if (key.name === "p" && key.shift) {
      void this.approvePending("persist");
      return true;
    }
    if (key.name === "tab") {
      if (this.fullscreenOrigin) return true;
      this.selectRelativeMedia(key.shift ? -1 : 1);
      return this.mediaBlocks.some((block) => block.isPlayable());
    }
    if (isSpace(key)) return this.runMediaControl((block) => block.togglePlayback());
    if (key.name === "left") return this.runMediaControl((block) => block.seekBy(-5));
    if (key.name === "right") return this.runMediaControl((block) => block.seekBy(5));
    if (isVolumeUp(key)) return this.runMediaControl((block) => block.adjustVolume(5));
    if (key.name === "minus" || key.name === "-") {
      return this.runMediaControl((block) => block.adjustVolume(-5));
    }
    if (key.name === "m" && !key.shift) {
      return this.runMediaControl((block) => block.toggleMuted());
    }
    if (key.name === "f" && !key.shift) return this.toggleMediaFullscreen();
    if (this.fullscreenOrigin) return false;
    if (key.name === "j" || key.name === "down") this.scroll.scrollBy(2);
    else if (key.name === "k" || key.name === "up") this.scroll.scrollBy(-2);
    else if (key.name === "pagedown") this.scroll.scrollBy(Math.max(1, this.scroll.height - 2));
    else if (key.name === "pageup") this.scroll.scrollBy(-Math.max(1, this.scroll.height - 2));
    else return false;
    this.handleScroll();
    return true;
  }

  protected override destroySelf(): void {
    this.generation += 1;
    this.loadAbort.abort();
    this.setPresented(false);
    this.pendingPermissions.clear();
    this.fullscreenOrigin = undefined;
    this.options.signal?.removeEventListener("abort", this.abortForParent);
    super.destroySelf();
  }

  public override destroyRecursively(): void {
    this.captureHighlighting(this);
    this.cancelLazyTasks();
    this.detachViewportFrame();
    super.destroyRecursively();
  }

  protected override onResize(width: number, height: number): void {
    super.onResize(width, height);
    if (this.fullscreenOrigin) {
      this.fullscreenOrigin.block.height = Math.max(4, height - 3);
    }
    this.scheduleViewportEvaluation();
  }

  public async waitForDisposal(): Promise<void> {
    await Promise.allSettled([
      this.loadPromise.catch(() => undefined),
      ...this.mediaBlocks.map((block) => block.waitForDisposal()),
      ...this.formulaBlocks.map((block) => block.waitForDisposal()),
      ...this.disposalTasks,
    ]);
  }

  /** @deprecated Use waitForDisposal(). Retained for probe compatibility. */
  public waitForMediaDisposal(): Promise<void> {
    return this.waitForDisposal();
  }

  public setPresented(presented: boolean): void {
    if (this.presented === presented) return;
    this.presented = presented;
    for (const block of this.mediaBlocks) block.setPresented(presented);
    for (const block of this.formulaBlocks) block.setPresented(presented);
    if (presented) this.scheduleViewportEvaluation();
    else {
      this.detachViewportFrame();
      this.cancelLazyTasks();
    }
  }

  public selectedMedia(): DocumentMediaBlockRenderable | undefined {
    return this.mediaBlocks[this.selectedMediaIndex];
  }

  public isMediaFullscreen(): boolean {
    return this.fullscreenOrigin !== undefined;
  }

  public hasPlayingMedia(): boolean {
    return this.mediaBlocks.some((block) => block.inspectPlayback()?.status === "playing");
  }

  public refreshAppearance(): void {
    this.backgroundColor = theme.background;
    this.status.fg = theme.muted;
    this.permissionActions.backgroundColor = theme.surfaceRaised;
    this.requestRender();
  }

  public async applyServices(services: RichDocumentServices): Promise<void> {
    this.generation += 1;
    this.loadAbort.abort();
    await this.loadPromise.catch(() => undefined);
    this.loadAbort = new AbortController();
    if (this.options.signal?.aborted) this.loadAbort.abort(this.options.signal.reason);
    this.pendingPermissions.clear();
    this.permissionActions.visible = false;
    this.textPreview = undefined;
    this.loadMoreButton.visible = false;
    await this.clearRenderedDocument();
    Object.assign(this.options, services);
    this.status.content = this.options.i18n.t("preview.loading");
    this.status.fg = theme.muted;
    this.requestRender();
    this.loadPromise = this.load();
    await this.loadPromise;
  }

  private async load(): Promise<void> {
    const generation = ++this.generation;
    const signal = this.loadAbort.signal;
    try {
      const location = resourceLocation(this.pane);
      const descriptor = await this.options.loader.describe(location, { signal });
      if (generation !== this.generation || this.isDestroyed || signal.aborted) return;
      if (descriptor.isDirectory) throw new Error("A directory cannot be rendered as a document");
      if (descriptor.isSymbolicLink) {
        throw new Error("A symbolic link cannot be rendered as a document");
      }
      const extension = extname(this.pane.path).toLocaleLowerCase();
      if (isMediaExtension(extension, descriptor.mimeType)) {
        this.renderDirectMedia(extension, descriptor.mimeType);
      } else {
        const sniffLength = Math.max(1, Math.min(BINARY_SNIFF_BYTES, descriptor.size || 1));
        const sniff = await this.options.loader.read(location, {
          length: sniffLength,
          signal,
        });
        if (generation !== this.generation || this.isDestroyed || signal.aborted) return;
        if (isLikelyBinary(sniff)) {
          this.renderBinaryMetadata(descriptor);
        } else {
          const markdown = isMarkdown(extension, descriptor.mimeType);
          await this.renderTextPreview(
            {
              descriptor,
              location,
              bytesLoaded: sniff.byteLength,
              bytes: sniff,
              markdown,
            },
            Math.min(TEXT_CHUNK_BYTES, descriptor.size || TEXT_CHUNK_BYTES),
            generation,
            signal,
          );
        }
      }
      this.scroll.scrollTop = this.pane.scrollOffset;
      if (!this.textPreview) this.status.content = this.previewStatus();
      this.status.fg = theme.muted;
      this.requestRender();
    } catch (error) {
      if (generation !== this.generation || this.isDestroyed || signal.aborted) return;
      this.status.content = this.options.i18n.t("preview.error", {
        message: errorMessage(error),
      });
      this.status.fg = theme.error;
      this.requestRender();
    }
  }

  private async loadNextTextChunk(): Promise<void> {
    const current = this.textPreview;
    if (!current || this.isDestroyed || this.loadAbort.signal.aborted) return;
    const target = Math.min(
      TEXT_PREVIEW_HARD_LIMIT,
      current.descriptor.size,
      current.bytesLoaded + TEXT_CHUNK_BYTES,
    );
    if (target <= current.bytesLoaded) return;
    const generation = this.generation;
    this.loadMoreButton.content = " Loading next 512 KiB… ";
    this.requestRender();
    try {
      await this.renderTextPreview(current, target, generation, this.loadAbort.signal);
    } catch (error) {
      if (generation !== this.generation || this.isDestroyed || this.loadAbort.signal.aborted)
        return;
      this.status.content = this.options.i18n.t("preview.error", {
        message: errorMessage(error),
      });
      this.status.fg = theme.error;
    } finally {
      if (generation === this.generation && !this.isDestroyed && !this.loadAbort.signal.aborted) {
        this.loadMoreButton.content = " Load next 512 KiB ";
        this.refreshActionVisibility();
        this.requestRender();
      }
    }
  }

  private async renderTextPreview(
    state: NonNullable<RichDocumentRenderable["textPreview"]>,
    requestedBytes: number,
    generation: number,
    signal: AbortSignal,
  ): Promise<void> {
    const targetBytes = Math.max(
      state.bytesLoaded,
      Math.min(TEXT_PREVIEW_HARD_LIMIT, requestedBytes),
    );
    const nextLength = targetBytes - state.bytesLoaded;
    const next =
      nextLength > 0
        ? await this.options.loader.read(state.location, {
            offset: state.bytesLoaded,
            length: nextLength,
            signal,
          })
        : new Uint8Array();
    if (generation !== this.generation || this.isDestroyed || signal.aborted) return;
    const bytes = new Uint8Array(state.bytes.byteLength + next.byteLength);
    bytes.set(state.bytes, 0);
    bytes.set(next, state.bytes.byteLength);
    await this.clearRenderedDocument();
    if (generation !== this.generation || this.isDestroyed || signal.aborted) return;
    const source = new TextDecoder().decode(bytes);
    if (state.markdown) {
      const document = await parseRichDocument(source);
      if (generation !== this.generation || this.isDestroyed || signal.aborted) return;
      this.renderMarkdown(document);
    } else {
      this.scroll.add(
        new TextRenderable(this.ctx, {
          id: `${this.id}-text`,
          width: "100%",
          content: source,
          fg: theme.foreground,
          selectable: true,
        }),
      );
    }
    this.textPreview = { ...state, bytesLoaded: bytes.byteLength, bytes };
    const remaining = state.descriptor.size > bytes.byteLength;
    const capped = bytes.byteLength >= TEXT_PREVIEW_HARD_LIMIT;
    this.status.content = `${this.previewStatus()} · ${formatByteCount(bytes.byteLength)} of ${formatByteCount(
      state.descriptor.size,
    )}${capped && remaining ? " · 8 MiB preview limit reached" : ""}`;
    this.status.fg = theme.muted;
    this.refreshActionVisibility();
  }

  private renderBinaryMetadata(descriptor: ResourceDescriptor): void {
    this.textPreview = undefined;
    this.scroll.add(
      new TextRenderable(this.ctx, {
        id: `${this.id}-binary-metadata`,
        width: "100%",
        content: [
          this.pane.title,
          "",
          descriptor.mimeType ?? "Unknown binary file",
          formatByteCount(descriptor.size),
          "",
          "Binary content is not decoded as text. Use Download for a remote file.",
        ].join("\n"),
        fg: theme.foreground,
        selectable: true,
      }),
    );
    this.refreshActionVisibility();
  }

  private async clearRenderedDocument(): Promise<void> {
    if (this.fullscreenOrigin) this.restoreFullscreenMedia();
    const media = [...this.mediaBlocks];
    const formulas = [...this.formulaBlocks];
    await this.clearLazyBlocks();
    this.captureHighlighting(this.scroll);
    for (const child of [...this.scroll.getChildren()]) {
      this.scroll.remove(child);
      child.destroyRecursively();
    }
    await Promise.all([
      ...media.map((block) => block.waitForDisposal()),
      ...formulas.map((block) => block.waitForDisposal()),
    ]);
    this.mediaBlocks.length = 0;
    this.formulaBlocks.length = 0;
    this.selectedMediaIndex = -1;
  }

  private previewStatus(): string {
    return `${this.options.i18n.t("preview.adapter", {
      adapter: `${this.options.adapter.protocol} (${this.options.adapter.terminal})`,
    })}  ·  ${this.options.i18n.t("preview.shortcuts")}`;
  }

  private renderMarkdown(document: RichDocument): void {
    const renderedMedia = new Set<string>();
    const renderedMath = new Set<string>();
    const markdown = new MarkdownRenderable(this.ctx, {
      id: `${this.id}-markdown`,
      width: "100%",
      content: document.source,
      syntaxStyle: documentSyntaxStyle,
      conceal: true,
      internalBlockMode: "top-level",
      tableOptions: {
        style: "grid",
        widthMode: "full",
        wrapMode: "word",
        borders: true,
        borderStyle: "rounded",
        borderColor: theme.border,
      },
      renderNode: (token, context) => {
        if (token.type !== "paragraph") return undefined;
        const media = document.media.filter(
          (item) => !renderedMedia.has(item.id) && mediaOccursInToken(item, token),
        );
        const math = document.math.filter(
          (item) => !renderedMath.has(item.id) && token.raw.includes(item.source),
        );
        if (media.length === 0 && math.length === 0) return undefined;
        const container = new BoxRenderable(this.ctx, {
          id: `${this.id}-rich-${renderedMedia.size}-${renderedMath.size}`,
          width: "100%",
          flexDirection: "column",
        });
        const normal = context.defaultRender();
        if (normal) container.add(normal);
        for (const item of media) {
          renderedMedia.add(item.id);
          container.add(this.mediaBlock(item));
        }
        for (const item of math) {
          renderedMath.add(item.id);
          container.add(this.formulaBlock(item));
        }
        return container;
      },
    });
    this.scroll.add(markdown);

    const remainingMedia = document.media.filter((item) => !renderedMedia.has(item.id));
    const remainingMath = document.math.filter((item) => !renderedMath.has(item.id));
    for (const item of remainingMedia) this.scroll.add(this.mediaBlock(item));
    for (const item of remainingMath) this.scroll.add(this.formulaBlock(item));
    this.scheduleViewportEvaluation();
  }

  private renderDirectMedia(extension: string, mimeType?: string): void {
    const item: RichMedia = {
      id: `direct-${crypto.randomUUID()}`,
      kind: isVideoExtension(extension, mimeType) ? "video" : "image",
      sources: [{ uri: this.pane.path, mimeType }],
      alt: this.pane.title,
      controls: isVideoExtension(extension, mimeType),
      autoplay: false,
      loop: extension === ".gif",
      muted: false,
    };
    this.scroll.add(this.mediaBlock(item));
    this.scheduleViewportEvaluation();
  }

  private mediaBlock(media: RichMedia): DocumentMediaBlockRenderable {
    let block: DocumentMediaBlockRenderable;
    block = new DocumentMediaBlockRenderable(
      this.ctx,
      media,
      documentLocation(this.pane),
      this.mediaDependencies(() => this.requestLazyActivation(block)),
    );
    this.mediaBlocks.push(block);
    this.registerLazyBlock(block);
    if (block.isPlayable() && this.selectedMediaIndex < 0) {
      this.selectedMediaIndex = this.mediaBlocks.length - 1;
      block.setSelected(true);
    }
    return block;
  }

  private formulaBlock(expression: RichMathExpression): FormulaMediaBlockRenderable {
    let block: FormulaMediaBlockRenderable;
    block = new FormulaMediaBlockRenderable(
      this.ctx,
      expression,
      this.mediaDependencies(() => this.requestLazyActivation(block)),
    );
    this.formulaBlocks.push(block);
    this.registerLazyBlock(block);
    return block;
  }

  private mediaDependencies(onActivationRequested?: () => void): MediaBlockDependencies {
    return {
      loader: this.options.loader,
      decoder: this.options.decoder,
      rasterizer: this.options.rasterizer,
      formula: this.options.formula,
      adapter: this.options.adapter.name,
      terminal: this.options.adapter.terminal,
      output: this.options.output,
      i18n: this.options.i18n,
      videoFramesPerSecond: this.options.videoFramesPerSecond,
      autoplayGif: this.options.autoplayGif,
      mpv: this.options.mpv,
      presented: this.presented,
      signal: this.loadAbort.signal,
      onActivationRequested,
      onPermissionRequired: (domain, retry) => this.notePermission(domain, retry),
      onSelectMedia: (block) => this.selectMediaBlock(block),
      onToggleFullscreen: (block) => {
        this.selectMediaBlock(block);
        this.toggleMediaFullscreen();
      },
    };
  }

  private notePermission(domain: string, retry: () => void): void {
    const retries = this.pendingPermissions.get(domain) ?? new Set();
    retries.add(retry);
    this.pendingPermissions.set(domain, retries);
    this.status.content = this.options.i18n.t("preview.permission", { domain });
    this.status.fg = theme.warning;
    this.refreshActionVisibility();
    this.requestRender();
  }

  private async approvePending(scope: DomainPermissionScope): Promise<void> {
    const entry = this.pendingPermissions.entries().next().value as
      | [string, Set<() => void>]
      | undefined;
    if (!entry) return;
    const [domain, retries] = entry;
    try {
      await this.options.permissions.allow(domain, scope);
      this.pendingPermissions.delete(domain);
      for (const retry of retries) retry();
      this.status.content = this.options.i18n.t("preview.shortcuts");
      this.status.fg = theme.muted;
    } catch (error) {
      this.status.content = this.options.i18n.t("preview.error", {
        message: errorMessage(error),
      });
      this.status.fg = theme.error;
    }
    this.refreshActionVisibility();
    this.requestRender();
  }

  private refreshActionVisibility(): void {
    const text = this.textPreview;
    const canLoadMore = Boolean(
      text && text.bytesLoaded < text.descriptor.size && text.bytesLoaded < TEXT_PREVIEW_HARD_LIMIT,
    );
    const hasPermission = this.pendingPermissions.size > 0;
    this.allowOnceButton.visible = hasPermission;
    this.allowPersistButton.visible = hasPermission;
    this.loadMoreButton.visible = canLoadMore;
    this.permissionActions.visible = hasPermission || canLoadMore;
  }

  private persistScroll(): void {
    this.pane = { ...this.pane, scrollOffset: Math.max(0, Math.floor(this.scroll.scrollTop)) };
    this.options.onPaneUpdate?.(this.pane);
  }

  private handleScroll(): void {
    this.persistScroll();
    this.scheduleViewportEvaluation();
  }

  private registerLazyBlock(block: LazyDocumentBlock): void {
    this.lazyBlocks.set(block, { status: "idle", inPreloadRange: false });
  }

  private requestLazyActivation(block: LazyDocumentBlock): void {
    const state = this.lazyBlocks.get(block);
    if (!state || this.isDestroyed) return;
    state.status = "idle";
    this.scheduleViewportEvaluation();
  }

  private scheduleViewportEvaluation(): void {
    if (this.viewportFramePending || this.isDestroyed || !this.presented) return;
    this.viewportFramePending = true;
    this.ctx.on(CliRenderEvents.FRAME, this.onViewportFrame);
    this.requestRender();
  }

  private detachViewportFrame(): void {
    if (!this.viewportFramePending) return;
    this.ctx.off(CliRenderEvents.FRAME, this.onViewportFrame);
    this.viewportFramePending = false;
  }

  private evaluateLazyBlocks(): void {
    if (this.isDestroyed || !this.presented || this.scroll.height <= 0) return;
    const viewportTop = this.scroll.screenY;
    const viewportBottom = viewportTop + this.scroll.height;
    const preloadTop = viewportTop - this.scroll.height;
    const preloadBottom = viewportBottom + this.scroll.height;
    for (const [block, state] of this.lazyBlocks) {
      if (block.isDestroyed) continue;
      const blockTop = block.screenY;
      const blockBottom = blockTop + Math.max(1, block.height);
      const visible = blockBottom > viewportTop && blockTop < viewportBottom;
      if (block instanceof DocumentMediaBlockRenderable) block.setViewportVisible(visible);
      const inPreloadRange = blockBottom > preloadTop && blockTop < preloadBottom;
      state.inPreloadRange = inPreloadRange;
      if (inPreloadRange && state.status === "idle" && !block.isReady()) {
        state.status = "queued";
        this.lazyQueue.push(block);
      } else if (!inPreloadRange && state.status === "queued") {
        state.status = "idle";
      } else if (!inPreloadRange && state.status === "running") {
        state.controller?.abort(new DOMException("Media left the preload viewport", "AbortError"));
      }
    }
    this.pumpLazyQueue();
  }

  private pumpLazyQueue(): void {
    if (this.isDestroyed || !this.presented) return;
    while (this.runningLazyTasks < 2) {
      const block = this.lazyQueue.shift();
      if (!block) return;
      const state = this.lazyBlocks.get(block);
      if (state?.status !== "queued" || !state.inPreloadRange || block.isDestroyed) continue;
      const controller = new AbortController();
      state.status = "running";
      state.controller = controller;
      this.runningLazyTasks += 1;
      const task = block.activate(controller.signal).finally(() => {
        this.runningLazyTasks = Math.max(0, this.runningLazyTasks - 1);
        state.controller = undefined;
        state.task = undefined;
        if (this.lazyBlocks.get(block) === state) {
          state.status = controller.signal.aborted ? "idle" : "done";
          if (state.inPreloadRange && controller.signal.aborted && this.presented) {
            state.status = "queued";
            this.lazyQueue.push(block);
          }
        }
        this.pumpLazyQueue();
      });
      state.task = task;
      const observed = task.catch(() => undefined);
      this.disposalTasks.add(observed);
      void observed;
    }
  }

  private cancelLazyTasks(): void {
    this.lazyQueue.length = 0;
    for (const state of this.lazyBlocks.values()) {
      state.inPreloadRange = false;
      if (state.status === "queued") state.status = "idle";
      state.controller?.abort(
        new DOMException("Document media scheduling cancelled", "AbortError"),
      );
    }
  }

  private async clearLazyBlocks(): Promise<void> {
    this.cancelLazyTasks();
    const running = [...this.lazyBlocks.values()].flatMap((state) =>
      state.task ? [state.task] : [],
    );
    await Promise.allSettled(running);
    this.lazyBlocks.clear();
    this.lazyQueue.length = 0;
  }

  private captureHighlighting(root: Renderable): void {
    const pending: Promise<void>[] = [];
    const visit = (renderable: Renderable): void => {
      if (renderable instanceof CodeRenderable) pending.push(renderable.highlightingDone);
      for (const child of renderable.getChildren()) visit(child);
    };
    visit(root);
    for (const task of pending) {
      const observed = task.catch(() => undefined);
      this.disposalTasks.add(observed);
    }
  }

  private selectRelativeMedia(offset: number): void {
    const playable = this.mediaBlocks
      .map((block, index) => ({ block, index }))
      .filter(({ block }) => block.isPlayable());
    if (playable.length === 0) return;
    const current = playable.findIndex(({ index }) => index === this.selectedMediaIndex);
    const next =
      (((current < 0 ? 0 : current + offset) % playable.length) + playable.length) %
      playable.length;
    this.selectedMedia()?.setSelected(false);
    const selected = playable[next];
    if (!selected) return;
    this.selectedMediaIndex = selected.index;
    selected.block.setSelected(true);
    this.scroll.scrollChildIntoView(selected.block.id);
    this.requestRender();
  }

  private selectMediaBlock(block: DocumentMediaBlockRenderable): void {
    const index = this.mediaBlocks.indexOf(block);
    if (index < 0 || index === this.selectedMediaIndex) return;
    this.selectedMedia()?.setSelected(false);
    this.selectedMediaIndex = index;
    block.setSelected(true);
    if (!this.fullscreenOrigin) this.scroll.scrollChildIntoView(block.id);
    this.requestRender();
  }

  private runMediaControl(action: (block: DocumentMediaBlockRenderable) => Promise<void>): boolean {
    const block = this.selectedMedia();
    if (!block?.isPlayable()) return false;
    void action(block).catch((error) => {
      if (this.isDestroyed) return;
      this.status.content = this.options.i18n.t("preview.error", {
        message: errorMessage(error),
      });
      this.status.fg = theme.error;
      this.requestRender();
    });
    return true;
  }

  private toggleMediaFullscreen(): boolean {
    const block = this.selectedMedia();
    if (!block?.isPlayable()) return false;
    if (this.fullscreenOrigin) {
      if (this.fullscreenOrigin.block !== block) return false;
      this.restoreFullscreenMedia();
      return true;
    }
    const parent = block.parent;
    if (!parent) return false;
    const index = parent.getChildren().indexOf(block);
    this.fullscreenOrigin = { block, parent, index: Math.max(0, index) };
    parent.remove(block);
    this.scroll.visible = false;
    block.position = "absolute";
    block.top = 1;
    block.left = 0;
    block.right = undefined;
    block.bottom = undefined;
    block.width = "100%";
    block.height = Math.max(4, this.height - 3);
    block.marginTop = 0;
    block.zIndex = 100;
    block.setFullscreen(true);
    this.add(block);
    this.requestRender();
    return true;
  }

  private restoreFullscreenMedia(): void {
    const origin = this.fullscreenOrigin;
    if (!origin) return;
    this.fullscreenOrigin = undefined;
    this.remove(origin.block);
    origin.block.position = "relative";
    origin.block.top = undefined;
    origin.block.left = undefined;
    origin.block.right = undefined;
    origin.block.bottom = undefined;
    origin.block.width = "100%";
    origin.block.height = 14;
    origin.block.marginTop = 1;
    origin.block.zIndex = 0;
    origin.block.setFullscreen(false);
    origin.parent.add(origin.block, Math.min(origin.index, origin.parent.getChildrenCount()));
    this.scroll.visible = true;
    this.scroll.scrollChildIntoView(origin.block.id);
    this.requestRender();
  }

  private actionButton(
    renderer: CliRenderer,
    name: string,
    label: string,
    run: () => void,
  ): TextRenderable {
    return new TextRenderable(renderer, {
      id: `${this.id}-${name}`,
      content: label,
      fg: theme.accent,
      bg: theme.surfaceRaised,
      onMouseOver: () => renderer.setMousePointer("pointer"),
      onMouseOut: () => renderer.setMousePointer("default"),
      onMouseDown: (event) => {
        if (event.button !== MouseButton.LEFT) return;
        run();
        event.preventDefault();
        event.stopPropagation();
      },
    });
  }
}

function resourceLocation(pane: PreviewPaneState): ResourceLocation {
  return pane.target.kind === "local"
    ? { scheme: "file", path: pane.path }
    : { scheme: "sftp", hostId: pane.target.hostId, path: pane.path };
}

function documentLocation(pane: PreviewPaneState): DocumentLocation {
  return pane.target.kind === "local"
    ? { scheme: "file", path: pane.path }
    : { scheme: "sftp", hostId: pane.target.hostId, path: pane.path };
}

function targetLabel(target: PreviewPaneState["target"]): string {
  return target.kind === "local" ? "Local" : target.hostId;
}

class PersistentScrollBoxRenderable extends ScrollBoxRenderable {
  public constructor(
    ctx: CliRenderer,
    options: ConstructorParameters<typeof ScrollBoxRenderable>[1],
    private readonly onScrolled: () => void,
  ) {
    super(ctx, options);
  }

  protected override onMouseEvent(event: MouseEvent): void {
    super.onMouseEvent(event);
    if (event.type === "scroll") this.onScrolled();
  }
}

const documentSyntaxStyle = SyntaxStyle.fromStyles({
  "markup.heading.1": { fg: theme.accent, bold: true },
  "markup.heading.2": { fg: theme.accentSecondary, bold: true },
  "markup.list": { fg: theme.warning },
  "markup.link": { fg: theme.accent, underline: true },
  "markup.raw": { fg: theme.success },
  default: { fg: theme.foreground },
});

function mediaOccursInToken(media: RichMedia, token: { raw: string }): boolean {
  return (
    media.sources.some((source) => token.raw.includes(source.uri)) ||
    Boolean(media.posterUri && token.raw.includes(media.posterUri))
  );
}

function isMediaExtension(extension: string, mimeType?: string): boolean {
  return (
    [
      ".png",
      ".jpg",
      ".jpeg",
      ".webp",
      ".avif",
      ".svg",
      ".gif",
      ".bmp",
      ".tif",
      ".tiff",
      ".mp4",
      ".mov",
      ".mkv",
      ".webm",
      ".avi",
      ".m4v",
    ].includes(extension) ||
    Boolean(mimeType && (mimeType.startsWith("image/") || mimeType.startsWith("video/")))
  );
}

function isVideoExtension(extension: string, mimeType?: string): boolean {
  return (
    [".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v"].includes(extension) ||
    Boolean(mimeType?.startsWith("video/"))
  );
}

function isMarkdown(extension: string, mimeType?: string): boolean {
  return extension === ".md" || extension === ".markdown" || mimeType === "text/markdown";
}

function isLikelyBinary(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return true;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return true;
  }
  let controls = 0;
  for (const byte of bytes) {
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0c && byte !== 0x0d) {
      controls += 1;
    }
  }
  return bytes.byteLength > 0 && controls / bytes.byteLength > 0.01;
}

function formatByteCount(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function isSpace(key: KeyEvent): boolean {
  return key.name === "space" || key.name === " " || key.sequence === " ";
}

function isVolumeUp(key: KeyEvent): boolean {
  return key.name === "plus" || key.name === "+" || key.name === "equal" || key.name === "=";
}
