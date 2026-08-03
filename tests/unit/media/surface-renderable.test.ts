import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { MediaSurfaceRenderable } from "../../../src/media/surface-renderable.js";
import type { MediaOutput, RgbFrame } from "../../../src/media/types.js";

let setup: TestRendererSetup | undefined;
let surface: MediaSurfaceRenderable | undefined;

afterEach(() => {
  surface?.destroyRecursively();
  setup?.renderer.destroy();
  surface = undefined;
  setup = undefined;
});

describe("MediaSurfaceRenderable", () => {
  test("draws an RGB frame inside the OpenTUI framebuffer with truecolor half blocks", async () => {
    setup = await createTestRenderer({ width: 12, height: 5 });
    surface = new MediaSurfaceRenderable(setup.renderer, {
      id: "surface",
      adapter: "truecolor-cells",
      width: 12,
      height: 5,
    });
    setup.renderer.root.add(surface);
    surface.setFrame(fixtureFrame());
    await setup.renderOnce();

    const frame = setup.captureCharFrame();
    expect(frame).toContain("▀");
    expect(surface.inspectFrame()).toEqual(fixtureFrame());
  });

  test("uses kitty-motion Unicode placement and emits a real Kitty graphics payload", async () => {
    const output = new MemoryOutput();
    setup = await createTestRenderer({ width: 8, height: 4 });
    surface = new MediaSurfaceRenderable(setup.renderer, {
      id: "surface",
      adapter: "kitty",
      terminal: "kitty",
      output,
      width: 8,
      height: 4,
    });
    setup.renderer.root.add(surface);
    surface.setFrame(fixtureFrame());
    await setup.renderOnce();
    const nextFrame = fixtureFrame();
    nextFrame.rgb[0] = 0;
    surface.setFrame(nextFrame);
    await setup.renderOnce();

    expect(output.text).toContain("\u001b_G");
    expect(output.text).toContain("U=1");
    expect(output.text).toContain("a=f");
    expect(output.text).toContain("\u{10eeee}");
    expect(output.text).toContain("\u001b[1;1H");
    expect(setup.captureCharFrame()).toContain("\u00a0");
    expect(surface.adapter).toBe("kitty");
  });

  test("keeps a 768px Ghostty image as a native high-resolution Kitty raster", async () => {
    const output = new MemoryOutput();
    setup = await createTestRenderer({ width: 42, height: 22 });
    surface = new MediaSurfaceRenderable(setup.renderer, {
      id: "surface",
      adapter: "kitty",
      terminal: "ghostty",
      output,
      width: 40,
      height: 20,
    });
    setup.renderer.root.add(surface);
    surface.setFrame(detailFrame(768, 768));
    await setup.renderOnce();
    await waitFor(
      () => output.text.includes(`${String.fromCharCode(0x1b)}_G`) && output.text.includes("m=0"),
    );

    const png = firstKittyPng(output.text);
    expect(pngDimensions(png)).toEqual({ width: 1536, height: 1536 });
    expect(output.text).toContain("a=T,U=1,f=100");
    expect(output.text).toContain("\u{10eeee}");
  });

  test("uses full-frame replacement for Ghostty animation instead of unsupported a=f edits", async () => {
    const output = new MemoryOutput();
    setup = await createTestRenderer({ width: 8, height: 4 });
    surface = new MediaSurfaceRenderable(setup.renderer, {
      id: "surface",
      adapter: "kitty",
      terminal: "ghostty",
      output,
      width: 8,
      height: 4,
    });
    setup.renderer.root.add(surface);
    surface.setFrame(fixtureFrame());
    await setup.renderOnce();
    const nextFrame = fixtureFrame();
    nextFrame.rgb[0] = 0;
    surface.setFrame(nextFrame);
    await setup.renderOnce();

    expect(output.text).toContain("a=T,U=1");
    expect(output.text).toContain("a=t,f=100");
    expect(output.text).not.toContain("a=f");
  });

  test("positions an iTerm2 inline image while OpenTUI owns region cleanup", async () => {
    const output = new MemoryOutput();
    setup = await createTestRenderer({ width: 16, height: 6 });
    surface = new MediaSurfaceRenderable(setup.renderer, {
      id: "surface",
      adapter: "iterm2",
      output,
      width: 10,
      height: 4,
      itermImageEncoder: (_png, width, height) => `<image:${width}x${height}>`,
    });
    setup.renderer.root.add(surface);
    surface.setFrame(fixtureFrame());
    await setup.renderOnce();

    expect(output.text).toContain("\u001b[1;1H<image:10x4>");
    const afterFirstFrame = output.text.length;
    surface.left = 2;
    await setup.renderOnce();
    expect(output.text.length).toBeGreaterThan(afterFirstFrame);
    expect(output.text.slice(afterFirstFrame)).toContain("\u001b[1;3H<image:10x4>");
    expect(setup.captureCharFrame()).toContain("\u00a0");
    surface.visible = false;
    await setup.renderOnce();
    expect(setup.captureCharFrame()).not.toContain("\u00a0");
    const beforeDestroy = output.text.length;
    surface.destroyRecursively();
    surface = undefined;
    expect(output.text.length).toBeGreaterThan(beforeDestroy);
    expect(output.text.slice(beforeDestroy)).not.toContain("<image:");
  });

  test("emits nothing while hidden or detached and restores at the current region", async () => {
    const output = new MemoryOutput();
    setup = await createTestRenderer({ width: 18, height: 8 });
    surface = new MediaSurfaceRenderable(setup.renderer, {
      id: "surface",
      adapter: "iterm2",
      output,
      width: 10,
      height: 4,
      itermImageEncoder: (_png, width, height) => `<image:${width}x${height}>`,
    });
    setup.renderer.root.add(surface);
    surface.setFrame(fixtureFrame());
    await setup.renderOnce();

    surface.setPresented(false);
    const afterHideCleanup = output.text.length;
    surface.setFrame(detailFrame(3, 3));
    await setup.renderOnce();
    expect(output.text.length).toBe(afterHideCleanup);
    expect(surface.inspectOutputState()).toMatchObject({ presented: false, encodedFrames: 1 });

    surface.setPresented(true);
    surface.left = 3;
    await setup.renderOnce();
    expect(output.text.slice(afterHideCleanup)).toContain("\u001b[1;4H<image:10x4>");

    surface.setPresented(false);
    const afterSecondCleanup = output.text.length;
    setup.renderer.root.remove(surface);
    surface.setFrame(detailFrame(4, 4));
    surface.setPresented(true);
    await setup.renderOnce();
    expect(output.text.length).toBe(afterSecondCleanup);
  });

  test("keeps only the latest frame under backpressure and registers one drain listener", async () => {
    const output = new BackpressuredOutput();
    setup = await createTestRenderer({ width: 18, height: 8 });
    surface = new MediaSurfaceRenderable(setup.renderer, {
      id: "surface",
      adapter: "iterm2",
      output,
      width: 10,
      height: 4,
      itermImageEncoder: (png) => `<image:${png[0] ?? 0}>`,
    });
    setup.renderer.root.add(surface);

    surface.setFrame(coloredFrame(10));
    await setup.renderOnce();
    expect(surface.inspectOutputState()).toMatchObject({
      backpressured: true,
      drainListenerAttached: true,
      encodedFrames: 1,
    });
    expect(output.listenerCount("drain")).toBe(1);
    const writesAtBackpressure = output.writes.length;

    surface.setFrame(coloredFrame(20));
    surface.setFrame(coloredFrame(30));
    await setup.renderOnce();
    expect(output.writes).toHaveLength(writesAtBackpressure);
    expect(surface.inspectFrame()?.rgb[0]).toBe(30);
    expect(surface.inspectOutputState().droppedFrames).toBeGreaterThanOrEqual(1);
    expect(output.listenerCount("drain")).toBe(1);

    output.release();
    await setup.renderOnce();
    expect(surface.inspectOutputState()).toMatchObject({
      backpressured: false,
      framePending: false,
      drainListenerAttached: false,
      encodedFrames: 2,
    });
    expect(output.listenerCount("drain")).toBe(0);
    expect(output.writes.length).toBe(writesAtBackpressure + 1);
  });
});

