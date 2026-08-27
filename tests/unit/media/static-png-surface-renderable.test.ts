import { afterEach, expect, test } from "bun:test";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { StaticPngSurfaceRenderable } from "../../../src/media/static-png-surface-renderable.js";
import type { MediaOutput } from "../../../src/media/types.js";

let setup: TestRendererSetup | undefined;
let surface: StaticPngSurfaceRenderable | undefined;

afterEach(() => {
  surface?.destroyRecursively();
  setup?.renderer.destroy();
  surface = undefined;
  setup = undefined;
});

test("places a native PNG tile through Kitty without re-encoding it", async () => {
  const output = new MemoryOutput();
  setup = await createTestRenderer({ width: 12, height: 6 });
  surface = new StaticPngSurfaceRenderable(setup.renderer, {
    id: "png-tile",
    adapter: "kitty",
    output,
    width: 10,
    height: 4,
    sourceWidth: 800,
    sourceHeight: 640,
  });
  setup.renderer.root.add(surface);
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  surface.setPng(png);
  await setup.renderOnce();

  expect(setup.captureCharFrame()).toContain("\u00a0");
  expect(output.text).toContain("\u001b_Ga=T,f=100");
  expect(output.text).toContain("c=10,r=4,m=0;");
  expect(output.text).toContain(Buffer.from(png).toString("base64"));

  const beforeDestroy = output.text.length;
  surface.destroyRecursively();
  const cleanup = output.text.slice(beforeDestroy);
  expect(cleanup).toContain("\u001b_Ga=d,d=I,i=");
  expect(cleanup).toContain(",q=2\u001b\\");
  expect(cleanup).not.toContain(";");
});

test("places and clears a native PNG tile through iTerm2", async () => {
  const output = new MemoryOutput();
  setup = await createTestRenderer({ width: 12, height: 6 });
  surface = new StaticPngSurfaceRenderable(setup.renderer, {
    id: "iterm-png-tile",
    adapter: "iterm2",
    output,
    width: 10,
    height: 4,
    sourceWidth: 800,
    sourceHeight: 640,
    itermImageEncoder: (_png, width, height) => `<image:${width}x${height}>`,
  });
  setup.renderer.root.add(surface);
  surface.setPng(new Uint8Array([1, 2, 3]));
  await setup.renderOnce();

  expect(output.text).toContain("\u001b[1;1H<image:10x4>");
  const beforeHide = output.text.length;
  surface.setPresented(false);
  expect(output.text.slice(beforeHide)).toContain("\u001b[1;1H");
  expect(output.text.slice(beforeHide)).toContain("          ");
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
