import { extname } from "node:path";
import {
  BoxRenderable,
  MouseButton,
  type MouseEvent,
  type RenderContext,
  ScrollBoxRenderable,
  SliderRenderable,
  TextAttributes,
  TextRenderable,
} from "@opentui/core";
import { errorMessage, TermLoomError } from "../core/errors.js";
import type { DocumentLocation, RichMathExpression, RichMedia } from "../document/model.js";
import type { ResourceLoader } from "../document/resource-loader.js";
import { resolveResourceLocation } from "../document/resource-location.js";
import type { I18n } from "../i18n/i18n.js";
import type { MediaDecoder } from "../media/decoder.js";
import type { FormulaRenderer } from "../media/formula-renderer.js";
import type { MpvControllerOptions } from "../media/mpv-controller.js";
import {
  MediaPlaybackController,
  type MediaPlaybackState,
  type PlaybackKind,
} from "../media/playback-controller.js";
import { MediaSurfaceRenderable } from "../media/surface-renderable.js";
import type { SvgRasterizer } from "../media/svg-rasterizer.js";
import type { MediaAdapterName, MediaAdapterSelection, MediaOutput } from "../media/types.js";
import { theme } from "./theme.js";

const MEDIA_CONTROLS_WIDTH = 68;

export interface MediaBlockDependencies {
  loader: ResourceLoader;
  decoder: MediaDecoder;
  rasterizer: SvgRasterizer;
  formula: FormulaRenderer;
  adapter: MediaAdapterName;
  terminal: MediaAdapterSelection["terminal"];
  output?: MediaOutput;
  i18n: I18n;
  videoFramesPerSecond?: number;
  autoplayGif?: boolean;
  presented?: boolean;
  signal?: AbortSignal;
  mpv?: MpvControllerOptions;
  onPermissionRequired(domain: string, retry: () => void): void;
  onActivationRequested?(): void;
  onSelectMedia?(block: DocumentMediaBlockRenderable): void;
  onToggleFullscreen?(block: DocumentMediaBlockRenderable): void;
}

export class DocumentMediaBlockRenderable extends BoxRenderable {
  private readonly status: TextRenderable;
  private readonly surface: MediaSurfaceRenderable;
  private readonly baseTitle: string;
  private readonly playButton: TextRenderable | undefined;
  private readonly muteButton: TextRenderable | undefined;
  private readonly fullscreenButton: TextRenderable | undefined;
  private readonly controls: ScrollBoxRenderable | undefined;
  private readonly seekSlider: SliderRenderable | undefined;
  private readonly volumeSlider: SliderRenderable | undefined;
  private playback: MediaPlaybackController | undefined;
  private playbackState: MediaPlaybackState | undefined;
  private loadPromise: Promise<void> = Promise.resolve();
  private disposalPromise: Promise<void> = Promise.resolve();
  private selected = false;
  private fullscreen = false;
  private generation = 0;
  private updatingControls = false;
  private presented = true;
  private viewportVisible = false;
  private resumeAfterPresentation = false;
  private resumeAfterViewport = false;
  private presentationGeneration = 0;
  private loadAbort: AbortController | undefined;
  private unlinkLoadSignals: (() => void) | undefined;
  private activationState: "idle" | "loading" | "ready" | "error" = "idle";

