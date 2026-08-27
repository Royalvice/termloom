import { afterEach, describe, expect, test } from "bun:test";
import type { KeyEvent, ScrollBoxRenderable, TextRenderable } from "@opentui/core";
import { createMockMouse, createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { lookup } from "mime-types";
import { DomainPermissionGate } from "../../../src/document/domain-permission.js";
import type { MathLayout, MathRenderer } from "../../../src/document/math-layout.js";
import { KittyFrameEncoder } from "kitty-motion";
import { ResourceCache } from "../../../src/document/resource-cache.js";
import { ResourceLoader } from "../../../src/document/resource-loader.js";
import { I18n } from "../../../src/i18n/i18n.js";
import { MediaDecoder } from "../../../src/media/decoder.js";
import { FormulaRenderer } from "../../../src/media/formula-renderer.js";
import { SvgRasterizer } from "../../../src/media/svg-rasterizer.js";
import { runProcess } from "../../../src/process/process-runner.js";
import { CharacterMathRenderable } from "../../../src/ui/character-math-renderable.js";
import type { FileEntry } from "../../../src/files/file-provider.js";
import type { RemoteResourceReader } from "../../../src/sftp/remote-resource-reader.js";
import {
  RichDocumentRenderable,
  type RichDocumentServices,
} from "../../../src/ui/rich-document-renderable.js";

const temporaryDirectories: string[] = [];
let setup: TestRendererSetup | undefined;
let preview: RichDocumentRenderable | undefined;
let previewServices: RichDocumentServices | undefined;

afterEach(async () => {
  const activePreview = preview;
  await setup?.waitForVisualIdle();
  activePreview?.destroyRecursively();
  await activePreview?.waitForMediaDisposal();
  await setup?.waitForVisualIdle();
  setup?.renderer.destroy();
  preview = undefined;
  previewServices = undefined;
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
      "More inline: $a^2+b^2=c^2$ and $\\sqrt{x}$.",
      "",
      "$$\\sum_{n=1}^{\\infty} \\frac{1}{n^2} = \\frac{\\pi^2}{6}$$",
      "",
      "Before $\\alpha + \\beta$ and after.",
      "",
      '<video controls poster="assets/pixel.png"><source src="assets/movie.mp4" type="video/mp4"></video>',
    ].join("\n");
    const remote = new MapRemoteResourceProvider({
      "/docs/README.md": Buffer.from(markdown),
      "/docs/assets/pixel.png": pngFixture(),
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
      () => preview?.findDescendantById("document-math-1") !== undefined,
      () => "character-level math block was not created",
    );
    await setup?.renderOnce();

    const frame = setup?.captureCharFrame() ?? "";
    expect(frame).toContain("Rich remote document");
    expect(frame).toContain("GFM");
    expect(frame).not.toContain("$x^2 + y^2$");
    expect(frame).not.toContain("$$\\int_0^1 x^2\\,dx = \\frac{1}{3}$$");
    expect(frame).not.toContain("╭─Formula");
    expect(frame).toContain("x²");
    preview?.handleKeyPress(key("pagedown"));
    await setup?.renderOnce();
    const formulaFrame = setup?.captureCharFrame() ?? "";
    expect(formulaFrame).not.toContain("$a^2+b^2=c^2$");
    expect(formulaFrame).not.toContain("$\\sqrt{x}$");
    expect(formulaFrame).not.toContain("$$\\sum_{n=1}^{\\infty}");
    expect(formulaFrame).not.toContain("$\\alpha + \\beta$");
    const inlineBlock = preview?.findDescendantById("document-math-1") as
      | { width: number; height: number }
      | undefined;
    const displayBlock = preview?.findDescendantById("document-math-2") as
      | { width: number; height: number }
      | undefined;
    const secondInline = preview?.findDescendantById("document-math-3") as
      | { x: number; y: number; width: number; height: number }
      | undefined;
    const thirdInline = preview?.findDescendantById("document-math-4") as
      | { x: number; y: number; width: number; height: number }
      | undefined;
    expect(inlineBlock).toBeInstanceOf(CharacterMathRenderable);
    expect(inlineBlock?.height).toBe(1);
    expect(inlineBlock?.width).toBeGreaterThanOrEqual(1);
    expect(inlineBlock?.width).toBeLessThanOrEqual(16);
    expect((inlineBlock as CharacterMathRenderable | undefined)?.parent?.height).toBe(1);
    expect(displayBlock).toBeInstanceOf(CharacterMathRenderable);
    expect(displayBlock).toMatchObject({ height: 1 });
    expect((displayBlock as CharacterMathRenderable | undefined)?.layout?.lines[0]).toContain("∫");
    expect(secondInline?.y).toBe(thirdInline?.y);
    expect(secondInline?.x).toBeLessThan(thirdInline?.x ?? 0);
    expect(remote.downloads).toContain("/docs/assets/vector.svg");
    expect(remote.downloads).toContain("/docs/assets/animated.gif");
    expect(remote.downloads).toContain("/docs/assets/movie.mp4");
  }, 30_000);

  test("renders local Markdown relative images, GIF, video, and formulas without an SFTP provider", async () => {
    const directory = await temporaryDirectory();
    const assets = join(directory, "assets");
    await mkdir(assets);
    await writeFile(
      join(directory, "README.md"),
      [
        "# Rich local document",
        "",
        "![PNG](assets/pixel.png)",
        "",
        "![GIF](assets/animated.gif)",
        "",
        "Formula: $E = mc^2$",
        "",
        '<video controls><source src="assets/movie.mp4" type="video/mp4"></video>',
      ].join("\n"),
    );
    await writeFile(join(assets, "pixel.png"), pngFixture());
    await writeFile(
      join(assets, "animated.gif"),
      Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64"),
    );
    await writeFile(join(assets, "movie.mp4"), await videoFixture());
    await createLocalPreview(join(directory, "README.md"));

    await waitUntil(
      () =>
        ["status-media-1", "status-media-2", "status-media-3"]
          .map(statusText)
          .every((content) => content.includes("truecolor-cells")),
      () =>
        ["status-media-1", "status-media-2", "status-media-3"]
          .map((id) => `${id}=${statusText(id)}`)
          .join("; "),
    );
    await waitUntil(
      () => preview?.findDescendantById("document-math-1") !== undefined,
      () => "character-level local math block was not created",
    );
    const frame = setup?.captureCharFrame() ?? "";
    expect(frame).toContain("Rich local document");
    expect(frame).toContain("Formula:");
    expect(frame).toContain("E = mc²");
    expect(frame).not.toContain("$E = mc^2$");
    expect(preview?.selectedMedia()).toBeDefined();
  }, 30_000);

  test("keeps the character renderer on Kitty-capable local panes", async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, "README.md"), "# Native cells\n\n$\\frac{a}{b}$\n");
    await createLocalPreview(join(directory, "README.md"), {
      name: "kitty",
      terminal: "ghostty",
      protocol: "kitty-unicode",
    });
    await waitUntil(
      () => preview?.findDescendantById("document-math-1") !== undefined,
      () => "Kitty character math was not created",
    );
    expect(preview?.findDescendantById("preview-native-markdown-1")).toBeUndefined();
    expect(preview?.findDescendantById("surface-math-1")).toBeUndefined();
    const frame = setup?.captureCharFrame() ?? "";
    expect(frame).toContain("───");
  });

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
      { width: 48, height: 25 },
    );

    await waitUntil(
      () =>
        preview?.selectedMedia()?.inspectPlayback()?.status === "playing" &&
        Object.values(preview?.selectedMedia()?.inspectProcesses() ?? {}).length > 0,
      () =>
        `${JSON.stringify(preview?.selectedMedia()?.inspectPlayback())} ${JSON.stringify(
          preview?.selectedMedia()?.inspectProcesses(),
        )}`,
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

    await setup?.renderOnce();
    const mouse = setup ? createMockMouse(setup.renderer) : undefined;
    const play = preview?.findDescendantById("play-media-2");
    if (!mouse || !play) throw new Error("Expected mouse playback controls");
    expect(play.screenY).toBeGreaterThan(0);
    expect(play.screenY).toBeLessThan(80);
    expect(play.screenX).toBeGreaterThanOrEqual(0);
    expect(play.screenX).toBeLessThan(120);
    expect(setup?.renderer.hitTest(play.screenX + 1, play.screenY)).toBe(video.num);
    expect(setup?.captureCharFrame()).toContain("Play");
    await mouse.click(play.screenX + 1, play.screenY);
    await waitUntil(
      () =>
        video.inspectPlayback()?.status === "playing" &&
        video.inspectProcesses().ffmpeg !== undefined &&
        video.inspectProcesses().mpv !== undefined,
      () =>
        `${JSON.stringify(video.inspectPlayback())} ${JSON.stringify(video.inspectProcesses())}`,
    );
    const seek = preview?.findDescendantById("seek-media-2");
    if (!seek) throw new Error("Expected seek slider");
    await mouse.click(seek.screenX + Math.max(1, Math.floor(seek.width * 0.8)), seek.screenY);
    await waitUntil(
      () => (video.inspectPlayback()?.positionSeconds ?? 0) > 4,
      () => JSON.stringify(video.inspectPlayback()),
    );
    const volume = preview?.findDescendantById("volume-media-2");
    const mute = preview?.findDescendantById("mute-media-2");
    const controls = preview?.findDescendantById("controls-media-2") as
      | ScrollBoxRenderable
      | undefined;
    if (!volume || !mute || !controls || !setup) {
      throw new Error("Expected scrollable volume and mute controls");
    }
    expect(controls.scrollWidth).toBeGreaterThan(controls.width);
    for (let index = 0; index < 8; index += 1) {
      await mouse.scroll(controls.screenX + 1, controls.screenY, "right");
    }
    await setup.renderOnce();
    expect(controls.scrollLeft).toBeGreaterThan(0);
    await mouse.click(volume.screenX + Math.floor(volume.width / 2), volume.screenY);
    await mouse.click(mute.screenX + 1, mute.screenY);
    await waitUntil(
      () => {
        const state = video.inspectPlayback();
        return Boolean(state && state.volume > 35 && state.volume < 65 && state.muted);
      },
      () => JSON.stringify(video.inspectPlayback()),
    );

    const originalParent = video.parent;
    const fullscreen = preview?.findDescendantById("fullscreen-media-2");
    if (!fullscreen) throw new Error("Expected fullscreen control");
    await mouse.click(fullscreen.screenX + 1, fullscreen.screenY);
    await setup?.renderOnce();
    expect(preview?.isMediaFullscreen()).toBe(true);
    expect(video.parent).toBe(activePreview);
    expect(video.height).toBe(Math.max(4, activePreview.height - 3));
    expect(setup?.captureCharFrame()).toContain("fullscreen");
    expect(setup?.captureCharFrame()).toContain("video");
    preview?.handleKeyPress(key("tab"));
    expect(preview?.selectedMedia()).toBe(video);
    preview?.handleKeyPress(key("f"));
    await setup?.renderOnce();
    expect(preview?.isMediaFullscreen()).toBe(false);
    expect(video.parent).toBe(originalParent);
    expect(video.height).toBe(14);

    preview?.handleKeyPress(key("f"));
    await setup?.renderOnce();
    expect(preview?.isMediaFullscreen()).toBe(true);
    expect(fullscreen.screenX).toBeGreaterThanOrEqual(controls.screenX);
    expect(fullscreen.screenX + fullscreen.width).toBeLessThanOrEqual(
      controls.screenX + controls.width,
    );
    await mouse.click(fullscreen.screenX + 1, fullscreen.screenY);
    await setup?.renderOnce();
    expect(preview?.isMediaFullscreen()).toBe(false);

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
        return new Response(pngFixture(), {
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

      await setup?.renderOnce();
      const allowOnce = preview?.findDescendantById("preview-allow-once");
      if (!allowOnce || !setup) throw new Error("Expected allow-once button");
      await createMockMouse(setup.renderer).click(allowOnce.screenX + 1, allowOnce.screenY);
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

  test("keeps media outside the preload viewport as a placeholder until scrolling near it", async () => {
    const markdown = [
      "# Lazy media",
      ...Array.from({ length: 100 }, (_, index) => `Paragraph ${index + 1}: bounded preview work.`),
      "![late](assets/late.png)",
    ].join("\n\n");
    const remote = new MapRemoteResourceProvider({
      "/docs/README.md": Buffer.from(markdown),
      "/docs/assets/late.png": pngFixture(),
    });
    await createPreview(remote, { width: 70, height: 16 });
    const scroll = preview?.findDescendantById("preview-scroll") as ScrollBoxRenderable | undefined;
    if (!scroll || !setup) throw new Error("Expected lazy media scrollbox");
    await waitUntil(
      () => scroll.scrollHeight > scroll.height * 3,
      () => `${scroll.scrollHeight}/${scroll.height}`,
    );
    for (let index = 0; index < 3; index += 1) await setup.renderOnce();
    expect(remote.downloads).not.toContain("/docs/assets/late.png");

    scroll.scrollTop = scroll.scrollHeight;
    await createMockMouse(setup.renderer).scroll(scroll.screenX + 1, scroll.screenY + 1, "down");
    await waitUntil(
      () => statusText("status-media-1").includes("truecolor-cells"),
      () => `status-media-1=${statusText("status-media-1")}`,
    );
    expect(remote.downloads).toContain("/docs/assets/late.png");
  });

  test("limits a RichDocument to two concurrent media resource tasks", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const markdown = [
      "# Concurrency",
      "![one](assets/one.png)",
      "![two](assets/two.png)",
      "![three](assets/three.png)",
      "![four](assets/four.png)",
    ].join("\n\n");
    const remote = new MapRemoteResourceProvider(
      {
        "/docs/README.md": Buffer.from(markdown),
        "/docs/assets/one.png": pngFixture(),
        "/docs/assets/two.png": pngFixture(),
        "/docs/assets/three.png": pngFixture(),
        "/docs/assets/four.png": pngFixture(),
      },
      { beforeMaterialize: async () => gate },
    );
    await createPreview(remote);
    await waitUntil(
      () => remote.activeMaterializations === 2,
      () =>
        `active=${remote.activeMaterializations} max=${remote.maximumMaterializations} starts=${remote.downloads.length}`,
    );
    expect(remote.downloads).toHaveLength(2);
    expect(remote.maximumMaterializations).toBe(2);

    release?.();
    await waitUntil(
      () =>
        [1, 2, 3, 4].every((index) =>
          statusText(`status-media-${index}`).includes("truecolor-cells"),
        ),
      () => `downloads=${remote.downloads.length}`,
    );
    expect(remote.downloads).toHaveLength(4);
    expect(remote.maximumMaterializations).toBe(2);
  });

  test("cancels an in-flight preload while hidden and restarts it when presented again", async () => {
    let firstAttempt = true;
    let producerAbortObserved = false;
    const markdown = "# Hide cancellation\n\n![image](assets/image.png)";
    const remote = new MapRemoteResourceProvider(
      {
        "/docs/README.md": Buffer.from(markdown),
        "/docs/assets/image.png": pngFixture(),
      },
      {
        beforeMaterialize: async (_source, signal) => {
          if (!firstAttempt) return;
          firstAttempt = false;
          await new Promise<void>((_resolve, reject) => {
            const onAbort = () => {
              producerAbortObserved = true;
              reject(signal?.reason);
            };
            if (signal?.aborted) onAbort();
            else signal?.addEventListener("abort", onAbort, { once: true });
          });
        },
      },
    );
    await createPreview(remote);
    await waitUntil(
      () => remote.activeMaterializations === 1,
      () => `active=${remote.activeMaterializations}`,
    );

    preview?.setPresented(false);
    await waitUntil(
      () => producerAbortObserved && remote.activeMaterializations === 0,
      () => `aborted=${producerAbortObserved} active=${remote.activeMaterializations}`,
    );
    preview?.setPresented(true);
    await waitUntil(
      () => statusText("status-media-1").includes("truecolor-cells"),
      () => `status-media-1=${statusText("status-media-1")}`,
    );
    expect(remote.downloads).toEqual(["/docs/assets/image.png", "/docs/assets/image.png"]);
  });

  test("preloads a nearby GIF without autoplaying until the block is actually visible", async () => {
    const markdown = [
      "# Visible GIF",
      ...Array.from({ length: 8 }, (_, index) => `Paragraph ${index + 1}`),
      "![animated](assets/animated.gif)",
    ].join("\n\n");
    const remote = new MapRemoteResourceProvider({
      "/docs/README.md": Buffer.from(markdown),
      "/docs/assets/animated.gif": Buffer.from(
        "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
        "base64",
      ),
    });
    await createPreview(remote, { width: 70, height: 16 });
    await waitUntil(
      () => preview?.selectedMedia()?.inspectPlayback()?.status === "paused",
      () => JSON.stringify(preview?.selectedMedia()?.inspectPlayback()),
    );
    const scroll = preview?.findDescendantById("preview-scroll") as ScrollBoxRenderable | undefined;
    if (!scroll || !setup) throw new Error("Expected GIF scrollbox");
    expect(remote.downloads).toContain("/docs/assets/animated.gif");

    scroll.scrollTop = scroll.scrollHeight;
    await createMockMouse(setup.renderer).scroll(scroll.screenX + 1, scroll.screenY + 1, "down");
    await waitUntil(
      () => preview?.selectedMedia()?.inspectPlayback()?.status === "playing",
      () => JSON.stringify(preview?.selectedMedia()?.inspectPlayback()),
    );
  }, 30_000);

  test("reads text in 512 KiB increments and exposes explicit bounded load-more", async () => {
    const content = Buffer.alloc(2 * 1024 * 1024, 0x61);
    const remote = new MapRemoteResourceProvider({ "/docs/README.md": content });
    await createPreview(remote);
    await waitUntil(
      () => statusText("preview-status").includes("512.0 KiB of 2.0 MiB"),
      () => statusText("preview-status"),
    );
    expect(remote.reads.map(({ offset, length }) => ({ offset, length }))).toEqual([
      { offset: 0, length: 8 * 1024 },
      { offset: 8 * 1024, length: 512 * 1024 - 8 * 1024 },
    ]);
    const loadMore = preview?.findDescendantById("preview-load-more");
    if (!loadMore || !setup) throw new Error("Expected bounded load-more button");
    await createMockMouse(setup.renderer).click(loadMore.screenX + 1, loadMore.screenY);
    await waitUntil(
      () => statusText("preview-status").includes("1.0 MiB of 2.0 MiB"),
      () => statusText("preview-status"),
    );
    expect(remote.reads.at(-1)).toMatchObject({
      offset: 512 * 1024,
      length: 512 * 1024,
    });
    expect(remote.reads.every(({ length }) => length <= 512 * 1024)).toBe(true);
  });

  test("sniffs an unknown binary once and never decodes or materializes it as text", async () => {
    const remote = new MapRemoteResourceProvider({
      "/docs/README.md": Buffer.alloc(2 * 1024 * 1024, 0),
    });
    await createPreview(remote);
    await waitUntil(
      () => setup?.captureCharFrame().includes("Binary content is not decoded as text") ?? false,
      () => setup?.captureCharFrame() ?? "no frame",
    );
    expect(remote.reads).toEqual([{ path: "/docs/README.md", offset: 0, length: 8 * 1024 }]);
    expect(remote.downloads).toEqual([]);
  });

  test("scrolls Markdown with the mouse wheel and persists the preview offset", async () => {
    const markdown = [
      "# Mouse scroll",
      ...Array.from(
        { length: 80 },
        (_, index) => `Paragraph ${index + 1}: persistent remote notes.`,
      ),
    ].join("\n\n");
    let persistedOffset = 0;
    await createPreview(
      new MapRemoteResourceProvider({ "/docs/README.md": Buffer.from(markdown) }),
      {
        width: 70,
        height: 18,
        onPaneUpdate: (offset) => {
          persistedOffset = offset;
        },
      },
    );
    const scroll = preview?.findDescendantById("preview-scroll") as ScrollBoxRenderable | undefined;
    if (!scroll || !setup) throw new Error("Expected Markdown scrollbox");
    await waitUntil(
      () => scroll.scrollHeight > scroll.height,
      () => `${scroll.scrollHeight}/${scroll.height}`,
    );
    const mouse = createMockMouse(setup.renderer);
    for (let index = 0; index < 6; index += 1) {
      await mouse.scroll(scroll.screenX + 2, scroll.screenY + 2, "down");
    }
    await setup.renderOnce();
    expect(scroll.scrollTop).toBeGreaterThan(0);
    expect(persistedOffset).toBeGreaterThan(0);
  });

  test("reports active playback and reloads current media after confirmed runtime settings", async () => {
    const markdown = "# Reload\n\n![GIF](assets/animated.gif)";
    await createPreview(
      new MapRemoteResourceProvider({
        "/docs/README.md": Buffer.from(markdown),
        "/docs/assets/animated.gif": Buffer.from(
          "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
          "base64",
        ),
      }),
    );
    await waitUntil(
      () =>
        preview?.selectedMedia()?.inspectPlayback()?.status === "playing" &&
        Object.values(preview?.selectedMedia()?.inspectProcesses() ?? {}).length > 0,
      () =>
        `${JSON.stringify(preview?.selectedMedia()?.inspectPlayback())} ${JSON.stringify(
          preview?.selectedMedia()?.inspectProcesses(),
        )}`,
    );
    expect(preview?.hasPlayingMedia()).toBe(true);
    const oldProcessIds = Object.values(preview?.selectedMedia()?.inspectProcesses() ?? {});
    expect(oldProcessIds.length).toBeGreaterThan(0);
    if (!preview || !previewServices) throw new Error("Expected preview services");

    await preview.applyServices({
      ...previewServices,
      videoFramesPerSecond: 5,
      autoplayGif: false,
    });
    await waitUntil(
      () => preview?.selectedMedia()?.inspectPlayback()?.status === "paused",
      () => JSON.stringify(preview?.selectedMedia()?.inspectPlayback()),
    );
    expect(preview.hasPlayingMedia()).toBe(false);
    expect(oldProcessIds.every((pid) => !processIsAlive(pid))).toBe(true);
  }, 30_000);
});

