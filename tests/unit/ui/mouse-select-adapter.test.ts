import { afterEach, describe, expect, test } from "bun:test";
import { SelectRenderable, TabSelectRenderable } from "@opentui/core";
import { createMockMouse, createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { attachMouseSelect, attachMouseTabs } from "../../../src/ui/mouse-select-adapter.js";

let setup: TestRendererSetup | undefined;
afterEach(() => {
  setup?.renderer.destroy();
  setup = undefined;
});

describe("OpenTUI mouse select adapter", () => {
  test("maps visible rows to Select items, scrolls, and double-clicks", async () => {
    setup = await createTestRenderer({ width: 40, height: 8 });
    const selected: number[] = [];
    const list = new SelectRenderable(setup.renderer, {
      id: "list",
      width: 30,
      height: 6,
      showDescription: false,
      options: Array.from({ length: 12 }, (_, index) => ({
        name: `item-${index}`,
        description: "",
        value: index,
      })),
    });
    attachMouseSelect(list, { onDoubleClick: (index) => selected.push(index) });
    setup.renderer.root.add(list);
    await setup.renderOnce();
    const mouse = createMockMouse(setup.renderer);

    await mouse.click(list.x + 2, list.y + 3);
    expect(list.getSelectedIndex()).toBe(3);
    await mouse.doubleClick(list.x + 2, list.y + 4);
    expect(list.getSelectedIndex()).toBe(4);
    expect(selected).toContain(4);
    await mouse.scroll(list.x + 2, list.y + 2, "down");
    expect(list.getSelectedIndex()).toBeGreaterThan(4);
  });

  test("maps horizontal TabSelect items and scrolls between them", async () => {
    setup = await createTestRenderer({ width: 40, height: 4 });
    const tabs = new TabSelectRenderable(setup.renderer, {
      id: "tabs",
      width: 30,
      tabWidth: 10,
      options: [
        { name: "one", description: "" },
        { name: "two", description: "" },
        { name: "three", description: "" },
      ],
    });
    attachMouseTabs(tabs);
    setup.renderer.root.add(tabs);
    await setup.renderOnce();
    const mouse = createMockMouse(setup.renderer);

    await mouse.click(tabs.x + 12, tabs.y);
    expect(tabs.getSelectedIndex()).toBe(1);
    await mouse.scroll(tabs.x + 12, tabs.y, "right");
    expect(tabs.getSelectedIndex()).toBe(2);
  });

  test("does not treat the same screen row as a double-click after scrolling", async () => {
    setup = await createTestRenderer({ width: 40, height: 5 });
    const activated: number[] = [];
    const list = new SelectRenderable(setup.renderer, {
      id: "scrolling-list",
      width: 30,
      height: 3,
      showDescription: false,
      options: Array.from({ length: 12 }, (_, index) => ({
        name: `item-${index}`,
        description: "",
      })),
    });
    attachMouseSelect(list, { onDoubleClick: (index) => activated.push(index) });
    setup.renderer.root.add(list);
    await setup.renderOnce();
    const mouse = createMockMouse(setup.renderer);

    await mouse.click(list.x + 1, list.y + 1);
    expect(list.getSelectedIndex()).toBe(1);
    await mouse.scroll(list.x + 1, list.y + 1, "down");
    await setup.renderOnce();
    await mouse.click(list.x + 1, list.y + 1);

    expect(list.getSelectedIndex()).not.toBe(1);
    expect(activated).toEqual([]);
  });
});