  public constructor(
    renderer: RenderContext,
    private readonly media: RichMedia,
    private readonly document: DocumentLocation,
    private readonly dependencies: MediaBlockDependencies,
  ) {
    const title = media.alt ?? media.title ?? media.kind;
    super(renderer, {
      id: `document-${media.id}`,
      width: "100%",
      height: 14,
      flexDirection: "column",
      border: true,
      borderStyle: "rounded",
      borderColor: theme.border,
      title,
      titleColor: theme.accentSecondary,
      overflow: "hidden",
      marginTop: 1,
    });
    this.baseTitle = title;
    this.surface = new MediaSurfaceRenderable(renderer, {
      id: `surface-${media.id}`,
      adapter: dependencies.adapter,
      terminal: dependencies.terminal,
      output: dependencies.output,
      width: "100%",
      flexGrow: 1,
      minHeight: 4,
      zIndex: 10,
    });
    this.presented = dependencies.presented ?? true;
    this.surface.setPresented(this.presented);
    this.surface.onMouseDown = (event) => {
      if (event.button !== MouseButton.LEFT) return;
      this.dependencies.onSelectMedia?.(this);
      event.preventDefault();
      event.stopPropagation();
    };
    this.status = new TextRenderable(renderer, {
      id: `status-${media.id}`,
      height: 1,
      width: "100%",
      content: dependencies.i18n.t("preview.mediaLoading", { kind: media.kind }),
      fg: theme.muted,
      attributes: TextAttributes.DIM,
    });
    this.add(this.surface);
    this.add(this.status);
    if (this.isPlayable()) {
      const controls = new ScrollBoxRenderable(renderer, {
        id: `controls-${media.id}`,
        width: "100%",
        height: 1,
        scrollX: true,
        scrollY: false,
        viewportCulling: true,
        rootOptions: { backgroundColor: theme.surfaceRaised },
        contentOptions: {
          flexDirection: "row",
          width: MEDIA_CONTROLS_WIDTH,
          height: 1,
          backgroundColor: theme.surfaceRaised,
        },
        zIndex: 20,
      });
      this.controls = controls;
      this.playButton = this.controlButton(renderer, "play", " Play ", () =>
        this.runControl(() => this.togglePlayback()),
      );
      controls.add(this.playButton);
      controls.add(
        new TextRenderable(renderer, {
          id: `seek-label-${media.id}`,
          content: " Seek ",
          flexShrink: 0,
          fg: theme.muted,
          bg: theme.surfaceRaised,
        }),
      );
      this.seekSlider = new SliderRenderable(renderer, {
        id: `seek-${media.id}`,
        orientation: "horizontal",
        width: 20,
        flexShrink: 0,
        height: 1,
        min: 0,
        max: 1,
        value: 0,
        viewPortSize: 0.05,
        backgroundColor: theme.border,
        foregroundColor: theme.accent,
        zIndex: 21,
        onChange: (value) => {
          if (!this.updatingControls) this.runControl(() => this.seekTo(value));
        },
      });
      controls.add(this.seekSlider);
      controls.add(
        new TextRenderable(renderer, {
          id: `volume-label-${media.id}`,
          content: " Vol ",
          flexShrink: 0,
          fg: theme.muted,
          bg: theme.surfaceRaised,
        }),
      );
      this.volumeSlider = new SliderRenderable(renderer, {
        id: `volume-${media.id}`,
        orientation: "horizontal",
        width: 10,
        flexShrink: 0,
        height: 1,
        min: 0,
        max: 100,
        value: 100,
        viewPortSize: 5,
        backgroundColor: theme.border,
        foregroundColor: theme.accentSecondary,
        zIndex: 21,
        onChange: (value) => {
          if (!this.updatingControls) this.runControl(() => this.setVolume(value));
        },
      });
      controls.add(this.volumeSlider);
      this.muteButton = this.controlButton(renderer, "mute", " Mute ", () =>
        this.runControl(() => this.toggleMuted()),
      );
      controls.add(this.muteButton);
      this.fullscreenButton = this.controlButton(renderer, "fullscreen", " Fullscreen ", () => {
        this.dependencies.onSelectMedia?.(this);
        this.dependencies.onToggleFullscreen?.(this);
      });
      controls.add(this.fullscreenButton);
      this.add(controls);
    } else {
      this.controls = undefined;
      this.playButton = undefined;
      this.muteButton = undefined;
      this.fullscreenButton = undefined;
      this.seekSlider = undefined;
      this.volumeSlider = undefined;
    }
    this.onMouseDown = (event) => this.handleMouse(event);
    this.onMouseDrag = (event) => this.handleMouse(event);
    this.onMouseScroll = (event) => this.handleControlScroll(event);
  }

  public retry(): void {
    if (this.isDestroyed) return;
    this.activationState = "idle";
    this.dependencies.onActivationRequested?.();
  }

