import { afterEach, describe, expect, test } from "bun:test";
import type {
  InputRenderable,
  KeyEvent,
  ScrollBoxRenderable,
  SelectRenderable,
  TextRenderable,
} from "@opentui/core";
import {
  createMockMouse,
  createTestRenderer,
  MouseButtons,
  type TestRendererSetup,
} from "@opentui/core/testing";
import { defaultConfig, type TermLoomConfig } from "../../../src/config/schema.js";
import { I18n } from "../../../src/i18n/i18n.js";
import { HostCatalog } from "../../../src/ssh/host-catalog.js";
import type { TmuxSessionInfo } from "../../../src/tmux/tmux-service.js";
import {
  SidebarRenderable,
  type SidebarSessionService,
} from "../../../src/ui/sidebar-renderable.js";

let setup: TestRendererSetup | undefined;
let sidebar: SidebarRenderable | undefined;

afterEach(() => {
  sidebar?.destroyRecursively();
  setup?.renderer.destroy();
  sidebar = undefined;
  setup = undefined;
});

class FakeSessions implements SidebarSessionService {
  public sessions: TmuxSessionInfo[] = [session("work", 2)];
  public readonly operations: string[] = [];
  public nextListGate: Promise<void> | undefined;

  public async list(hostId: string): Promise<readonly TmuxSessionInfo[]> {
    this.operations.push(`list:${hostId}`);
    const gate = this.nextListGate;
    this.nextListGate = undefined;
    await gate;
    return this.sessions;
  }

  public async create(hostId: string, name: string, cwd?: string): Promise<void> {
    this.operations.push(`create:${hostId}:${name}:${cwd}`);
    this.sessions.push(session(name, 1));
  }

  public async rename(hostId: string, currentName: string, nextName: string): Promise<void> {
    this.operations.push(`rename:${hostId}:${currentName}:${nextName}`);
    const value = this.sessions.find((candidate) => candidate.name === currentName);
    if (value) value.name = nextName;
  }

  public async kill(hostId: string, name: string): Promise<void> {
    this.operations.push(`kill:${hostId}:${name}`);
    this.sessions = this.sessions.filter((candidate) => candidate.name !== name);
  }
}

