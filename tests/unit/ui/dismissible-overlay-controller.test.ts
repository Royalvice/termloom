import { afterEach, describe, expect, test } from "bun:test";
import { BoxRenderable, CliRenderEvents, type KeyEvent, type Renderable } from "@opentui/core";
import { createMockMouse, createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { DismissibleOverlayController } from "../../../src/ui/dismissible-overlay-controller.js";

let setup: TestRendererSetup | undefined;
let root: BoxRenderable | undefined;
let controller: DismissibleOverlayController | undefined;

afterEach(() => {
  controller?.destroy();
  root?.destroyRecursively();
  setup?.renderer.destroy();
  controller = undefined;
  root = undefined;
  setup = undefined;
});

describe("DismissibleOverlayController", () => {
  test("anchors the menu to the pointer while clamping it inside the viewport", async () => {
    await createController(50, 15);
    controller?.openContextMenu(
      {
        x: 49,
        y: 14,
        title: "fixture",
        actions: [
          { id: "open", label: "Open a deliberately wide action", run: () => undefined },
          { id: "rename", label: "Rename", run: () => undefined },
        ],
      },
      () => undefined,
    );
    await requiredSetup().renderOnce();

    const menu = findRenderable((value) => value.id.endsWith("-menu"));
    expect(menu).toBeDefined();
    expect((menu?.screenX ?? 0) + (menu?.width ?? 0)).toBeLessThanOrEqual(50);
    expect((menu?.screenY ?? 0) + (menu?.height ?? 0)).toBeLessThanOrEqual(15);
  });

  test("dismisses on Escape and restores the previous focus", async () => {
    await createController();
    const focusTarget = new BoxRenderable(requiredSetup().renderer, {
      id: "focus-target",
      width: 1,
      height: 1,
      focusable: true,
    });
    root?.add(focusTarget);
    focusTarget.focus();
    controller?.openContextMenu(request(), () => focusTarget.focus());
    await requiredSetup().renderOnce();

    const overlay = findRenderable((value) => value.id.startsWith("context-overlay-"));
    overlay?.handleKeyPress?.(key("escape"));
    expect(controller?.isOpen).toBe(false);
    expect(focusTarget.focused).toBe(true);
  });

  test("dismisses on an outside click and a second right-click request", async () => {
    await createController();
    controller?.openContextMenu(request(20, 6), () => undefined);
    await requiredSetup().renderOnce();
    await createMockMouse(requiredSetup().renderer).click(0, 0);
    expect(controller?.isOpen).toBe(false);

    controller?.openContextMenu(request(), () => undefined);
    expect(controller?.isOpen).toBe(true);
    controller?.openContextMenu(request(), () => undefined);
    expect(controller?.isOpen).toBe(false);
  });

  test("runs a clicked action once and closes the menu", async () => {
    await createController();
    let runs = 0;
    controller?.openContextMenu(
      {
        x: 4,
        y: 3,
        actions: [{ id: "run", label: "Run", run: () => (runs += 1) }],
      },
      () => undefined,
    );
    await requiredSetup().renderOnce();
    const action = findRenderable((value) => value.id.endsWith("-action-run"));
    if (!action) throw new Error("Expected context action row");
    await createMockMouse(requiredSetup().renderer).click(action.screenX + 1, action.screenY);

    expect(runs).toBe(1);
    expect(controller?.isOpen).toBe(false);
  });

  test("dismisses on renderer resize and blur", async () => {
    await createController();
    controller?.openContextMenu(request(), () => undefined);
    requiredSetup().resize(70, 20);
    expect(controller?.isOpen).toBe(false);

    controller?.openContextMenu(request(), () => undefined);
    requiredSetup().renderer.emit(CliRenderEvents.BLUR);
    expect(controller?.isOpen).toBe(false);
  });
});

async function createController(width = 60, height = 18): Promise<void> {
  setup = await createTestRenderer({ width, height });
  root = new BoxRenderable(setup.renderer, {
    id: "overlay-root",
    width: "100%",
    height: "100%",
  });
  setup.renderer.root.add(root);
  controller = new DismissibleOverlayController(setup.renderer, root);
}

function request(x = 4, y = 3) {
  return {
    x,
    y,
    actions: [{ id: "open", label: "Open", run: () => undefined }],
  };
}

function findRenderable(predicate: (value: Renderable) => boolean): Renderable | undefined {
  const queue = [...(root?.getChildren() ?? [])];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || !("getChildren" in current)) continue;
    const renderable = current as Renderable;
    if (predicate(renderable)) return renderable;
    queue.push(...renderable.getChildren());
  }
  return undefined;
}

function requiredSetup(): TestRendererSetup {
  if (!setup) throw new Error("Expected test renderer");
  return setup;
}

function key(name: string): KeyEvent {
  return {
    name,
    sequence: name,
    raw: name,
    eventType: "press",
    ctrl: false,
    meta: false,
    shift: false,
    super: false,
    hyper: false,
    option: false,
    number: false,
  } as unknown as KeyEvent;
}