  public activate(signal?: AbortSignal): Promise<void> {
    if (this.isDestroyed || this.activationState === "ready") return Promise.resolve();
    if (this.activationState === "loading") return this.loadPromise;
    this.cancelActivation();
    const controller = new AbortController();
    this.loadAbort = controller;
    this.unlinkLoadSignals = linkAbortSignals(controller, [this.dependencies.signal, signal]);
    this.activationState = "loading";
    const task = this.load(controller.signal).finally(() => {
      this.unlinkLoadSignals?.();
      this.unlinkLoadSignals = undefined;
      if (this.loadAbort === controller) this.loadAbort = undefined;
      if (controller.signal.aborted && this.activationState === "loading") {
        this.activationState = "idle";
      }
    });
    this.loadPromise = task;
    void task.catch(() => undefined);
    return task;
  }

  public cancelActivation(): void {
    this.loadAbort?.abort(new DOMException("Media activation cancelled", "AbortError"));
  }

  public isReady(): boolean {
    return this.activationState === "ready";
  }

  public isPlayable(): boolean {
    return playbackKind(this.media) !== undefined;
  }

  public inspectPlayback(): MediaPlaybackState | undefined {
    return this.playbackState ? { ...this.playbackState } : undefined;
  }

  public inspectFrame() {
    return this.surface.inspectFrame();
  }

  public inspectProcesses(): { ffmpeg?: number; mpv?: number } {
    return this.playback?.inspectProcesses() ?? {};
  }

  public setSelected(selected: boolean): void {
    this.selected = selected;
    this.borderColor = selected ? theme.activeBorder : theme.border;
    this.updateTitle();
  }

  public setFullscreen(fullscreen: boolean): void {
    this.fullscreen = fullscreen;
    this.updateTitle();
    if (this.playbackState) this.showPlaybackState(this.playbackState);
  }

  public setPresented(presented: boolean): void {
    if (this.presented === presented || this.isDestroyed) return;
    this.presented = presented;
    this.surface.setPresented(presented);
    const generation = ++this.presentationGeneration;
    const playback = this.playback;
    if (!playback) {
      if (!presented && this.shouldAutoplay()) this.resumeAfterPresentation = true;
      return;
    }
    if (!presented) {
      if (playback.inspect().status === "playing") this.resumeAfterPresentation = true;
      void playback.pause().catch(() => undefined);
      return;
    }
    if (!this.resumeAfterPresentation || !this.canResumePlayback()) return;
    this.resumeAfterPresentation = false;
    void playback
      .play()
      .catch(() => undefined)
      .then(() => {
        if (generation !== this.presentationGeneration || !this.presented) return;
        this.requestRender();
      });
  }

  public setViewportVisible(visible: boolean): void {
    if (this.viewportVisible === visible || this.isDestroyed) return;
    this.viewportVisible = visible;
    if (playbackKind(this.media) !== "gif") return;
    const playback = this.playback;
    if (!playback) {
      if (!visible && this.shouldAutoplay()) this.resumeAfterViewport = true;
      return;
    }
    const generation = ++this.presentationGeneration;
    if (!visible) {
      if (playback.inspect().status === "playing") this.resumeAfterViewport = true;
      void playback.pause().catch(() => undefined);
      return;
    }
    if (!this.presented || !this.resumeAfterViewport) return;
    this.resumeAfterViewport = false;
    void playback
      .play()
      .catch(() => undefined)
      .then(() => {
        if (generation !== this.presentationGeneration || !this.viewportVisible || !this.presented)
          return;
        this.requestRender();
      });
  }

  public async togglePlayback(): Promise<void> {
    await (await this.requirePlayback()).toggle();
  }

  public async seekBy(seconds: number): Promise<void> {
    await (await this.requirePlayback()).seekBy(seconds);
  }

  public async seekTo(seconds: number): Promise<void> {
    await (await this.requirePlayback()).seek(seconds);
  }

  public async adjustVolume(delta: number): Promise<void> {
    await (await this.requirePlayback()).adjustVolume(delta);
  }

  public async setVolume(volume: number): Promise<void> {
    await (await this.requirePlayback()).setVolume(volume);
  }

  public async toggleMuted(): Promise<void> {
    await (await this.requirePlayback()).toggleMuted();
  }

  public waitForDisposal(): Promise<void> {
    return Promise.all([this.loadPromise.catch(() => undefined), this.disposalPromise]).then(
      () => undefined,
    );
  }

