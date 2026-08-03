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
    const cached = await this.cache.materialize(
      `svg\0${path}\0${metadata.size}\0${metadata.mtimeMs}\0${this.background}`,
      ".png",
      async (destination, producerSignal) => {
        await runProcess(
          this.binary,
          ["--quiet", "--background", this.background, path, destination],
          { timeoutMs: 30_000, signal: producerSignal },
        );
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
    const cached = await this.cache.materialize(
      `svg-source\0${identity}\0${this.background}`,
      ".png",
      async (destination, producerSignal) => {
        await runProcess(
          this.binary,
          ["--quiet", "--background", this.background, "-", destination],
          { stdin: svg, timeoutMs: 30_000, signal: producerSignal },
        );
      },
      { signal: options.signal },
    );
    return cached.path;
  }
}
