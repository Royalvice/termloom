import { extname } from "node:path";
import { BoxRenderable, type RenderContext, TextAttributes, TextRenderable } from "@opentui/core";
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
import type { MediaAdapterName, MediaOutput } from "../media/types.js";
import { theme } from "./theme.js";

export interface MediaBlockDependencies {
  loader: ResourceLoader;
  decoder: MediaDecoder;
  rasterizer: SvgRasterizer;
  formula: FormulaRenderer;
  adapter: MediaAdapterName;
  output?: MediaOutput;
  i18n: I18n;
  videoFramesPerSecond?: number;
  autoplayGif?: boolean;
  mpv?: MpvControllerOptions;
  onPermissionRequired(domain: string, retry: () => void): void;
}

export class DocumentMediaBlockRenderable extends BoxRenderable {
  private readonly status: TextRenderable;
  private readonly surface: MediaSurfaceRenderable;
  private readonly baseTitle: string;
  private playback: MediaPlaybackController | undefined;
  private playbackState: MediaPlaybackState | undefined;
  private loadPromise: Promise<void>;
  private disposalPromise: Promise<void> = Promise.resolve();
  private selected = false;
  private fullscreen = false;
  private generation = 0;

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
      output: dependencies.output,
      width: "100%",
      flexGrow: 1,
      minHeight: 4,
    });
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
    this.loadPromise = this.load();
  }

  public retry(): void {
    this.loadPromise = this.load();
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

  public async togglePlayback(): Promise<void> {
    await (await this.requirePlayback()).toggle();
  }

  public async seekBy(seconds: number): Promise<void> {
    await (await this.requirePlayback()).seekBy(seconds);
  }

  public async adjustVolume(delta: number): Promise<void> {
    await (await this.requirePlayback()).adjustVolume(delta);
  }

  public async toggleMuted(): Promise<void> {
    await (await this.requirePlayback()).toggleMuted();
  }

  public waitForDisposal(): Promise<void> {
    return this.disposalPromise;
  }

  protected override destroySelf(): void {
    this.generation += 1;
    const playback = this.playback;
    this.playback = undefined;
    this.disposalPromise = playback?.dispose() ?? Promise.resolve();
    super.destroySelf();
  }

  private async load(): Promise<void> {
    const generation = ++this.generation;
    const previous = this.playback;
    this.playback = undefined;
    this.playbackState = undefined;
    await previous?.dispose();
    if (generation !== this.generation || this.isDestroyed) return;
    this.status.content = this.dependencies.i18n.t("preview.mediaLoading", {
      kind: this.media.kind,
    });
    this.status.fg = theme.muted;
    try {
      const kind = playbackKind(this.media);
      if (this.media.posterUri) await this.loadStill(this.media.posterUri, generation);
      const source = preferredSource(this.media);
      if (!source) throw new Error("Media has no source");
      if (!kind) {
        if (!this.media.posterUri) await this.loadStill(source.uri, generation);
        return this.showStaticReady(generation);
      }

      const location = resolveResourceLocation(source.uri, this.document);
      const loaded = await this.dependencies.loader.load(location);
      if (generation !== this.generation || this.isDestroyed) return;
      const controller = new MediaPlaybackController(loaded.localPath, this.dependencies.decoder, {
        kind,
        framesPerSecond: this.dependencies.videoFramesPerSecond ?? 24,
        loop: kind === "gif" || this.media.loop,
        autoplay: kind === "gif" ? (this.dependencies.autoplayGif ?? true) : this.media.autoplay,
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
      if (generation !== this.generation || this.isDestroyed) await controller.dispose();
    } catch (error) {
      if (generation !== this.generation || this.isDestroyed) return;
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

  private async loadStill(reference: string, generation: number): Promise<void> {
    const location = resolveResourceLocation(reference, this.document);
    const loaded = await this.dependencies.loader.load(location);
    let localPath = loaded.localPath;
    if (loaded.mimeType === "image/svg+xml" || extname(localPath).toLocaleLowerCase() === ".svg") {
      localPath = await this.dependencies.rasterizer.rasterizeFile(localPath);
    }
    const frame = await this.dependencies.decoder.decodeFrame(localPath);
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
    this.requestRender();
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
}

export class FormulaMediaBlockRenderable extends BoxRenderable {
  private readonly status: TextRenderable;
  private readonly surface: MediaSurfaceRenderable;
  private generation = 0;

  public constructor(
    renderer: RenderContext,
    private readonly expression: RichMathExpression,
    private readonly dependencies: MediaBlockDependencies,
  ) {
    super(renderer, {
      id: `document-${expression.id}`,
      width: "100%",
      height: expression.display ? 11 : 8,
      flexDirection: "column",
      border: true,
      borderStyle: "rounded",
      borderColor: theme.border,
      title: expression.display ? "Formula" : "Inline formula",
      titleColor: theme.accentSecondary,
      overflow: "hidden",
      marginTop: 1,
    });
    this.surface = new MediaSurfaceRenderable(renderer, {
      id: `surface-${expression.id}`,
      adapter: dependencies.adapter,
      output: dependencies.output,
      width: "100%",
      flexGrow: 1,
      minHeight: 3,
    });
    this.status = new TextRenderable(renderer, {
      id: `status-${expression.id}`,
      height: 1,
      width: "100%",
      content: dependencies.i18n.t("preview.mediaLoading", { kind: "formula" }),
      fg: theme.muted,
    });
    this.add(this.surface);
    this.add(this.status);
    void this.load();
  }

  protected override destroySelf(): void {
    this.generation += 1;
    super.destroySelf();
  }

  private async load(): Promise<void> {
    const generation = ++this.generation;
    try {
      const path = await this.dependencies.formula.render(
        this.expression.source,
        this.expression.display,
      );
      const frame = await this.dependencies.decoder.decodeFrame(path);
      if (generation !== this.generation || this.isDestroyed) return;
      this.surface.setFrame(frame);
      this.status.content = this.dependencies.i18n.t("preview.mediaReady", {
        kind: "formula",
        width: frame.width,
        height: frame.height,
        adapter: this.dependencies.adapter,
      });
      this.status.fg = theme.success;
    } catch (error) {
      if (generation !== this.generation || this.isDestroyed) return;
      this.status.content = this.dependencies.i18n.t("preview.error", {
        message: errorMessage(error),
      });
      this.status.fg = theme.error;
      this.requestRender();
    }
  }
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