describe("unified Host tree", () => {
  test("selects a Host, auto-loads sessions, attaches, creates, renames, and confirms kill", async () => {
    const sessions = new FakeSessions();
    const opened: string[] = [];
    await createSidebar(sessions, {
      onHost: (hostId) => opened.push(`files:${hostId}`),
      onSession: (hostId, name) => opened.push(`terminal:${hostId}:${name}`),
    });
    await setup?.waitForFrame((frame) => frame.includes("Fixture host"));

    sidebar?.handleKeyPress(key("return"));
    await setup?.waitForFrame((frame) => frame.includes("work"));
    expect(opened).toContain("files:fixture");
    expect(sessions.operations).toContain("list:fixture");

    sidebar?.handleKeyPress(key("down"));
    sidebar?.handleKeyPress(key("return"));
    expect(opened).toContain("terminal:fixture:work");

    sidebar?.handleKeyPress(key("n"));
    const create = await waitForInput();
    create.value = "research";
    create.submit();
    await setup?.waitFor(() => sessions.operations.includes("create:fixture:research:/workspace"));
    await setup?.waitForFrame((frame) => frame.includes("research"));

    sidebar?.handleKeyPress(key("down"));
    sidebar?.handleKeyPress(key("down"));
    sidebar?.handleKeyPress(key("r", true));
    const rename = await waitForInput();
    rename.value = "research-2";
    rename.submit();
    await setup?.waitFor(() => sessions.operations.includes("rename:fixture:research:research-2"));

    sidebar?.handleKeyPress(key("down"));
    sidebar?.handleKeyPress(key("down"));
    sidebar?.handleKeyPress(key("d"));
    const confirmation = await waitForInput();
    confirmation.value = "DELETE";
    confirmation.submit();
    await setup?.waitFor(() => sessions.operations.includes("kill:fixture:research-2"));
  });

  test("adds a wildcard-only OpenSSH alias with one prompt and supports mouse controls", async () => {
    const saved: TermLoomConfig[] = [];
    await createSidebar(new FakeSessions(), {
      save: async (config) => {
        saved.push(structuredClone(config));
        return config;
      },
    });
    await setup?.renderOnce();
    const add = sidebar?.findDescendantById("sidebar-fixture-add") as TextRenderable | undefined;
    if (!add || !setup) throw new Error("Expected Add Alias button");
    const mouse = createMockMouse(setup.renderer);
    await mouse.click(add.screenX + 1, add.screenY);
    const input = await waitForInput();
    input.value = "dynamic-gpu";
    input.submit();

    await setup.waitFor(() => saved.length === 1);
    expect(saved[0]?.hosts).toContainEqual({
      id: expect.stringMatching(/^ssh-[a-f0-9]{20}$/),
      alias: "dynamic-gpu",
      defaultPath: ".",
      hidden: false,
      source: "manual",
    });
    await Bun.sleep(50);
    await setup.waitForFrame((frame) => frame.includes("dynamic-gpu"));
  });

  test("edits Host label, default path, and default session in one mouse-driven form", async () => {
    const saved: TermLoomConfig[] = [];
    await createSidebar(new FakeSessions(), {
      save: async (config) => {
        saved.push(structuredClone(config));
        return config;
      },
    });
    await setup?.renderOnce();
    const list = sidebar?.findDescendantById("sidebar-fixture-list");
    if (!list || !setup) throw new Error("Expected Host list");
    const mouse = createMockMouse(setup.renderer);
    await mouse.click(list.screenX + 2, list.screenY, MouseButtons.RIGHT);
    await setup.waitFor(() => Boolean(sidebar?.findDescendantById("sidebar-fixture-context-list")));
    const context = sidebar?.findDescendantById("sidebar-fixture-context-list");
    if (!context) throw new Error("Expected Host context menu");
    await mouse.click(context.screenX + 2, context.screenY + 1);
    await setup.waitFor(() =>
      Boolean(sidebar?.findDescendantById("sidebar-fixture-host-form-label")),
    );
    const label = sidebar?.findDescendantById("sidebar-fixture-host-form-label") as InputRenderable;
    const path = sidebar?.findDescendantById("sidebar-fixture-host-form-path") as InputRenderable;
    const sessionInput = sidebar?.findDescendantById(
      "sidebar-fixture-host-form-session",
    ) as InputRenderable;
    label.value = "Build server";
    path.value = "/srv/build";
    sessionInput.value = "daily";
    await setup.renderOnce();
    const save = sidebar?.findDescendantById("sidebar-fixture-host-form-save");
    if (!save) throw new Error("Expected Host form Save button");
    await mouse.click(save.screenX + 1, save.screenY);
    await setup.waitFor(() => saved.length === 1);
    expect(saved[0]?.hosts[0]).toMatchObject({
      id: "fixture",
      label: "Build server",
      defaultPath: "/srv/build",
      defaultTmuxSession: "daily",
    });
  });

  test("uses single-click selection, double-click activation, an explicit Open button, and a scrollable narrow toolbar", async () => {
    const opened: string[] = [];
    const sessions = new FakeSessions();
    await createSidebar(sessions, {
      width: 24,
      onHost: (hostId) => opened.push(hostId),
      onSession: (hostId, sessionName) => opened.push(`${hostId}:${sessionName}`),
    });
    if (!setup || !sidebar) throw new Error("Expected Host tree");
    await setup.waitForFrame((frame) => frame.includes("Fixture host"));
    const mouse = createMockMouse(setup.renderer);
    const list = sidebar.findDescendantById("sidebar-fixture-list");
    if (!list) throw new Error("Expected Host list");

    await mouse.click(list.screenX + 2, list.screenY);
    expect(opened).toEqual([]);

    const open = sidebar.findDescendantById("sidebar-fixture-open");
    if (!open) throw new Error("Expected Open button");
    await mouse.click(open.screenX + 1, open.screenY);
    await setup.waitFor(() => opened.length === 1);
    expect(opened).toEqual(["fixture"]);

    await Bun.sleep(420);
    await mouse.doubleClick(list.screenX + 2, list.screenY);
    await setup.waitFor(() => opened.length === 2);
    expect(opened).toEqual(["fixture", "fixture"]);

    await setup.waitForFrame((frame) => frame.includes("work"));
    await Bun.sleep(420);
    const hostTree = list as SelectRenderable;
    hostTree.setSelectedIndex(1);
    await setup.renderOnce();
    await mouse.doubleClick(hostTree.screenX + 2, hostTree.screenY + 2);
    await setup.waitFor(() => opened.includes("fixture:work"));

    let releaseRefresh = () => {};
    sessions.nextListGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const refreshing = sidebar.syncActiveHost("fixture", true);
    await setup.renderOnce();
    expect(hostTree.options.some((entry) => entry.name.includes("work"))).toBe(true);
    expect(hostTree.getSelectedIndex()).toBe(1);
    const attachedBeforeRefreshClick = opened.filter((entry) => entry === "fixture:work").length;
    await Bun.sleep(420);
    await mouse.doubleClick(hostTree.screenX + 2, hostTree.screenY + 2);
    await setup.waitFor(
      () => opened.filter((entry) => entry === "fixture:work").length > attachedBeforeRefreshClick,
    );
    releaseRefresh();
    await refreshing;

    const toolbar = sidebar.findDescendantById("sidebar-fixture-toolbar") as ScrollBoxRenderable;
    const before = toolbar.scrollLeft;
    await mouse.scroll(toolbar.screenX + 1, toolbar.screenY, "right");
    await setup.renderOnce();
    expect(toolbar.scrollLeft).toBeGreaterThan(before);
  });

  test("keeps the Host metadata form open and shows asynchronous save failures", async () => {
    await createSidebar(new FakeSessions(), {
      save: async () => {
        throw new Error("fixture write failed");
      },
    });
    if (!setup || !sidebar) throw new Error("Expected Host tree");
    await setup.renderOnce();
    const list = sidebar.findDescendantById("sidebar-fixture-list");
    if (!list) throw new Error("Expected Host list");
    const mouse = createMockMouse(setup.renderer);
    await mouse.click(list.screenX + 2, list.screenY, MouseButtons.RIGHT);
    await setup.waitFor(() => Boolean(sidebar?.findDescendantById("sidebar-fixture-context-list")));
    const context = sidebar.findDescendantById("sidebar-fixture-context-list");
    if (!context) throw new Error("Expected Host context menu");
    await mouse.click(context.screenX + 2, context.screenY + 1);
    await setup.waitFor(() => Boolean(sidebar?.findDescendantById("sidebar-fixture-host-form")));
    const save = sidebar.findDescendantById("sidebar-fixture-host-form-save");
    if (!save) throw new Error("Expected Host form Save button");
    await mouse.click(save.screenX + 1, save.screenY);
    await setup.waitForFrame((frame) => frame.includes("fixture write failed"));
    expect(sidebar.findDescendantById("sidebar-fixture-host-form")).toBeDefined();
  });
});