class MemoryOutput implements MediaOutput {
  public text = "";

  public write(chunk: string): boolean {
    this.text += chunk;
    return true;
  }

  public once(): this {
    return this;
  }
}

class BackpressuredOutput extends EventEmitter implements MediaOutput {
  public readonly writes: string[] = [];
  private writable = false;

  public write(chunk: string): boolean {
    this.writes.push(chunk);
    return this.writable;
  }

  public release(): void {
    this.writable = true;
    this.emit("drain");
  }
}

function fixtureFrame(): RgbFrame {
  return {
    width: 2,
    height: 2,
    rgb: new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]),
  };
}

function coloredFrame(red: number): RgbFrame {
  return {
    width: 2,
    height: 2,
    rgb: new Uint8Array([red, 0, 0, red, 0, 0, red, 0, 0, red, 0, 0]),
  };
}

function detailFrame(width: number, height: number): RgbFrame {
  const rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3;
      const bright = (x + y) % 2 === 0;
      rgb[offset] = bright ? 255 : 0;
      rgb[offset + 1] = bright ? 255 : 32;
      rgb[offset + 2] = bright ? 255 : 96;
    }
  }
  return { width, height, rgb };
}

function firstKittyPng(output: string): Uint8Array {
  const escapeSequence = String.fromCharCode(0x1b);
  const pattern = new RegExp(
    `${escapeSequence}_G([^;${escapeSequence}]*);([A-Za-z0-9+/=]*)${escapeSequence}\\\\`,
    "gu",
  );
  const chunks = [...output.matchAll(pattern)];
  const encoded: string[] = [];
  let collecting = false;
  for (const match of chunks) {
    const control = match[1] ?? "";
    if (control.startsWith("a=T")) collecting = true;
    if (!collecting) continue;
    encoded.push(match[2] ?? "");
    if (control.includes("m=0")) break;
  }
  if (encoded.length === 0) throw new Error("No complete Kitty PNG payload was emitted");
  return new Uint8Array(Buffer.from(encoded.join(""), "base64"));
}

function pngDimensions(png: Uint8Array): { width: number; height: number } {
  if (png.length < 24 || new TextDecoder().decode(png.subarray(12, 16)) !== "IHDR") {
    throw new Error("Kitty payload is not a PNG with an IHDR chunk");
  }
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(5);
  }
  throw new Error("Timed out waiting for media output");
}
