import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResourceCache } from "../../../src/document/resource-cache.js";
import { MediaDecoder } from "../../../src/media/decoder.js";
import { FormulaRenderer } from "../../../src/media/formula-renderer.js";
import { SvgRasterizer } from "../../../src/media/svg-rasterizer.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

test("probes and decodes a real image through ffprobe and FFmpeg", async () => {
  const directory = await temporaryDirectory();
  const path = join(directory, "fixture.ppm");
  const header = Buffer.from("P6\n2 2\n255\n", "ascii");
  const pixels = Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]);
  await writeFile(path, Buffer.concat([header, pixels]));
  const decoder = new MediaDecoder({ maxWidth: 100, maxHeight: 100 });

  await expect(decoder.probe(path)).resolves.toMatchObject({
    width: 2,
    height: 2,
    codec: "ppm",
  });
  const frame = await decoder.decodeFrame(path);
  expect(frame.width).toBe(2);
  expect(frame.height).toBe(2);
  expect([...frame.rgb]).toEqual([...pixels]);
});

test("rasterizes SVG and MathJax TeX through the system resvg binary", async () => {
  const directory = await temporaryDirectory();
  const cache = new ResourceCache(join(directory, "cache"), 16 * 1024 * 1024);
  const rasterizer = new SvgRasterizer({ cache });
  const svgPath = join(directory, "source.svg");
  await writeFile(
    svgPath,
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="8"><rect width="16" height="8" fill="#ff0000"/></svg>',
  );

  const rasterized = await rasterizer.rasterizeFile(svgPath);
  expect((await readFile(rasterized)).subarray(1, 4).toString()).toBe("PNG");
  await expect(new MediaDecoder().probe(rasterized)).resolves.toMatchObject({
    width: 16,
    height: 8,
    codec: "png",
  });

  const formula = await new FormulaRenderer({ cache, rasterizer }).render(
    String.raw`\int_0^1 x^2\,dx = \frac{1}{3}`,
    true,
  );
  const formulaProbe = await new MediaDecoder().probe(formula);
  expect(formulaProbe.width).toBeGreaterThan(10);
  expect(formulaProbe.height).toBeGreaterThan(5);
}, 30_000);

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "termloom-media-"));
  temporaryDirectories.push(directory);
  return directory;
}