  protected override destroySelf(): void {
    this.generation += 1;
    this.presentationGeneration += 1;
    this.cancelActivation();
    this.unlinkLoadSignals?.();
    this.unlinkLoadSignals = undefined;
    this.presented = false;
    this.surface.setPresented(false);
    const playback = this.playback;
    this.playback = undefined;
    this.disposalPromise = playback?.dispose() ?? Promise.resolve();
    super.destroySelf();
  }

  private async load(signal: AbortSignal): Promise<void> {
    const generation = ++this.generation;
    const previous = this.playback;
    this.playback = undefined;
    this.playbackState = undefined;
    await previous?.dispose();
    if (generation !== this.generation || this.isDestroyed || signal.aborted) return;
    this.status.content = this.dependencies.i18n.t("preview.mediaLoading", {
      kind: this.media.kind,
    });
    this.status.fg = theme.muted;
    try {
      const kind = playbackKind(this.media);
      if (this.media.posterUri) await this.loadStill(this.media.posterUri, generation, signal);
      const source = preferredSource(this.media);
      if (!source) throw new Error("Media has no source");
      if (!kind) {
        if (!this.media.posterUri) await this.loadStill(source.uri, generation, signal);
        this.showStaticReady(generation);
        this.activationState = "ready";
        return;
      }

      const location = resolveResourceLocation(source.uri, this.document);
      const loaded = await this.dependencies.loader.load(location, {
        signal,
      });
      if (generation !== this.generation || this.isDestroyed || signal.aborted) return;
      const controller = new MediaPlaybackController(loaded.localPath, this.dependencies.decoder, {
        kind,
        framesPerSecond: this.dependencies.videoFramesPerSecond ?? 24,
        loop: kind === "gif" || this.media.loop,
        autoplay:
          this.presented && (kind !== "gif" || this.viewportVisible) && this.shouldAutoplay(),
        muted: this.media.muted,
        mpv: this.dependencies.mpv,
      });
      this.playback = controller;
      controller.onFrame((frame) => {
        if (generation !== this.generation || this.isDestroyed) return;
        this.surface.setFrame(frame);
      });
      controller.onState((state) => {
        if (generation !== this.generation || this.isDestroyed) return;
        this.playbackState = state;
        this.showPlaybackState(state);
      });
      await controller.initialize();
      if (kind === "gif" && this.shouldAutoplay() && !this.viewportVisible) {
        this.resumeAfterViewport = true;
      }
      if (!this.presented && controller.inspect().status === "playing") {
        this.resumeAfterPresentation = true;
        await controller.pause();
      }
      if (generation !== this.generation || this.isDestroyed || signal.aborted) {
        await controller.dispose();
        return;
      }
      this.activationState = "ready";
    } catch (error) {
      if (generation !== this.generation || this.isDestroyed || signal.aborted) return;
      this.activationState = "error";
      const domain = permissionDomain(error);
      if (domain) {
        this.status.content = this.dependencies.i18n.t("preview.permission", { domain });
        this.status.fg = theme.warning;
        this.dependencies.onPermissionRequired(domain, () => this.retry());
      } else {
        this.status.content = this.dependencies.i18n.t("preview.error", {
          message: errorMessage(error),
        });
        this.status.fg = theme.error;
      }
      this.requestRender();
    }
  }

  private async loadStill(
    reference: string,
    generation: number,
    signal: AbortSignal,
  ): Promise<void> {
    const location = resolveResourceLocation(reference, this.document);
    const loaded = await this.dependencies.loader.load(location, {
      signal,
    });
    let localPath = loaded.localPath;
    if (loaded.mimeType === "image/svg+xml" || extname(localPath).toLocaleLowerCase() === ".svg") {
      localPath = await this.dependencies.rasterizer.rasterizeFile(localPath, {
        signal,
      });
    }
    const frame = await this.dependencies.decoder.decodeFrame(localPath, 0, {
      signal,
    });
    if (generation !== this.generation || this.isDestroyed) return;
    this.surface.setFrame(frame);
  }

  private showStaticReady(generation: number): void {
    if (generation !== this.generation || this.isDestroyed) return;
    const frame = this.surface.inspectFrame();
    if (!frame) throw new Error("Media decoder returned no frame");
    this.status.content = this.dependencies.i18n.t("preview.mediaReady", {
      kind: this.media.kind,
      width: frame.width,
      height: frame.height,
      adapter: this.dependencies.adapter,
    });
    this.status.fg = theme.success;
    this.requestRender();
  }

