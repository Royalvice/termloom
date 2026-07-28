import { afterEach, describe, expect, test } from "bun:test";
import type { KeyEvent, TextRenderable } from "@opentui/core";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { lookup } from "mime-types";
import { DomainPermissionGate } from "../../../src/document/domain-permission.js";
import { ResourceCache } from "../../../src/document/resource-cache.js";
import {
  ResourceLoader,
  type RemoteResourceProvider,
} from "../../../src/document/resource-loader.js";
import { I18n } from "../../../src/i18n/i18n.js";
import { MediaDecoder } from "../../../src/media/decoder.js";
import { FormulaRenderer } from "../../../src/media/formula-renderer.js";
import { SvgRasterizer } from "../../../src/media/svg-rasterizer.js";
import { runProcess } from "../../../src/process/process-runner.js";
import type { ConflictPolicy, RemoteFileEntry } from "../../../src/sftp/rclone-sftp.js";
import { TransferQueue } from "../../../src/sftp/transfer-queue.js";
import { RichDocumentRenderable } from "../../../src/ui/rich-document-renderable.js";

const temporaryDirectories: string[] = [];
let setup: TestRendererSetup | undefined;
let preview: RichDocumentRenderable | undefined;

afterEach(async () => {
  const activePreview = preview;
  activePreview?.destroyRecursively();
  await activePreview?.waitForMediaDisposal();
  setup?.renderer.destroy();
  preview = undefined;
  setup = undefined;
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("RichDocumentRenderable", () => {
  test("renders remote Markdown, PNG, SVG, GIF, a video poster, and formulas in its OpenTUI pane", async () => {
    const movie = await videoFixture();
    const markdown = [
      "# Rich remote document",
      "",
      "| Feature | Result |",
      "| --- | --- |",
      "| GFM | visible |",
      "",
      "![PNG](assets/pixel.png)",
      "",
      "![SVG](assets/vector.svg)",
      "",
      "![GIF](assets/animated.gif)",
      "",
      "Inline formula $x^2 + y^2$.",
      "",
      "$$\\int_0^1 x^2\\,dx = \\frac{1}{3}$$",
      "",
      '<video controls poster="assets/pixel.png"><source src="assets/movie.mp4" type="video/mp4"></video>',
    ].join("\n");
    const remote = new MapRemoteResourceProvider({
      "/docs/README.md": Buffer.from(markdown),
      "/docs/assets/pixel.png": ppmFixture(),
      "/docs/assets/vector.svg": Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="8"><rect width="16" height="8" fill="#89b4fa"/></svg>',
      ),
      "/docs/assets/animated.gif": Buffer.from(
        "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
        "base64",
      ),
      "/docs/assets/movie.mp4": movie,
    });
    await createPreview(remote);

    await waitUntil(
      () =>
        ["status-media-1", "status-media-2", "status-media-3", "status-media-4"]
          .map(statusText)
          .every((content) => content.includes("truecolor-cells")),
      () =>
        ["status-media-1", "status-media-2", "status-media-3", "status-media-4"]
          .map((id) => `${id}=${statusText(id)}`)
          .join("; "),
    );
    await waitUntil(
      () => statusText("status-math-1").includes("truecolor-cells"),
      () => `status-math-1=${statusText("status-math-1")}`,
    );
    await waitUntil(
      () => statusText("status-math-2").includes("truecolor-cells"),
      () => `status-math-2=${statusText("status-math-2")}`,
    );
    await setup?.renderOnce();

    const frame = setup?.captureCharFrame() ?? "";
    expect(frame).toContain("Rich remote document");
    expect(frame).toContain("GFM");
    expect(frame).toContain("▀");
    expect(remote.downloads).toContain("/docs/assets/vector.svg");
    expect(remote.downloads).toContain("/docs/assets/animated.gif");
    expect(remote.downloads).toContain("/docs/assets/movie.mp4");
  }, 30_000);

  test("controls the selected remote media and moves it into pane-native fullscreen", async () => {
    const movie = await videoFixture(6.5);
    const markdown = [
      "# Playback",
      "",
      "![GIF](assets/animated.gif)",
      "",
      '<video controls><source src="assets/movie.mp4" type="video/mp4"></video>',
    ].join("\n");
    await createPreview(
      new MapRemoteResourceProvider({
        "/docs/README.md": Buffer.from(markdown),
        "/docs/assets/animated.gif": Buffer.from(
          "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
          "base64",
        ),
        "/docs/assets/movie.mp4": movie,
      }),
    );

    await waitUntil(
      () => preview?.selectedMedia()?.inspectPlayback()?.status === "playing",
      () => JSON.stringify(preview?.selectedMedia()?.inspectPlayback()),
    );
    expect(preview?.selectedMedia()?.id).toBe("document-media-1");

    preview?.handleKeyPress(key("tab"));
    await waitUntil(
      () => preview?.selectedMedia()?.inspectPlayback()?.status === "paused",
      () => JSON.stringify(preview?.selectedMedia()?.inspectPlayback()),
    );
    const video = preview?.selectedMedia();
    if (!video) throw new Error("Expected a selected video block");
    const activePreview = preview;
    if (!activePreview) throw new Error("Expected an active preview");
    expect(video.id).toBe("document-media-2");
    expect(video.inspectPlayback()?.clock).toBe("mpv");

    preview?.handleKeyPress(key("space"));
    await waitUntil(
      () =>
        video.inspectPlayback()?.status === "playing" &&
        video.inspectProcesses().ffmpeg !== undefined &&
        video.inspectProcesses().mpv !== undefined,
      () =>
        `${JSON.stringify(video.inspectPlayback())} ${JSON.stringify(video.inspectProcesses())}`,
    );
    preview?.handleKeyPress(key("right"));
    await waitUntil(
      () => (video.inspectPlayback()?.positionSeconds ?? 0) > 4.5,
      () => JSON.stringify(video.inspectPlayback()),
    );
    preview?.handleKeyPress(key("minus"));
    preview?.handleKeyPress(key("m"));
    await waitUntil(
      () => video.inspectPlayback()?.volume === 95 && video.inspectPlayback()?.muted === true,
      () => JSON.stringify(video.inspectPlayback()),
    );

    const originalParent = video.parent;
    preview?.handleKeyPress(key("f"));
    await setup?.renderOnce();
    expect(preview?.isMediaFullscreen()).toBe(true);
    expect(video.parent).toBe(activePreview);
    expect(video.height).toBe(Math.max(4, activePreview.height - 3));
    preview?.handleKeyPress(key("tab"));
    expect(preview?.selectedMedia()).toBe(video);
    preview?.handleKeyPress(key("f"));
    await setup?.renderOnce();
    expect(preview?.isMediaFullscreen()).toBe(false);
    expect(video.parent).toBe(originalParent);
    expect(video.height).toBe(14);

    if (video.inspectPlayback()?.status === "playing") await video.togglePlayback();
    await video.seekBy(-4);
    await video.togglePlayback();
    await waitUntil(
      () => Object.values(video.inspectProcesses()).length === 2,
      () => JSON.stringify(video.inspectProcesses()),
    );
    const processIds = Object.values(video.inspectProcesses());
    expect(processIds).toHaveLength(2);
    preview?.destroyRecursively();
    await preview?.waitForMediaDisposal();
    expect(processIds.every((pid) => !processIsAlive(pid))).toBe(true);
    preview = undefined;
  }, 30_000);

  test("keeps HTTP media at zero requests until the user approves the domain in the pane", async () => {
    let requests = 0;
    const server = Bun.serve({
      port: 0,
      fetch: () => {
        requests += 1;
        return new Response(ppmFixture(), {
          headers: { "content-type": "image/png" },
        });
      },
    });
    const markdown = `# Permission\n\n![remote](http://127.0.0.1:${server.port}/pixel.png)`;
    try {
      await createPreview(
        new MapRemoteResourceProvider({ "/docs/README.md": Buffer.from(markdown) }),
      );
      await waitUntil(
        () => setup?.captureCharFrame().includes("Network blocked") ?? false,
        () => setup?.captureCharFrame() ?? "no frame",
      );
      expect(requests).toBe(0);

      preview?.handleKeyPress(key("o"));
      await waitUntil(
        () => requests === 1,
        () => `requests=${requests}`,
      );
      await waitUntil(
        () => statusText("status-media-1").includes("truecolor-cells"),
        () => `status-media-1=${statusText("status-media-1")}`,
      );
      expect(requests).toBe(1);
    } finally {
      server.stop(true);
    }
  }, 30_000);
});

async function createPreview(remote: MapRemoteResourceProvider): Promise<void> {
  const directory = await temporaryDirectory();
  const cache = new ResourceCache(join(directory, "cache"), 32 * 1024 * 1024);
  const permissions = new DomainPermissionGate();
  const rasterizer = new SvgRasterizer({ cache });
  setup = await createTestRenderer({ width: 120, height: 80 });
  preview = new RichDocumentRenderable(setup.renderer, {
    id: "preview",
    pane: {
      id: "preview-pane",
      kind: "preview",
      title: "README",
      hostId: "fixture",
      path: "/docs/README.md",
      scrollOffset: 0,
    },
    i18n: new I18n("en"),
    loader: new ResourceLoader({ remote, cache, permissions }),
    permissions,
    decoder: new MediaDecoder({ maxWidth: 160, maxHeight: 120 }),
    rasterizer,
    formula: new FormulaRenderer({ cache, rasterizer }),
    adapter: {
      name: "truecolor-cells",
      terminal: "generic",
      protocol: "truecolor-half-block",
    },
    videoFramesPerSecond: 10,
    autoplayGif: true,
    mpv: { audioOutput: "null" },
  });
  setup.renderer.root.add(preview);
  preview.focus();
}

class MapRemoteResourceProvider implements RemoteResourceProvider {
  public readonly downloads: string[] = [];
  private readonly queue = new TransferQueue(2);
  private readonly resources: ReadonlyMap<string, Uint8Array>;

  public constructor(resources: Readonly<Record<string, Uint8Array>>) {
    this.resources = new Map(Object.entries(resources));
  }

  public async stat(_hostId: string, path: string): Promise<RemoteFileEntry> {
    const content = this.resource(path);
    const mimeType = lookup(extname(path));
    return {
      name: path.split("/").at(-1) ?? path,
      path,
      size: content.byteLength,
      isDirectory: false,
      ...(mimeType ? { mimeType } : {}),
      modifiedAt: new Date("2026-07-28T00:00:00.000Z"),
      hashes: {},
    };
  }

  public download(_hostId: string, source: string, destination: string, _policy?: ConflictPolicy) {
    return this.queue.enqueue({ direction: "download", source, destination }, async () => {
      this.downloads.push(source);
      await writeFile(destination, this.resource(source), { mode: 0o600 });
      return { destination };
    });
  }

  private resource(path: string): Uint8Array {
    const content = this.resources.get(path);
    if (!content) throw new Error(`Missing remote fixture: ${path}`);
    return content;
  }
}

function statusText(id: string): string {
  const status = preview?.findDescendantById(id) as TextRenderable | undefined;
  return status?.content.chunks.map((chunk) => chunk.text).join("") ?? "";
}

function ppmFixture(): Uint8Array {
  return Buffer.concat([
    Buffer.from("P6\n2 2\n255\n", "ascii"),
    Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]),
  ]);
}

function key(name: string): KeyEvent {
  return {
    name,
    sequence: name,
    raw: name,
    eventType: "press",
    ctrl: false,
    shift: false,
    meta: false,
    option: false,
    super: false,
    hyper: false,
    number: false,
  } as unknown as KeyEvent;
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "termloom-rich-document-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function waitUntil(predicate: () => boolean, diagnostic: () => string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    await setup?.renderOnce();
    if (predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out: ${diagnostic()}`);
}

async function videoFixture(durationSeconds = 1.5): Promise<Uint8Array> {
  const directory = await temporaryDirectory();
  const path = join(directory, "movie.mp4");
  const ffmpeg = Bun.which("ffmpeg");
  if (!ffmpeg) throw new Error("ffmpeg is required for the rich document fixture");
  await runProcess(
    ffmpeg,
    [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=64x48:rate=12",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=48000",
      "-t",
      String(durationSeconds),
      "-c:v",
      "mpeg4",
      "-q:v",
      "4",
      "-c:a",
      "aac",
      "-shortest",
      "-y",
      path,
    ],
    { timeoutMs: 20_000 },
  );
  return new Uint8Array(await readFile(path));
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
