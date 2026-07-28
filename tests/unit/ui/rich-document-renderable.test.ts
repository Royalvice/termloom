import { afterEach, describe, expect, test } from "bun:test";
import type { KeyEvent, TextRenderable } from "@opentui/core";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
import type { ConflictPolicy, RemoteFileEntry } from "../../../src/sftp/rclone-sftp.js";
import { TransferQueue } from "../../../src/sftp/transfer-queue.js";
import { RichDocumentRenderable } from "../../../src/ui/rich-document-renderable.js";

const temporaryDirectories: string[] = [];
let setup: TestRendererSetup | undefined;
let preview: RichDocumentRenderable | undefined;

afterEach(async () => {
  preview?.destroyRecursively();
  setup?.renderer.destroy();
  preview = undefined;
  setup = undefined;
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("RichDocumentRenderable", () => {
  test("renders remote Markdown, PNG, SVG, GIF, a video poster, and formulas in its OpenTUI pane", async () => {
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
      "/docs/assets/movie.mp4": Buffer.from("unused because the poster is authoritative"),
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
    expect(remote.downloads).not.toContain("/docs/assets/movie.mp4");
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