  private showPlaybackState(state: MediaPlaybackState): void {
    const i18n = this.dependencies.i18n;
    this.status.content = i18n.t("preview.mediaPlayback", {
      kind: i18n.t(state.kind === "gif" ? "preview.kindGif" : "preview.kindVideo"),
      status: localizedPlaybackStatus(i18n, state),
      position: formatTimestamp(state.positionSeconds),
      duration: formatTimestamp(state.durationSeconds),
      volume: Math.round(state.volume),
      sound: i18n.t(state.muted ? "preview.soundMuted" : "preview.soundAudible"),
      adapter: this.dependencies.adapter,
      view: i18n.t(this.fullscreen ? "preview.viewFullscreen" : "preview.viewPane"),
    });
    this.status.fg = state.status === "error" ? theme.error : theme.success;
    this.updatingControls = true;
    try {
      if (this.playButton) {
        this.playButton.content = state.status === "playing" ? " Pause " : " Play ";
      }
      if (this.muteButton) this.muteButton.content = state.muted ? " Unmute " : " Mute ";
      if (this.seekSlider) {
        this.seekSlider.max = Math.max(0.01, state.durationSeconds);
        this.seekSlider.value = Math.min(state.positionSeconds, this.seekSlider.max);
      }
      if (this.volumeSlider) this.volumeSlider.value = state.volume;
    } finally {
      this.updatingControls = false;
    }
    this.requestRender();
  }

  private controlButton(
    renderer: RenderContext,
    name: string,
    label: string,
    run: () => void,
  ): TextRenderable {
    return new TextRenderable(renderer, {
      id: `${name}-${this.media.id}`,
      content: label,
      flexShrink: 0,
      fg: theme.accent,
      bg: theme.surfaceRaised,
      zIndex: 21,
      onMouseOver: () => this.ctx.setMousePointer("pointer"),
      onMouseOut: () => this.ctx.setMousePointer("default"),
      onMouseDown: (event) => {
        if (event.button !== MouseButton.LEFT) return;
        this.dependencies.onSelectMedia?.(this);
        run();
        event.preventDefault();
        event.stopPropagation();
      },
    });
  }

  private runControl(action: () => Promise<void>): void {
    void action().catch((error) => {
      if (this.isDestroyed) return;
      this.status.content = this.dependencies.i18n.t("preview.error", {
        message: errorMessage(error),
      });
      this.status.fg = theme.error;
      this.requestRender();
    });
  }