async function createPreview(
  remote: MapRemoteResourceProvider,
  options: {
    width?: number;
    height?: number;
    onPaneUpdate?: (offset: number) => void;
  } = {},
): Promise<void> {
  const directory = await temporaryDirectory();
  const cache = new ResourceCache(join(directory, "cache"), 32 * 1024 * 1024);
  const permissions = new DomainPermissionGate();
  const rasterizer = new SvgRasterizer({ cache });
  setup = await createTestRenderer({ width: options.width ?? 120, height: options.height ?? 80 });
  previewServices = {
    loader: new ResourceLoader({ remote, cache, permissions }),
    permissions,
    decoder: new MediaDecoder({ maxWidth: 160, maxHeight: 120 }),
    rasterizer,
    formula: new FormulaRenderer({ cache, rasterizer }),
    math: testMathRenderer,
    adapter: {
      name: "truecolor-cells",
      terminal: "generic",
      protocol: "truecolor-half-block",
    },
    videoFramesPerSecond: 10,
    autoplayGif: true,
    mpv: { audioOutput: "null" },
  };
  preview = new RichDocumentRenderable(setup.renderer, {
    id: "preview",
    pane: {
      id: "preview-pane",
      kind: "preview",
      title: "README",
      target: { kind: "ssh", hostId: "fixture" },
      path: "/docs/README.md",
      scrollOffset: 0,
    },
    i18n: new I18n("en"),
    ...previewServices,
    onPaneUpdate: (pane) => options.onPaneUpdate?.(pane.scrollOffset),
  });
  setup.renderer.root.add(preview);
  preview.focus();
}

