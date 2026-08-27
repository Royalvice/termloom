import { stat } from "node:fs/promises";
import { TermLoomError } from "../core/errors.js";
import type { ResourceCache } from "../document/resource-cache.js";
import { runProcess } from "../process/process-runner.js";

export interface SvgRasterizerOptions {
  cache: ResourceCache;
  binary?: string;
  background?: string;
}

export interface RasterizeOptions {
  signal?: AbortSignal;
  /** Render the SVG at a higher pixel density before it is placed in a terminal pane. */
  zoom?: number;
  /** Override the output background; use `transparent` for inline math surfaces. */
  background?: string;
}

export class SvgRasterizer {
  private readonly cache: ResourceCache;
  private readonly binary: string;
  private readonly background: string;

  public constructor(options: SvgRasterizerOptions) {
    this.cache = options.cache;
    const binary = options.binary ?? Bun.which("resvg");
    if (!binary) {
      throw new TermLoomError({
        code: "DEPENDENCY_MISSING",
        message: "resvg was not found",
        hint: "Install resvg and run termloom doctor again.",
        details: { dependency: "resvg" },
      });
    }
    this.binary = binary;
    this.background = options.background ?? "#11111b";
  }

  public async rasterizeFile(path: string, options: RasterizeOptions = {}): Promise<string> {
    const metadata = await stat(path);
    const background = options.background ?? this.background;
    const cached = await this.cache.materialize(
      `svg\0${path}\0${metadata.size}\0${metadata.mtimeMs}\0${background}`,
      ".png",
      async (destination, producerSignal) => {
        await runProcess(this.binary, ["--quiet", "--background", background, path, destination], {
          timeoutMs: 30_000,
          signal: producerSignal,
        });
      },
      { signal: options.signal },
    );
    return cached.path;
  }

  public async rasterizeSource(
    identity: string,
    svg: string,
    options: RasterizeOptions = {},
  ): Promise<string> {
    const zoom = normalizeZoom(options.zoom);
    const background = options.background ?? this.background;
    const cached = await this.cache.materialize(
      `svg-source\0${identity}\0${background}\0${zoom}`,
      ".png",
      async (destination, producerSignal) => {
        const args = ["--quiet", "--background", background];
        if (zoom !== 1) args.push("--zoom", String(zoom));
        args.push("-", destination);
        await runProcess(this.binary, args, {
          stdin: svg,
          timeoutMs: 30_000,
          signal: producerSignal,
        });
      },
      { signal: options.signal },
    );
    return cached.path;
  }
}

function normalizeZoom(value: number | undefined): number {
  if (value === undefined) return 1;
  if (!Number.isFinite(value) || value <= 0 || value > 16) {
    throw new Error("SVG zoom must be a finite number between 0 and 16");
  }
  return value;
}
