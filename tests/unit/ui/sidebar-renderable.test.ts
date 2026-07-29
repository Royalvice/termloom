import { afterEach, describe, expect, test } from "bun:test";
import {
  InputRenderableEvents,
  type InputRenderable,
  type KeyEvent,
  type SelectRenderable,
} from "@opentui/core";
import {
  createMockMouse,
  createTestRenderer,
  MouseButtons,
  type TestRendererSetup,
} from "@opentui/core/testing";
import { defaultConfig, type TermLoomConfig } from "../../../src/config/schema.js";
import { I18n } from "../../../src/i18n/i18n.js";
import { HostCatalog, type HostProfile } from "../../../src/ssh/host-catalog.js";
import type { ContextMenuRequest } from "../../../src/ui/dismissible-overlay-controller.js";
import { SidebarRenderable } from "../../../src/ui/sidebar-renderable.js";

let setup: TestRendererSetup | undefined;
let sidebar: SidebarRenderable | undefined;

afterEach(() => {
  sidebar?.destroyRecursively();
  setup?.renderer.destroy();
  sidebar = undefined;
  setup = undefined;
});

describe("file endpoint sidebar", () => {
  test("always places Local first and contains no tmux session or loading rows", async () => {
    await createSidebar();
    await waitForReady();
    const list = requiredList();

    expect(list.options.map((option) => option.name)).toEqual([
      "● Local",
      "○ Fixture host",
      "○ Second host",
    ]);
    const frame = requiredSetup().captureCharFrame();
    expect(frame).toContain("This Mac");
    expect(frame).not.toContain("Loading tmux sessions");
    expect(frame).not.toContain("work ·");
    expect(sidebar?.findDescendantById("sidebar-fixture-sessions")).toBeUndefined();
  });

  test("opens Local and SSH Files with a single click and makes no tmux request", async () => {
    const opened: string[] = [];
    await createSidebar({
      onLocal: () => opened.push("local"),
      onHost: (profile) => opened.push(`ssh:${profile.id}`),
    });
    await waitForReady();
    const list = requiredList();
    const mouse = createMockMouse(requiredSetup().renderer);

    await mouse.click(list.screenX + 2, list.screenY);
    await mouse.click(list.screenX + 2, list.screenY + 2);

    expect(opened).toEqual(["local", "ssh:fixture"]);
  });

  test("filters SSH hosts without ever hiding Local", async () => {
    await createSidebar();
    await waitForReady();
    const search = requiredDescendant("sidebar-fixture-search") as InputRenderable;
    search.value = "no-such-host";
    search.emit(InputRenderableEvents.INPUT, search.value);
    await requiredSetup().renderOnce();

    expect(requiredList().options.map((option) => option.name)).toEqual(["● Local"]);
    expect(requiredSetup().captureCharFrame()).toContain("Local");

    search.value = "second";
    search.emit(InputRenderableEvents.INPUT, search.value);
    await requiredSetup().renderOnce();
    expect(requiredList().options.map((option) => option.name)).toEqual([
      "● Local",
      "○ Second host",
    ]);
  });

  test("routes Local and Host right-click actions to the root overlay controller", async () => {
    const requests: ContextMenuRequest[] = [];
    await createSidebar({ onContextMenu: (request) => requests.push(request) });
    await waitForReady();
    const list = requiredList();
    const mouse = createMockMouse(requiredSetup().renderer);

    await mouse.click(list.screenX + 2, list.screenY, MouseButtons.RIGHT);
    await mouse.click(list.screenX + 2, list.screenY + 2, MouseButtons.RIGHT);

    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({ title: "Local", x: list.screenX + 2, y: list.screenY });
    expect(requests[0]?.actions.map((action) => action.label)).toEqual(["Open Local Files"]);
    expect(requests[1]?.title).toBe("Fixture host");
    expect(requests[1]?.actions.map((action) => action.label)).toEqual([
      "Open Files",
      "Edit Label and Defaults…",
      "Remove Alias…",
    ]);
    expect(
      requests.flatMap((request) => request.actions).some((action) => /tmux/i.test(action.label)),
    ).toBe(false);
  });

  test("adds a wildcard-only alias from the compact plus button", async () => {
    const saved: TermLoomConfig[] = [];
    await createSidebar({
      save: async (config) => {
        saved.push(structuredClone(config));
        return config;
      },
    });
    await waitForReady();
    const add = requiredDescendant("sidebar-fixture-add");
    await createMockMouse(requiredSetup().renderer).click(add.screenX + 1, add.screenY);
    const input = await waitForInput();
    input.value = "dynamic-gpu";
    input.submit();

    await requiredSetup().waitFor(() => saved.length === 1);
    await requiredSetup().waitFor(
      () => !sidebar?.findDescendantById("sidebar-fixture-modal-input"),
    );
    await requiredSetup().waitForFrame((frame) => frame.includes("dynamic-gpu"));
    expect(saved[0]?.hosts).toContainEqual({
      id: expect.stringMatching(/^ssh-[a-f0-9]{20}$/),
      alias: "dynamic-gpu",
      defaultPath: ".",
      hidden: false,
      source: "manual",
    });
  });

  test("edits host label and defaults in one form opened from the root context action", async () => {
    const saved: TermLoomConfig[] = [];
    let request: ContextMenuRequest | undefined;
    await createSidebar({
      save: async (config) => {
        saved.push(structuredClone(config));
        return config;
      },
      onContextMenu: (value) => {
        request = value;
      },
    });
    await waitForReady();
    const list = requiredList();
    await createMockMouse(requiredSetup().renderer).click(
      list.screenX + 2,
      list.screenY + 2,
      MouseButtons.RIGHT,
    );
    request?.actions.find((action) => action.id === "edit")?.run();
    await requiredSetup().waitFor(() =>
      Boolean(sidebar?.findDescendantById("sidebar-fixture-host-form-label")),
    );

    const label = requiredDescendant("sidebar-fixture-host-form-label") as InputRenderable;
    const path = requiredDescendant("sidebar-fixture-host-form-path") as InputRenderable;
    const session = requiredDescendant("sidebar-fixture-host-form-session") as InputRenderable;
    label.value = "Build server";
    path.value = "/srv/build";
    session.value = "daily";
    await requiredSetup().renderOnce();
    const save = requiredDescendant("sidebar-fixture-host-form-save");
    await createMockMouse(requiredSetup().renderer).click(save.screenX + 1, save.screenY);

    await requiredSetup().waitFor(() => saved.length === 1);
    await requiredSetup().waitFor(() => !sidebar?.findDescendantById("sidebar-fixture-host-form"));
    expect(saved[0]?.hosts.find((host) => host.id === "fixture")).toMatchObject({
      label: "Build server",
      defaultPath: "/srv/build",
      defaultTmuxSession: "daily",
    });
  });

  test("supports keyboard selection while keeping Local as the default target", async () => {
    const opened: string[] = [];
    await createSidebar({
      onLocal: () => opened.push("local"),
      onHost: (profile) => opened.push(profile.id),
    });
    await waitForReady();
    expect(requiredList().getSelectedIndex()).toBe(0);

    sidebar?.handleKeyPress(key("return"));
    sidebar?.handleKeyPress(key("down"));
    sidebar?.handleKeyPress(key("return"));
    expect(opened).toEqual(["local", "fixture"]);
  });
});

