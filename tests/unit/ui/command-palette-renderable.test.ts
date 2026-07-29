import { afterEach, describe, expect, test } from "bun:test";
import type { InputRenderable } from "@opentui/core";
import { createMockMouse, createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import {
  CommandPaletteRenderable,
  type PaletteCommand,
} from "../../../src/ui/command-palette-renderable.js";

let setup: TestRendererSetup | undefined;
let palette: CommandPaletteRenderable | undefined;

afterEach(() => {
  palette?.destroyRecursively();
  setup?.renderer.destroy();
  palette = undefined;
  setup = undefined;
});

describe("CommandPaletteRenderable", () => {
  test("searches commands and executes the selected result by mouse", async () => {
    const executed: string[] = [];
    let closed = 0;
    await createPalette(80, 24, commands(executed), () => {
      closed += 1;
    });
    if (!setup || !palette) throw new Error("Expected command palette");
    await setup.waitForFrame((frame) => frame.includes("Split horizontally"));

    const search = palette.findDescendantById("palette-search") as InputRenderable;
    search.focus();
    await setup.mockInput.typeText("terminal");
    await setup.waitForFrame(
      (frame) => frame.includes("Switch Files / Terminal") && !frame.includes("Split horizontally"),
    );

    const list = palette.findDescendantById("palette-list");
    if (!list) throw new Error("Expected command list");
    await createMockMouse(setup.renderer).click(list.screenX + 2, list.screenY);
    expect(executed).toEqual(["switch"]);
    expect(closed).toBe(1);
  });

  test("supports click selection, Escape/F1, Close, and a narrow 80x24 layout", async () => {
    const executed: string[] = [];
    let closed = 0;
    await createPalette(80, 24, commands(executed), () => {
      closed += 1;
    });
    if (!setup || !palette) throw new Error("Expected command palette");
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("Help & Commands");
    expect(frame).toContain("F2");

    const list = palette.findDescendantById("palette-list");
    if (!list) throw new Error("Expected command list");
    const mouse = createMockMouse(setup.renderer);
    await mouse.click(list.screenX + 2, list.screenY + 2);
    expect(executed).toEqual(["split"]);

    setup.mockInput.pressEscape();
    await Bun.sleep(80);
    expect(closed).toBe(2);

    const close = palette.findDescendantById("palette-close");
    if (!close) throw new Error("Expected close button");
    await mouse.click(close.screenX + 2, close.screenY);
    expect(closed).toBe(3);

    const search = palette.findDescendantById("palette-search") as InputRenderable;
    search.focus();
    setup.mockInput.pressKey("F1");
    expect(closed).toBe(4);
  });
});

async function createPalette(
  width: number,
  height: number,
  values: readonly PaletteCommand[],
  onClose: () => void,
): Promise<void> {
  setup = await createTestRenderer({ width, height });
  palette = new CommandPaletteRenderable(setup.renderer, {
    id: "palette",
    commands: values,
    onClose,
  });
  setup.renderer.root.add(palette);
}

function commands(executed: string[]): PaletteCommand[] {
  return [
    {
      id: "switch",
      title: "Switch Files / Terminal",
      shortcut: "F2",
      run: () => executed.push("switch"),
    },
    {
      id: "split",
      title: "Split horizontally",
      shortcut: "Ctrl+G S",
      run: () => executed.push("split"),
    },
    { id: "settings", title: "Settings", run: () => executed.push("settings") },
  ];
}