async function createSidebar(
  sessions: FakeSessions,
  callbacks: {
    onHost?: (hostId: string) => void;
    onSession?: (hostId: string, session: string) => void;
    save?: (config: TermLoomConfig) => Promise<TermLoomConfig>;
    width?: number;
  } = {},
): Promise<void> {
  const config = defaultConfig();
  config.hosts.push({
    id: "fixture",
    alias: "fixture-alias",
    label: "Fixture host",
    defaultPath: "/workspace",
    defaultTmuxSession: "main",
    source: "manual",
  });
  const catalog = await HostCatalog.create(config, {
    rootConfigPath: `/tmp/termloom-sidebar-${crypto.randomUUID()}/config`,
  });
  setup = await createTestRenderer({ width: callbacks.width ?? 60, height: 24 });
  sidebar = new SidebarRenderable(setup.renderer, {
    id: "sidebar-fixture",
    config,
    catalog,
    i18n: new I18n("en"),
    sessions,
    saveConfig: callbacks.save,
    onSelectHost: (profile) => callbacks.onHost?.(profile.id),
    onAttachSession: (profile, value) => callbacks.onSession?.(profile.id, value.name),
  });
  setup.renderer.root.add(sidebar);
  sidebar.focus();
}

async function waitForInput(): Promise<InputRenderable> {
  await setup?.waitFor(() => Boolean(sidebar?.findDescendantById("sidebar-fixture-modal-input")));
  const input = sidebar?.findDescendantById("sidebar-fixture-modal-input");
  if (!input || !("submit" in input)) throw new Error("Expected sidebar modal input");
  return input as InputRenderable;
}

function key(name: string, shift = false): KeyEvent {
  return {
    name,
    sequence: name,
    raw: name,
    eventType: "press",
    ctrl: false,
    meta: false,
    shift,
    super: false,
    hyper: false,
    option: false,
    number: false,
  } as unknown as KeyEvent;
}

function session(name: string, windows: number): TmuxSessionInfo {
  return {
    name,
    attachedClients: 0,
    windows,
    createdAt: new Date("2026-07-28T00:00:00.000Z"),
  };
}
