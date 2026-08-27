import { liteAdaptor } from "@mathjax/src/js/adaptors/liteAdaptor.js";
import { RegisterHTMLHandler } from "@mathjax/src/js/handlers/html.js";
import { TeX } from "@mathjax/src/js/input/tex.js";
import "@mathjax/src/js/input/tex/ams/AmsConfiguration.js";
import "@mathjax/src/js/input/tex/newcommand/NewcommandConfiguration.js";
import "@mathjax/src/js/input/tex/textmacros/TextMacrosConfiguration.js";
import { mathjax } from "@mathjax/src/js/mathjax.js";
import { SVG } from "@mathjax/src/js/output/svg.js";
import "@mathjax/src/js/util/asyncLoad/esm.js";
import type { ResourceCache } from "../document/resource-cache.js";
import { SvgRasterizer } from "./svg-rasterizer.js";

interface FormulaEngine {
  render(source: string, display: boolean): Promise<string>;
}

let formulaEngine: FormulaEngine | undefined;

export interface FormulaRendererOptions {
  cache: ResourceCache;
  rasterizer?: SvgRasterizer;
}

export class FormulaRenderer {
  private readonly rasterizer: SvgRasterizer;

  public constructor(options: FormulaRendererOptions) {
    this.rasterizer = options.rasterizer ?? new SvgRasterizer({ cache: options.cache });
  }

  public async render(source: string, display: boolean, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    const svg = await getFormulaEngine().render(source, display);
    signal?.throwIfAborted();
    return this.rasterizer.rasterizeSource(`mathjax\0${display}\0${source}`, svg, {
      signal,
      // MathJax's SVG uses `ex` units. At resvg's default density a short
      // inline expression is only ~14 px wide, which becomes visibly blurry
      // when Kitty or truecolor-cells scales it to the pane. Keep more source
      // pixels so the terminal can downsample instead of upscaling.
      zoom: 3,
    });
  }
}

function getFormulaEngine(): FormulaEngine {
  formulaEngine ??= createFormulaEngine();
  return formulaEngine;
}

function createFormulaEngine(): FormulaEngine {
  const adaptor = liteAdaptor();
  RegisterHTMLHandler(adaptor);
  const input = new TeX({ packages: ["base", "ams", "newcommand", "textmacros"] });
  const output = new SVG({
    fontCache: "none",
    // MathJax 4 may split inline equations into multiple SVG fragments when
    // browser-style line breaking is enabled. A terminal media surface is a
    // single inline object, so keep the complete expression contiguous.
    linebreaks: { inline: false, width: "100%" },
  });
  const document = mathjax.document("", { InputJax: input, OutputJax: output });
  let queue = Promise.resolve();

  return {
    render(source, display) {
      const result = queue.then(async () => {
        const node = await document.convertPromise(source, { display });
        const svg = adaptor.getElement("svg", node);
        if (!svg) throw new Error("MathJax did not produce an SVG element");
        return adaptor.serializeXML(svg).replace("<svg", '<svg color="#cdd6f4"');
      });
      queue = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
}
