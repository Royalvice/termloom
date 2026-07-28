import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResourceCache } from "../../../src/document/resource-cache.js";
import { MediaDecoder } from "../../../src/media/decoder.js";
import { FormulaRenderer } from "../../../src/media/formula-renderer.js";
import { SvgRasterizer } from "../../../src/media/svg-rasterizer.js";
import { runProcess } from "../../../src/process/process-runner.js";

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

test("streams complete timestamped RGB frames from a real FFmpeg process", async () => {
  const directory = await temporaryDirectory();
  const path = join(directory, "stream.mp4");
  await createVideoFixture(path, false);
  const decoder = new MediaDecoder({ maxWidth: 32, maxHeight: 24 });

  await expect(decoder.probe(path)).resolves.toMatchObject({
    width: 32,
    height: 24,
    hasAudio: false,
  });
  const stream = await decoder.openFrameStream(path, {
    framesPerSecond: 4,
    realtime: false,
  });
  const iterator = stream[Symbol.asyncIterator]();
  const frames = [];
  for (let index = 0; index < 3; index += 1) {
    const result = await iterator.next();
    expect(result.done).toBe(false);
    if (result.value) frames.push(result.value);
  }

  expect(frames).toHaveLength(3);
  expect(frames.map((frame) => frame.rgb.byteLength)).toEqual([
    32 * 24 * 3,
    32 * 24 * 3,
    32 * 24 * 3,
  ]);
  expect(frames.map((frame) => frame.timestampSeconds)).toEqual([0, 0.25, 0.5]);
  await stream.close();
  await expect(iterator.next()).resolves.toMatchObject({ done: true });
}, 30_000);

test("cancels an active realtime FFmpeg frame read without hanging or leaking a partial frame", async () => {
  const directory = await temporaryDirectory();
  const path = join(directory, "cancel.mp4");
  await createVideoFixture(path, false, 4);
  const decoder = new MediaDecoder({ maxWidth: 32, maxHeight: 24 });
  const abort = new AbortController();
  const stream = await decoder.openFrameStream(path, {
    framesPerSecond: 12,
    realtime: true,
    signal: abort.signal,
  });
  const iterator = stream[Symbol.asyncIterator]();
  const pending = iterator.next();
  abort.abort();

  await expect(pending).resolves.toMatchObject({ done: true });
  await stream.close();
}, 30_000);

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "termloom-media-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function createVideoFixture(
  path: string,
  audio: boolean,
  durationSeconds = 1,
): Promise<void> {
  const ffmpeg = Bun.which("ffmpeg");
  if (!ffmpeg) throw new Error("ffmpeg is required for the media fixture");
  const args = ["-v", "error", "-f", "lavfi", "-i", "testsrc=size=32x24:rate=12"];
  if (audio) args.push("-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000");
  args.push(
    "-t",
    String(durationSeconds),
    "-c:v",
    "mpeg4",
    "-q:v",
    "4",
    ...(audio ? ["-c:a", "aac", "-shortest"] : []),
    "-y",
    path,
  );
  await runProcess(ffmpeg, args, { timeoutMs: 20_000 });
}
