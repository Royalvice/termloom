import { extname } from "node:path";
import { BoxRenderable, type RenderContext, TextAttributes, TextRenderable } from "@opentui/core";
import { errorMessage, TermLoomError } from "../core/errors.js";
import type { DocumentLocation, RichMathExpression, RichMedia } from "../document/model.js";
import type { ResourceLoader } from "../document/resource-loader.js";
import { resolveResourceLocation } from "../document/resource-location.js";
import type { I18n } from "../i18n/i18n.js";
import type { MediaDecoder } from "../media/decoder.js";
import type { FormulaRenderer } from "../media/formula-renderer.js";
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
  onPermissionRequired(domain: string, retry: () => void): void;
}

export class DocumentMediaBlockRenderable extends BoxRenderable {
  private readonly status: TextRenderable;
  private readonly surface: MediaSurfaceRenderable;
  private generation = 0;

  public constructor(
    renderer: RenderContext,
    private readonly media: RichMedia,
    private readonly document: DocumentLocation,
    private readonly dependencies: MediaBlockDependencies,
  ) {
    super(renderer, {
      id: `document-${media.id}`,
      width: "100%",
      height: 14,
      flexDirection: "column",
      border: true,
      borderStyle: "rounded",
      borderColor: theme.border,
      title: media.alt ?? media.title ?? media.kind,
      titleColor: theme.accentSecondary,
      overflow: "hidden",
      marginTop: 1,
    });
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
    void this.load();
  }

  public retry(): void {
    void this.load();
  }

  protected override destroySelf(): void {
    this.generation += 1;
    super.destroySelf();
  }

  private async load(): Promise<void> {
    const generation = ++this.generation;
    this.status.content = this.dependencies.i18n.t("preview.mediaLoading", {
      kind: this.media.kind,
    });
    this.status.fg = theme.muted;
    try {
      const reference = this.media.posterUri ?? this.media.sources[0]?.uri;
      if (!reference) throw new Error("Media has no source");
      const location = resolveResourceLocation(reference, this.document);
      const loaded = await this.dependencies.loader.load(location);
      let localPath = loaded.localPath;
      if (
        loaded.mimeType === "image/svg+xml" ||
        extname(localPath).toLocaleLowerCase() === ".svg"
      ) {
        localPath = await this.dependencies.rasterizer.rasterizeFile(localPath);
      }
      const frame = await this.dependencies.decoder.decodeFrame(localPath);
      if (generation !== this.generation || this.isDestroyed) return;
      this.surface.setFrame(frame);
      this.status.content = this.dependencies.i18n.t("preview.mediaReady", {
        kind: this.media.kind,
        width: frame.width,
        height: frame.height,
        adapter: this.dependencies.adapter,
      });
      this.status.fg = theme.success;
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
