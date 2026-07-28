import { afterEach, describe, expect, test } from "bun:test";
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
    expect(output.text.length).toBe(beforeDestroy);
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

function fixtureFrame(): RgbFrame {
  return {
    width: 2,
    height: 2,
    rgb: new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]),
  };
}