async function createLocalPreview(
  path: string,
  adapter: RichDocumentServices["adapter"] = {
    name: "truecolor-cells",
    terminal: "generic",
    protocol: "truecolor-half-block",
  },
): Promise<void> {
  const directory = await temporaryDirectory();
  const cache = new ResourceCache(join(directory, "cache"), 32 * 1024 * 1024);
  const permissions = new DomainPermissionGate();
  const rasterizer = new SvgRasterizer({ cache });
  setup = await createTestRenderer({ width: 120, height: 80 });
  previewServices = {
    loader: new ResourceLoader({ cache, permissions }),
    permissions,
    decoder: new MediaDecoder({ maxWidth: 160, maxHeight: 120 }),
    rasterizer,
    formula: new FormulaRenderer({ cache, rasterizer }),
    math: testMathRenderer,
    adapter,
    videoFramesPerSecond: 10,
    autoplayGif: true,
    mpv: { audioOutput: "null" },
  };
  preview = new RichDocumentRenderable(setup.renderer, {
    id: "preview",
    pane: {
      id: "preview-pane",
      kind: "preview",
      title: "README",
      target: { kind: "local" },
      path,
      scrollOffset: 0,
    },
    i18n: new I18n("en"),
    ...previewServices,
  });
  setup.renderer.root.add(preview);
  preview.focus();
}

