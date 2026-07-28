import { afterEach, describe, expect, test } from "bun:test";
import {
  type InputRenderable,
  type KeyEvent,
  type Renderable,
  type SelectRenderable,
  TextRenderable,
} from "@opentui/core";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { defaultConfig } from "../../../src/config/schema.js";
import { I18n } from "../../../src/i18n/i18n.js";
import { TransferQueue } from "../../../src/sftp/transfer-queue.js";
import type { PaneViewFactory } from "../../../src/ui/pane-factory.js";
import { SettingsRenderable } from "../../../src/ui/settings-renderable.js";
import type { SidebarRenderable } from "../../../src/ui/sidebar-renderable.js";
import { WorkspaceApp, type WorkspaceAppServices } from "../../../src/ui/workspace-app.js";
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

async function renderWorkspace(
  width: number,
  height: number,
  options: { config?: ReturnType<typeof defaultConfig>; services?: WorkspaceAppServices } = {},
) {
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
  app = new WorkspaceApp(
    setup.renderer,
    options.config ?? defaultConfig(),
    new I18n("en"),
    controller,
    factory,
    options.services,
  );
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

  test("adds and closes tabs, resizes the active split, and exchanges panes", async () => {
    const { controller, persistence } = await renderWorkspace(110, 35);
    leader("a");
    await controller.flush();
    expect(controller.state.tabs).toHaveLength(2);
    const createdTab = controller.state.activeTabId;
    leader(",");
    await controller.flush();
    expect(controller.state.activeTabId).not.toBe(createdTab);
    leader(".");
    await controller.flush();
    expect(controller.state.activeTabId).toBe(createdTab);

    leader("s");
    await controller.flush();
    let tab = activeWorkspaceTab(controller.state);
    expect(tab.root.type).toBe("split");
    if (tab.root.type !== "split") throw new Error("Expected split root");
    const originalOrder = collectPaneIds(tab.root);
    const originalRatio = tab.root.ratio;

    leader("]");
    await controller.flush();
    tab = activeWorkspaceTab(controller.state);
    if (tab.root.type !== "split") throw new Error("Expected split root");
    expect(tab.root.ratio).toBeLessThan(originalRatio);

    leader("e");
    await controller.flush();
    tab = activeWorkspaceTab(controller.state);
    expect(collectPaneIds(tab.root)).toEqual([...originalOrder].reverse());

    leader("w");
    await controller.flush();
    expect(controller.state.tabs).toHaveLength(1);
    expect(controller.state.tabs.some((candidate) => candidate.id === createdTab)).toBe(false);
    expect(persistence.saved.at(-1)?.tabs).toHaveLength(1);
  });

  test("opens live sidebar entries plus settings and transfer overlays through the keymap", async () => {
    const config = defaultConfig();
    config.hosts.push({
      id: "demo",
      alias: "demo-ssh",
      label: "Demo host",
      defaultPath: "/srv/project",
      defaultTmuxSession: "main",
    });
    const queue = new TransferQueue(1);
    const saved: ReturnType<typeof defaultConfig>[] = [];
    const { controller } = await renderWorkspace(120, 40, {
      config,
      services: {
        transferQueue: queue,
        saveConfig: async (next) => {
          saved.push(structuredClone(next));
          return next;
        },
      },
    });

    leader("1");
    const sidebar = app?.root.findDescendantById("sidebar-content") as SidebarRenderable;
    sidebar.handleKeyPress(key("return"));
    await controller.flush();
    const remotePane = Object.values(controller.state.panes).find(
      (pane) => pane.kind === "terminal" && pane.hostId === "demo",
    );
    expect(remotePane).toMatchObject({ tmuxSession: "main" });

    leader("g");
    const settings = app?.root.findDescendantById("settings-modal") as SettingsRenderable;
    expect(settings).toBeInstanceOf(SettingsRenderable);
    const settingsList = settings.findDescendantById("settings-modal-list") as SelectRenderable;
    settingsList.setSelectedIndex(2);
    settings.handleKeyPress(key("return"));
    const input = settings.findDescendantById("settings-modal-input") as InputRenderable;
    input.value = "36";
    input.submit();
    await setup?.waitFor(() => saved.length === 1);
    expect(controller.state.sidebar.width).toBe(36);
    settings.handleKeyPress(key("escape"));

    leader("t");
    expect(app?.root.findDescendantById("transfer-modal")).toBeDefined();
  });
});

function leader(keyName: string): void {
  setup?.mockInput.pressKey(" ", { ctrl: true });
  setup?.mockInput.pressKey(keyName);
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

function activeWorkspaceTab(state: WorkspaceSnapshot) {
  const tab = state.tabs.find((candidate) => candidate.id === state.activeTabId);
  if (!tab) throw new Error("Expected active tab");
  return tab;
}
