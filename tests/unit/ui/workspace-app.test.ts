import { afterEach, describe, expect, test } from "bun:test";
import { TextRenderable, type Renderable } from "@opentui/core";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { defaultConfig } from "../../../src/config/schema.js";
import { I18n } from "../../../src/i18n/i18n.js";
import type { PaneViewFactory } from "../../../src/ui/pane-factory.js";
import { WorkspaceApp } from "../../../src/ui/workspace-app.js";
import { WorkspaceController } from "../../../src/workspace/controller.js";
import { collectPaneIds } from "../../../src/workspace/reducer.js";
import { createDefaultWorkspace, type WorkspaceSnapshot } from "../../../src/workspace/schema.js";

let setup: TestRendererSetup | undefined;
let app: WorkspaceApp | undefined;

afterEach(() => {
  app?.destroy();
  setup?.renderer.destroy();
  app = undefined;
  setup = undefined;
});

class MemoryPersistence {
  public saved: WorkspaceSnapshot[] = [];
  public async save(snapshot: WorkspaceSnapshot): Promise<void> {
    this.saved.push(structuredClone(snapshot));
  }
}

async function renderWorkspace(width: number, height: number) {
  setup = await createTestRenderer({ width, height });
  const state = createDefaultWorkspace();
  state.panes["files-1"] = {
    id: "files-1",
    kind: "files",
    title: "Remote files",
    hostId: "demo",
    path: "/srv/project",
  };
  const firstTab = state.tabs[0];
  if (!firstTab) throw new Error("Expected default tab");
  firstTab.root = {
    type: "split",
    id: "split-fixture",
    direction: "horizontal",
    ratio: 0.42,
    first: { type: "pane", paneId: "pane-local-1" },
    second: { type: "pane", paneId: "files-1" },
  };
  const persistence = new MemoryPersistence();
  const controller = new WorkspaceController(state, persistence);
  const activeSetup = setup;
  const factory: PaneViewFactory = {
    create: (pane): Renderable =>
      new TextRenderable(activeSetup.renderer, {
        id: `fixture-${pane.id}`,
        content: `fixture:${pane.kind}:${pane.title}`,
      }),
  };
  app = new WorkspaceApp(setup.renderer, defaultConfig(), new I18n("en"), controller, factory);
  await setup.renderOnce();
  return { frame: setup.captureCharFrame(), controller, persistence };
}

describe("WorkspaceApp", () => {
  for (const [width, height] of [
    [80, 24],
    [120, 40],
    [200, 60],
  ] as const) {
    test(`matches the ${width}x${height} recursive split snapshot`, async () => {
      const { frame } = await renderWorkspace(width, height);
      expect(frame).toMatchSnapshot();
    });
  }

  test("rebuilds recursive layout and persists focus changes", async () => {
    const { controller, persistence } = await renderWorkspace(100, 30);
    controller.dispatch({ type: "focus-pane", paneId: "files-1" });
    controller.dispatch({
      type: "split-pane",
      paneId: "files-1",
      direction: "vertical",
      pane: {
        id: "preview-1",
        kind: "preview",
        title: "README.md",
        hostId: "demo",
        path: "/srv/project/README.md",
        scrollOffset: 0,
      },
    });
    await controller.flush();
    await setup?.renderOnce();
    const frame = setup?.captureCharFrame() ?? "";
    expect(frame).toContain("README.md");
    expect(frame).toContain("fixture:preview:README.md");
    expect(persistence.saved.at(-1)?.tabs[0]?.activePaneId).toBe("preview-1");
  });

  test("dispatches leader sequences through the OpenTUI input pipeline", async () => {
    const { controller } = await renderWorkspace(100, 30);
    const initialTab = controller.state.tabs[0];
    if (!initialTab) throw new Error("Expected default tab");
    const before = collectPaneIds(initialTab.root).length;

    setup?.mockInput.pressKey(" ", { ctrl: true });
    setup?.mockInput.pressKey("s");
    await controller.flush();

    const tab = controller.state.tabs[0];
    if (!tab) throw new Error("Expected default tab");
    expect(collectPaneIds(tab.root)).toHaveLength(before + 1);
    expect(tab.root.type).toBe("split");
    if (tab.root.type === "split") expect(tab.root.direction).toBe("horizontal");
  });
});