async function createSidebar(
  callbacks: {
    onLocal?: () => void;
    onHost?: (profile: HostProfile) => void;
    onContextMenu?: (request: ContextMenuRequest) => void;
    save?: (config: TermLoomConfig) => Promise<TermLoomConfig>;
  } = {},
): Promise<void> {
  const config = defaultConfig();
  config.hosts.push(
    {
      id: "fixture",
      alias: "fixture-alias",
      label: "Fixture host",
      defaultPath: "/workspace",
      source: "manual",
    },
    {
      id: "second",
      alias: "second-alias",
      label: "Second host",
      defaultPath: ".",
      source: "manual",
    },
  );
  const catalog = await HostCatalog.create(config, {
    rootConfigPath: `/tmp/termloom-sidebar-${crypto.randomUUID()}/config`,
  });
  setup = await createTestRenderer({ width: 60, height: 24 });
  sidebar = new SidebarRenderable(setup.renderer, {
    id: "sidebar-fixture",
    config,
    catalog,
    i18n: new I18n("en"),
    saveConfig: callbacks.save,
    onSelectLocal: callbacks.onLocal,
    onSelectHost: callbacks.onHost,
    onContextMenu: (request) => callbacks.onContextMenu?.(request),
  });
  setup.renderer.root.add(sidebar);
  sidebar.focus();
}

async function waitForReady(): Promise<void> {
  await requiredSetup().waitForFrame(
    (frame) => frame.includes("Fixture host") && frame.includes("This Mac"),
  );
}

function requiredSetup(): TestRendererSetup {
  if (!setup) throw new Error("Expected test renderer");
  return setup;
}

function requiredList(): SelectRenderable {
  return requiredDescendant("sidebar-fixture-list") as SelectRenderable;
}

function requiredDescendant(id: string) {
  const descendant = sidebar?.findDescendantById(id);
  if (!descendant) throw new Error(`Expected ${id}`);
  return descendant;
}

async function waitForInput(): Promise<InputRenderable> {
  await requiredSetup().waitFor(() =>
    Boolean(sidebar?.findDescendantById("sidebar-fixture-modal-input")),
  );
  return requiredDescendant("sidebar-fixture-modal-input") as InputRenderable;
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