  private handleMouse(event: MouseEvent): void {
    if (event.button !== MouseButton.LEFT) return;
    this.dependencies.onSelectMedia?.(this);
    if (!this.controls || event.y !== this.controls.screenY) return;
    if (containsPoint(this.playButton, event.x, event.y)) {
      this.runControl(() => this.togglePlayback());
    } else if (containsPoint(this.seekSlider, event.x, event.y) && this.seekSlider) {
      this.seekSlider.value = valueAtMouse(this.seekSlider, event.x, 0, this.seekSlider.max);
    } else if (containsPoint(this.volumeSlider, event.x, event.y) && this.volumeSlider) {
      this.volumeSlider.value = valueAtMouse(this.volumeSlider, event.x, 0, 100);
    } else if (containsPoint(this.muteButton, event.x, event.y)) {
      this.runControl(() => this.toggleMuted());
    } else if (containsPoint(this.fullscreenButton, event.x, event.y)) {
      this.dependencies.onToggleFullscreen?.(this);
    } else {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  }

  private handleControlScroll(event: MouseEvent): void {
    if (!this.controls || !containsPoint(this.controls, event.x, event.y)) return;
    const direction = event.scroll?.direction;
    if (!direction) return;
    const magnitude = Math.max(3, event.scroll?.delta ?? 0);
    const delta = direction === "left" || direction === "up" ? -magnitude : magnitude;
    this.controls.scrollBy({ x: delta, y: 0 });
    event.preventDefault();
    event.stopPropagation();
  }

  private async requirePlayback(): Promise<MediaPlaybackController> {
    await this.loadPromise;
    if (this.isDestroyed) throw new Error("Media block is destroyed");
    if (!this.playback) throw new Error("Selected media is not playable");
    return this.playback;
  }

  private updateTitle(): void {
    const selection = this.selected ? "▶ " : "";
    const fullscreen = this.fullscreen
      ? ` · ${this.dependencies.i18n.t("preview.viewFullscreen")}`
      : "";
    this.title = `${selection}${this.baseTitle}${fullscreen}`;
  }

  private shouldAutoplay(): boolean {
    return playbackKind(this.media) === "gif"
      ? (this.dependencies.autoplayGif ?? true)
      : this.media.autoplay;
  }

  private canResumePlayback(): boolean {
    return this.presented && (playbackKind(this.media) !== "gif" || this.viewportVisible);
  }
}

function containsPoint(
  renderable: { screenX: number; screenY: number; width: number; height: number } | undefined,
  x: number,
  y: number,
): boolean {
  return Boolean(
    renderable &&
      x >= renderable.screenX &&
      x < renderable.screenX + renderable.width &&
      y >= renderable.screenY &&
      y < renderable.screenY + renderable.height,
  );
}

function valueAtMouse(
  renderable: { screenX: number; width: number },
  x: number,
  min: number,
  max: number,
): number {
  const ratio = Math.max(
    0,
    Math.min(1, (x - renderable.screenX) / Math.max(1, renderable.width - 1)),
  );
  return min + ratio * (max - min);
}

export class FormulaMediaBlockRenderable extends BoxRenderable {
  private readonly status: TextRenderable;
  private readonly surface: MediaSurfaceRenderable;
  private generation = 0;
  private presented = true;
  private abort: AbortController | undefined;
  private unlinkSignals: (() => void) | undefined;
  private loadPromise: Promise<void> = Promise.resolve();
  private activationState: "idle" | "loading" | "ready" | "error" = "idle";

  public constructor(
    renderer: RenderContext,
    private readonly expression: RichMathExpression,
    private readonly dependencies: MediaBlockDependencies,
  ) {
    const inline = !expression.display;
    super(renderer, {
      id: `document-${expression.id}`,
      width: inline ? 12 : "100%",
      height: inline ? 2 : 4,
      flexDirection: "column",
      overflow: "hidden",
      marginTop: inline ? 0 : 1,
      marginBottom: inline ? 0 : 1,
      flexShrink: 0,
    });
    this.surface = new MediaSurfaceRenderable(renderer, {
      id: `surface-${expression.id}`,
      adapter: dependencies.adapter,
      terminal: dependencies.terminal,
      output: dependencies.output,
      width: "100%",
      height: "100%",
      flexGrow: 0,
      minHeight: 1,
    });
    this.presented = dependencies.presented ?? true;
    this.surface.setPresented(this.presented);
    this.status = new TextRenderable(renderer, {
      id: `status-${expression.id}`,
      height: 0,
      width: "100%",
      content: dependencies.i18n.t("preview.mediaLoading", { kind: "formula" }),
      fg: theme.muted,
      visible: false,
    });
    this.add(this.surface);
    this.add(this.status);
  }

  public activate(signal?: AbortSignal): Promise<void> {
    if (this.isDestroyed || this.activationState === "ready") return Promise.resolve();
    if (this.activationState === "loading") return this.loadPromise;
    this.cancelActivation();
    const controller = new AbortController();
    this.abort = controller;
    this.unlinkSignals = linkAbortSignals(controller, [this.dependencies.signal, signal]);
    this.activationState = "loading";
    const task = this.load(controller.signal).finally(() => {
      this.unlinkSignals?.();
      this.unlinkSignals = undefined;
      if (this.abort === controller) this.abort = undefined;
      if (controller.signal.aborted && this.activationState === "loading") {
        this.activationState = "idle";
      }
    });
    this.loadPromise = task;
    void task.catch(() => undefined);
    return task;
  }

  public cancelActivation(): void {
    this.abort?.abort(new DOMException("Formula activation cancelled", "AbortError"));
  }

  public isReady(): boolean {
    return this.activationState === "ready";
  }

  protected override destroySelf(): void {
    this.generation += 1;
    this.cancelActivation();
    this.unlinkSignals?.();
    this.unlinkSignals = undefined;
    this.surface.setPresented(false);
    super.destroySelf();
  }

