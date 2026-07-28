import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import {
  BoxRenderable,
  type CliRenderer,
  type KeyEvent,
  MarkdownRenderable,
  type Renderable,
  ScrollBoxRenderable,
  SyntaxStyle,
  TextAttributes,
  TextRenderable,
} from "@opentui/core";
import { errorMessage } from "../core/errors.js";
import type { DomainPermissionGate, DomainPermissionScope } from "../document/domain-permission.js";
import type { RichDocument, RichMathExpression, RichMedia } from "../document/model.js";
import { parseRichDocument } from "../document/parser.js";
import type { ResourceLoader } from "../document/resource-loader.js";
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

export interface RichDocumentOptions {
  id: string;
  pane: PreviewPaneState;
  i18n: I18n;
  onPaneUpdate?: (pane: PreviewPaneState) => void;
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
  private readonly pendingPermissions = new Map<string, Set<() => void>>();
  private readonly mediaBlocks: DocumentMediaBlockRenderable[] = [];
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
    this.add(
      new TextRenderable(renderer, {
        id: `${options.id}-header`,
        height: 1,
        width: "100%",
        content: `${options.pane.hostId}:${options.pane.path}`,
        fg: theme.accent,
        attributes: TextAttributes.BOLD,
      }),
    );
    this.scroll = new ScrollBoxRenderable(renderer, {
      id: `${options.id}-scroll`,
      width: "100%",
      flexGrow: 1,
      scrollY: true,
      scrollX: false,
      viewportCulling: true,
      rootOptions: { backgroundColor: theme.background },
      contentOptions: { flexDirection: "column", width: "100%" },
    });
    this.add(this.scroll);
    this.status = new TextRenderable(renderer, {
      id: `${options.id}-status`,
      height: 2,
      width: "100%",
      content: options.i18n.t("preview.loading"),
      fg: theme.muted,
      attributes: TextAttributes.DIM,
    });
    this.add(this.status);
    void this.load();
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
    this.persistScroll();
    return true;
  }

  protected override destroySelf(): void {
    this.generation += 1;
    this.pendingPermissions.clear();
    this.fullscreenOrigin = undefined;
    super.destroySelf();
  }

  protected override onResize(width: number, height: number): void {
    super.onResize(width, height);
    if (this.fullscreenOrigin) {
      this.fullscreenOrigin.block.height = Math.max(4, height - 3);
    }
  }

  public waitForMediaDisposal(): Promise<void> {
    return Promise.all(this.mediaBlocks.map((block) => block.waitForDisposal())).then(
      () => undefined,
    );
  }

  public selectedMedia(): DocumentMediaBlockRenderable | undefined {
    return this.mediaBlocks[this.selectedMediaIndex];
  }

  public isMediaFullscreen(): boolean {
    return this.fullscreenOrigin !== undefined;
  }

  private async load(): Promise<void> {
    const generation = ++this.generation;
    try {
      const resource = await this.options.loader.load({
        scheme: "sftp",
        hostId: this.pane.hostId,
        path: this.pane.path,
      });
      if (generation !== this.generation || this.isDestroyed) return;
      const extension = extname(this.pane.path).toLocaleLowerCase();
      if (
        extension === ".md" ||
        extension === ".markdown" ||
        resource.mimeType === "text/markdown"
      ) {
        const source = await readFile(resource.localPath, "utf8");
        const document = await parseRichDocument(source);
        if (generation !== this.generation || this.isDestroyed) return;
        this.renderMarkdown(document);
      } else if (isMediaExtension(extension)) {
        this.renderDirectMedia(resource.localPath, extension);
      } else {
        const source = await readFile(resource.localPath, "utf8");
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
      this.scroll.scrollTop = this.pane.scrollOffset;
      this.status.content = `${this.options.i18n.t("preview.adapter", {
        adapter: `${this.options.adapter.protocol} (${this.options.adapter.terminal})`,
      })}  ·  ${this.options.i18n.t("preview.shortcuts")}`;
      this.status.fg = theme.muted;
      this.requestRender();
    } catch (error) {
      if (generation !== this.generation || this.isDestroyed) return;
      this.status.content = this.options.i18n.t("preview.error", {
        message: errorMessage(error),
      });
      this.status.fg = theme.error;
      this.requestRender();
    }
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
  }

  private renderDirectMedia(_localPath: string, extension: string): void {
    const item: RichMedia = {
      id: `direct-${crypto.randomUUID()}`,
      kind: extension === ".mp4" ? "video" : "image",
      sources: [{ uri: this.pane.path }],
      alt: this.pane.title,
      controls: extension === ".mp4",
      autoplay: false,
      loop: extension === ".gif",
      muted: false,
    };
    this.scroll.add(this.mediaBlock(item));
  }

  private mediaBlock(media: RichMedia): DocumentMediaBlockRenderable {
    const block = new DocumentMediaBlockRenderable(
      this.ctx,
      media,
      { hostId: this.pane.hostId, path: this.pane.path },
      this.mediaDependencies(),
    );
    this.mediaBlocks.push(block);
    if (block.isPlayable() && this.selectedMediaIndex < 0) {
      this.selectedMediaIndex = this.mediaBlocks.length - 1;
      block.setSelected(true);
    }
    return block;
  }

  private formulaBlock(expression: RichMathExpression): FormulaMediaBlockRenderable {
    return new FormulaMediaBlockRenderable(this.ctx, expression, this.mediaDependencies());
  }

  private mediaDependencies(): MediaBlockDependencies {
    return {
      loader: this.options.loader,
      decoder: this.options.decoder,
      rasterizer: this.options.rasterizer,
      formula: this.options.formula,
      adapter: this.options.adapter.name,
      output: this.options.output,
      i18n: this.options.i18n,
      videoFramesPerSecond: this.options.videoFramesPerSecond,
      autoplayGif: this.options.autoplayGif,
      mpv: this.options.mpv,
      onPermissionRequired: (domain, retry) => this.notePermission(domain, retry),
    };
  }

  private notePermission(domain: string, retry: () => void): void {
    const retries = this.pendingPermissions.get(domain) ?? new Set();
    retries.add(retry);
    this.pendingPermissions.set(domain, retries);
    this.status.content = this.options.i18n.t("preview.permission", { domain });
    this.status.fg = theme.warning;
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
    this.requestRender();
  }

  private persistScroll(): void {
    this.pane = { ...this.pane, scrollOffset: Math.max(0, Math.floor(this.scroll.scrollTop)) };
    this.options.onPaneUpdate?.(this.pane);
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
    this.scroll.scrollChildIntoView(origin.block.id);
    this.requestRender();
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

function isMediaExtension(extension: string): boolean {
  return [".png", ".jpg", ".jpeg", ".webp", ".svg", ".gif", ".mp4"].includes(extension);
}

function isSpace(key: KeyEvent): boolean {
  return key.name === "space" || key.name === " " || key.sequence === " ";
}

function isVolumeUp(key: KeyEvent): boolean {
  return key.name === "plus" || key.name === "+" || key.name === "equal" || key.name === "=";
}