const testMathRenderer: MathRenderer = {
  async layout(source: string, display: boolean): Promise<MathLayout> {
    const normalized = source.trim();
    if (normalized.includes("\\int")) {
      return { lines: ["∫₀¹ x² dx = 1⁄3"], width: 17, height: 1, baseline: 0, display };
    }
    if (normalized.includes("\\sum")) {
      return { lines: ["Σₙ₌₁∞ 1⁄n² = π²⁄6"], width: 20, height: 1, baseline: 0, display };
    }
    if (normalized.includes("\\frac")) {
      return { lines: [" a ", "───", " b "], width: 3, height: 3, baseline: 1, display };
    }
    if (normalized.includes("\\sqrt")) {
      return { lines: ["√x"], width: 2, height: 1, baseline: 0, display };
    }
    if (normalized.includes("\\alpha")) {
      return { lines: ["α + β"], width: 5, height: 1, baseline: 0, display };
    }
    const line = normalized.replace(/\^2/g, "²");
    return { lines: [line], width: line.length, height: 1, baseline: 0, display };
  },
};

class MapRemoteResourceProvider implements RemoteResourceReader {
  public readonly downloads: string[] = [];
  public readonly reads: Array<{ path: string; offset: number; length: number }> = [];
  public activeMaterializations = 0;
  public maximumMaterializations = 0;
  private readonly resources: ReadonlyMap<string, Uint8Array>;