  public setPresented(presented: boolean): void {
    if (this.presented === presented || this.isDestroyed) return;
    this.presented = presented;
    this.surface.setPresented(presented);
  }

  public waitForDisposal(): Promise<void> {
    return this.loadPromise.catch(() => undefined);
  }

  private async load(signal: AbortSignal): Promise<void> {
    const generation = ++this.generation;
    try {
      const path = await this.dependencies.formula.render(
        this.expression.source,
        this.expression.display,
        signal,
      );
      const frame = await this.dependencies.decoder.decodeFrame(path, 0, {
        signal,
      });
      if (generation !== this.generation || this.isDestroyed || signal.aborted) return;
      if (!this.expression.display) {
        this.width = inlineFormulaWidth(frame.width, frame.height, this.height);
      }
      this.surface.setFrame(frame);
      this.status.content = this.dependencies.i18n.t("preview.mediaReady", {
        kind: "formula",
        width: frame.width,
        height: frame.height,
        adapter: this.dependencies.adapter,
      });
      this.status.fg = theme.success;
      this.activationState = "ready";
    } catch (error) {
      if (generation !== this.generation || this.isDestroyed || signal.aborted) return;
      this.activationState = "error";
      this.status.content = this.dependencies.i18n.t("preview.error", {
        message: errorMessage(error),
      });
      this.status.fg = theme.error;
      this.requestRender();
    }
  }
}

function inlineFormulaWidth(sourceWidth: number, sourceHeight: number, rows: number): number {
  // Kitty's layout uses roughly 9×18 px terminal cells. Size the inline box
  // from the formula's natural aspect ratio so it participates in the text
  // flow instead of reserving a generic image panel.
  return Math.max(1, Math.min(32, Math.ceil((sourceWidth * 2 * rows) / sourceHeight)));
}

function linkAbortSignals(
  controller: AbortController,
  signals: readonly (AbortSignal | undefined)[],
) {
  const listeners: Array<{ signal: AbortSignal; listener: () => void }> = [];
  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    const listener = () => controller.abort(signal.reason);
    signal.addEventListener("abort", listener, { once: true });
    listeners.push({ signal, listener });
  }
  return () => {
    for (const { signal, listener } of listeners) signal.removeEventListener("abort", listener);
  };
}

function permissionDomain(error: unknown): string | undefined {
  if (!(error instanceof TermLoomError) || error.code !== "HTTP_PERMISSION_REQUIRED") return;
  const { domain } = error.details as { domain?: unknown };
  return typeof domain === "string" ? domain : undefined;
}

function playbackKind(media: RichMedia): PlaybackKind | undefined {
  if (media.kind === "video") return "video";
  return media.sources.some(
    (source) =>
      source.mimeType?.toLocaleLowerCase() === "image/gif" ||
      resourceExtension(source.uri) === ".gif",
  )
    ? "gif"
    : undefined;
}

function preferredSource(media: RichMedia) {
  return (
    media.sources.find((source) => source.mimeType?.toLocaleLowerCase() === "video/mp4") ??
    media.sources.find((source) => resourceExtension(source.uri) === ".mp4") ??
    media.sources[0]
  );
}

function resourceExtension(uri: string): string {
  try {
    return extname(new URL(uri).pathname).toLocaleLowerCase();
  } catch {
    return extname(uri.split(/[?#]/u, 1)[0] ?? uri).toLocaleLowerCase();
  }
}

function localizedPlaybackStatus(i18n: I18n, state: MediaPlaybackState): string {
  if (state.status === "loading") return i18n.t("preview.playbackLoading");
  if (state.status === "paused") return i18n.t("preview.playbackPaused");
  if (state.status === "playing") return i18n.t("preview.playbackPlaying");
  if (state.status === "ended") return i18n.t("preview.playbackEnded");
  return state.error
    ? i18n.t("preview.playbackErrorMessage", { message: state.error })
    : i18n.t("preview.playbackError");
}

function formatTimestamp(seconds: number): string {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const whole = Math.floor(safe);
  const minutes = Math.floor(whole / 60);
  const remainder = whole % 60;
  return `${minutes}:${remainder.toString().padStart(2, "0")}`;
}