  public constructor(
    resources: Readonly<Record<string, Uint8Array>>,
    private readonly options: {
      beforeMaterialize?: (source: string, signal: AbortSignal | undefined) => Promise<void>;
    } = {},
  ) {
    this.resources = new Map(Object.entries(resources));
  }

  public async stat(_hostId: string, path: string): Promise<FileEntry> {
    const content = this.resource(path);
    const mimeType = lookup(extname(path));
    return {
      name: path.split("/").at(-1) ?? path,
      path,
      size: content.byteLength,
      isDirectory: false,
      isSymbolicLink: false,
      ...(mimeType ? { mimeType } : {}),
      modifiedAt: new Date("2026-07-28T00:00:00.000Z"),
      hashes: {},
    };
  }

  public async read(
    _hostId: string,
    path: string,
    options: { offset?: number; length?: number; signal?: AbortSignal } = {},
  ): Promise<Uint8Array> {
    options.signal?.throwIfAborted();
    const content = this.resource(path);
    const offset = options.offset ?? 0;
    const length = options.length ?? content.byteLength;
    this.reads.push({ path, offset, length });
    return content.slice(offset, offset + length);
  }

  public async materialize(
    _hostId: string,
    source: string,
    destination: string,
    options: { signal?: AbortSignal; maxBytes: number },
  ): Promise<void> {
    options.signal?.throwIfAborted();
    const content = this.resource(source);
    if (content.byteLength > options.maxBytes) throw new Error("too large");
    this.downloads.push(source);
    this.activeMaterializations += 1;
    this.maximumMaterializations = Math.max(
      this.maximumMaterializations,
      this.activeMaterializations,
    );
    try {
      await this.options.beforeMaterialize?.(source, options.signal);
      options.signal?.throwIfAborted();
      await writeFile(destination, content, { mode: 0o600 });
    } finally {
      this.activeMaterializations -= 1;
    }
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

function pngFixture(): Uint8Array {
  return new KittyFrameEncoder().encodeImage(
    new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]),
    2,
    2,
    5,
  );
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
