import { afterEach, describe, expect, test } from "bun:test";
import {
  CliRenderEvents,
  type InputRenderable,
  type KeyEvent,
  type Renderable,
  type SelectRenderable,
  TextRenderable,
} from "@opentui/core";
import { createMockMouse, createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { defaultConfig } from "../../../src/config/schema.js";
import { I18n } from "../../../src/i18n/i18n.js";
import { TransferQueue } from "../../../src/sftp/transfer-queue.js";
import { HostCatalog } from "../../../src/ssh/host-catalog.js";
import type {
  HostConnectionEvent,
  HostConnectionListener,
} from "../../../src/ssh/connection-coordinator.js";
import type { HostConnectionCoordinator } from "../../../src/ssh/connection-coordinator.js";
import { MemoryTerminalBackend } from "../../../src/terminal/backend.js";
import type { PtyBackend } from "../../../src/terminal/pty-backend.js";
import { TerminalRenderable } from "../../../src/terminal/terminal-renderable.js";
import type { TmuxSessionInfo } from "../../../src/tmux/tmux-service.js";
import type { PaneViewFactory } from "../../../src/ui/pane-factory.js";
import { SettingsRenderable } from "../../../src/ui/settings-renderable.js";
import { currentTheme } from "../../../src/ui/theme.js";
import type {
  SidebarRenderable,
  SidebarSessionService,
} from "../../../src/ui/sidebar-renderable.js";
import { WorkspaceApp, type WorkspaceAppServices } from "../../../src/ui/workspace-app.js";
import { WorkspaceController } from "../../../src/workspace/controller.js";
import { activeSurface, activeTab, collectPaneIds } from "../../../src/workspace/reducer.js";
import {
  createDefaultWorkspace,
  createHostWorkspaceTab,
  type PaneState,
  type WorkspaceSnapshot,
} from "../../../src/workspace/schema.js";

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

class FakeSessions implements SidebarSessionService {
  public readonly value: TmuxSessionInfo = {
    name: "work",
    attachedClients: 0,
    windows: 2,
    createdAt: new Date("2026-07-28T00:00:00.000Z"),
  };
  public readonly operations: string[] = [];

  public async list(hostId: string): Promise<readonly TmuxSessionInfo[]> {
    this.operations.push(`list:${hostId}`);
    return [this.value];
  }
  public async create(): Promise<void> {}
  public async rename(): Promise<void> {}
  public async kill(): Promise<void> {}
}

class FakeConnections {
  public readonly ensureRequests: string[] = [];
  public readonly reconnectRequests: string[] = [];
  public readonly cancelled: string[] = [];
  private readonly listeners = new Set<HostConnectionListener>();

  public onChange(listener: HostConnectionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public async ensureConnected(hostId: string): Promise<void> {
    this.ensureRequests.push(hostId);
  }

  public async reconnect(hostId: string): Promise<void> {
    this.reconnectRequests.push(hostId);
  }

  public cancel(hostId: string): void {
    this.cancelled.push(hostId);
  }

  public emit(event: HostConnectionEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  public service(): HostConnectionCoordinator {
    return this as unknown as HostConnectionCoordinator;
  }
}

class RefreshProbeRenderable extends TextRenderable {
  public refreshes = 0;

  public async refresh(): Promise<void> {
    this.refreshes += 1;
  }
}

async function renderWorkspace(
  width: number,
  height: number,
  options: {
    config?: ReturnType<typeof defaultConfig>;
    services?: Partial<WorkspaceAppServices>;
    factory?: (renderer: TestRendererSetup["renderer"]) => PaneViewFactory;
    state?: WorkspaceSnapshot;
  } = {},
) {
  setup = await createTestRenderer({ width, height });
  const state = options.state ?? splitFixture();
  const persistence = new MemoryPersistence();
  const controller = new WorkspaceController(state, persistence);
  const config = options.config ?? defaultConfig();
  const catalog = await HostCatalog.create(config, {
    rootConfigPath: `/tmp/termloom-workspace-${crypto.randomUUID()}/config`,
  });
  const activeSetup = setup;
  const factory: PaneViewFactory = options.factory
    ? options.factory(activeSetup.renderer)
    : {
        create: (pane): Renderable =>
          new TextRenderable(activeSetup.renderer, {
            id: `fixture-${pane.id}`,
            content: `fixture:${pane.kind}:${pane.title}`,
          }),
      };
  app = new WorkspaceApp(setup.renderer, config, new I18n("en"), controller, factory, {
    catalog,
    ...options.services,
  });
  await setup.renderOnce();
  return { frame: setup.captureCharFrame(), controller, persistence, catalog };
}

describe("WorkspaceApp", () => {
  for (const [width, height] of [
    [80, 24],
    [120, 40],
    [200, 60],
  ] as const) {
    test(`matches the ${width}x${height} dual-surface split snapshot`, async () => {
      const { frame } = await renderWorkspace(width, height);
      expect(frame).toMatchSnapshot();
    });
  }

  test("rebuilds the active surface layout and persists focus independently", async () => {
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
    expect(persistence.saved.at(-1)?.tabs[0]?.surfaces.files.activePaneId).toBe("preview-1");
    expect(persistence.saved.at(-1)?.tabs[0]?.surfaces.terminal.activePaneId).toBe(
      "pane-terminal-start-1",
    );
  });

  test("uses Ctrl+G leader, F2 dual-surface switching, and leaves Ctrl+Space for the PTY", async () => {
    const state = createDefaultWorkspace();
    const initialTab = state.tabs[0];
    if (!initialTab) throw new Error("Expected default tab");
    initialTab.activeSurface = "terminal";
    state.panes["pane-terminal-start-1"] = {
      id: "pane-terminal-start-1",
      kind: "terminal",
      title: "Local shell",
    };
    const backend = new MemoryTerminalBackend();
    let terminal: TerminalRenderable | undefined;
    const { controller } = await renderWorkspace(100, 30, {
      state,
      factory: (renderer) => ({
        create: (pane) => {
          if (pane.kind === "terminal") {
            terminal = new TerminalRenderable(renderer, {
              id: `terminal-${pane.id}`,
              backend,
              width: "100%",
              height: "100%",
            });
            return terminal;
          }
          return new TextRenderable(renderer, { content: pane.title });
        },
      }),
    });

    setup?.mockInput.pressKey(" ", { ctrl: true });
    expect(backend.written).toContain("\u0000");
    setup?.mockInput.pressKey("g", { ctrl: true });
    setup?.mockInput.pressKey("g", { ctrl: true });
    expect(backend.written).toContain("\u0007");
    setup?.mockInput.pressKey("g", { ctrl: true });
    setup?.mockInput.pressKey("F2");
    expect(backend.written).toContain("\u001bOQ");

    setup?.mockInput.pressKey("F2");
    await controller.flush();
    expect(activeTab(controller.state).activeSurface).toBe("files");
    expect(backend.closed).toBe(false);
    if (!terminal) throw new Error("Expected terminal renderable");
    const terminalView = terminal;
    const parsedWhileHidden = new Promise<void>((resolve) => {
      const disposable = terminalView.terminal.onWriteParsed(() => {
        disposable.dispose();
        resolve();
      });
    });
    backend.emitData("task-finished-while-hidden\r\n");
    await parsedWhileHidden;
    setup?.mockInput.pressKey("F2");
    await controller.flush();
    expect(activeTab(controller.state).activeSurface).toBe("terminal");
    await setup?.waitForFrame((frame) => frame.includes("task-finished-while-hidden"));
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
    let surface = activeSurface(activeTab(controller.state));
    expect(surface.root.type).toBe("split");
    if (surface.root.type !== "split") throw new Error("Expected split root");
    const originalOrder = collectPaneIds(surface.root);
    const originalRatio = surface.root.ratio;

    leader("]");
    await controller.flush();
    surface = activeSurface(activeTab(controller.state));
    if (surface.root.type !== "split") throw new Error("Expected split root");
    expect(surface.root.ratio).toBeLessThan(originalRatio);

    leader("e");
    await controller.flush();
    surface = activeSurface(activeTab(controller.state));
    expect(collectPaneIds(surface.root)).toEqual([...originalOrder].reverse());

    leader("w");
    await controller.flush();
    expect(controller.state.tabs).toHaveLength(1);
    expect(controller.state.tabs.some((candidate) => candidate.id === createdTab)).toBe(false);
    expect(persistence.saved.at(-1)?.tabs).toHaveLength(1);
  });

  test("supports mouse sidebar toggling plus sidebar and split-divider dragging", async () => {
    const { controller } = await renderWorkspace(120, 40);
    if (!setup || !app) throw new Error("Expected workspace");
    const mouse = createMockMouse(setup.renderer);
    const toggle = app.root.findDescendantById("sidebar-toggle-button");
    if (!toggle) throw new Error("Expected Host tree toggle");
    await mouse.click(toggle.screenX + 1, toggle.screenY);
    await controller.flush();
    expect(controller.state.sidebar.visible).toBe(false);
    await mouse.click(toggle.screenX + 1, toggle.screenY);
    await controller.flush();
    expect(controller.state.sidebar.visible).toBe(true);

    await setup.renderOnce();
    const sidebarDivider = app.root.findDescendantById("sidebar-divider");
    if (!sidebarDivider) throw new Error("Expected sidebar divider");
    const originalWidth = controller.state.sidebar.width;
    await mouse.drag(
      sidebarDivider.screenX,
      sidebarDivider.screenY + 2,
      sidebarDivider.screenX + 6,
      sidebarDivider.screenY + 2,
    );
    await controller.flush();
    expect(controller.state.sidebar.width).toBeGreaterThan(originalWidth);

    await setup.renderOnce();
    const splitDivider = app.root.findDescendantById("layout-split-fixture-divider");
    if (!splitDivider) throw new Error("Expected split divider");
    const before = activeTab(controller.state).surfaces.files.root;
    if (before.type !== "split") throw new Error("Expected split root");
    await mouse.drag(
      splitDivider.screenX,
      splitDivider.screenY + 2,
      splitDivider.screenX + 8,
      splitDivider.screenY + 2,
    );
    await controller.flush();
    const after = activeTab(controller.state).surfaces.files.root;
    if (after.type !== "split") throw new Error("Expected split root");
    expect(after.ratio).not.toBe(before.ratio);
    expect(after.ratio).toBeGreaterThanOrEqual(0.1);
    expect(after.ratio).toBeLessThanOrEqual(0.9);
  });

  test("opens a Host in Files, attaches a discovered session, and exposes clickable surfaces", async () => {
    const config = defaultConfig();
    config.hosts.push({
      id: "demo",
      alias: "demo-ssh",
      label: "Demo host",
      defaultPath: "/srv/project",
      defaultTmuxSession: "main",
      source: "manual",
    });
    const sessions = new FakeSessions();
    const { controller } = await renderWorkspace(120, 40, {
      config,
      services: { sessions },
    });
    const sidebar = app?.root.findDescendantById("sidebar-content") as
      | SidebarRenderable
      | undefined;
    if (!sidebar) throw new Error("Expected Host tree");
    sidebar.handleKeyPress(key("return"));
    await Bun.sleep(20);
    await controller.flush();
    expect(activeTab(controller.state)).toMatchObject({ hostId: "demo", activeSurface: "files" });

    sidebar.handleKeyPress(key("down"));
    sidebar.handleKeyPress(key("return"));
    await controller.flush();
    expect(activeTab(controller.state).activeSurface).toBe("terminal");
    const terminalPane = Object.values(controller.state.panes).find(
      (pane) => pane.kind === "terminal" && pane.hostId === "demo",
    );
    expect(terminalPane).toMatchObject({ tmuxSession: "work" });

    await setup?.renderOnce();
    const files = app?.root.findDescendantById("surface-files");
    if (!files || !setup) throw new Error("Expected Files segment");
    await createMockMouse(setup.renderer).click(files.screenX + 1, files.screenY);
    await controller.flush();
    expect(activeTab(controller.state).activeSurface).toBe("files");
  });

  test("opens searchable Help plus Settings and Transfers", async () => {
    const config = defaultConfig();
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

    setup?.mockInput.pressKey("F1");
    expect(app?.root.findDescendantById("command-palette")).toBeDefined();
    setup?.mockInput.pressEscape();
    await Bun.sleep(80);
    expect(app?.root.findDescendantById("command-palette")).toBeUndefined();

    leader("g");
    const settings = app?.root.findDescendantById("settings-modal") as SettingsRenderable;
    expect(settings).toBeInstanceOf(SettingsRenderable);
    const settingsList = settings.findDescendantById("settings-modal-list") as SelectRenderable;
    settingsList.setSelectedIndex(2);
    settings.handleKeyPress(key("return"));
    const input = settings.findDescendantById("settings-modal-input") as InputRenderable;
    input.value = "36";
    input.submit();
    settings.handleKeyPress(key("s", true));
    await setup?.waitFor(() => saved.length === 1);
    expect(controller.state.sidebar.width).toBe(36);
    settings.handleKeyPress(key("escape"));

    leader("t");
    expect(app?.root.findDescendantById("transfer-modal")).toBeDefined();
  });

  test("restores the active Host in the sidebar without probing unselected Hosts", async () => {
    const config = twoHostConfig();
    const sessions = new FakeSessions();
    const connections = new FakeConnections();
    const state = hostWorkspaceState("second", "Second host");

    await renderWorkspace(100, 30, {
      config,
      state,
      services: { sessions, connections: connections.service() },
    });
    await setup?.waitFor(() => sessions.operations.includes("list:second"));

    expect(sessions.operations).not.toContain("list:first");
    expect(connections.ensureRequests).toEqual([]);
    const list = app?.root.findDescendantById("sidebar-content-list") as SelectRenderable;
    expect(list.options[list.getSelectedIndex()]?.name).toContain("Second host");
  });

  test("refreshes only the active Host files and sessions after renderer focus and a timer gap", async () => {
    const config = twoHostConfig();
    const sessions = new FakeSessions();
    const focusedHosts: Array<string | undefined> = [];
    const probes = new Map<string, RefreshProbeRenderable>();
    const state = hostWorkspaceState("second", "Second host");
    const { controller } = await renderWorkspace(100, 30, {
      config,
      state,
      services: {
        sessions,
        onRendererFocus: (hostId) => focusedHosts.push(hostId),
      },
      factory: (renderer) => ({
        create: (pane) => {
          const probe = new RefreshProbeRenderable(renderer, {
            id: `probe-${pane.id}`,
            content: pane.title,
          });
          if (pane.kind === "files" || pane.kind === "session-picker") probes.set(pane.kind, probe);
          return probe;
        },
      }),
    });
    await setup?.waitFor(() => sessions.operations.includes("list:second"));
    setup?.mockInput.pressKey("F2");
    await controller.flush();
    setup?.mockInput.pressKey("F2");
    await controller.flush();
    sessions.operations.length = 0;
    for (const probe of probes.values()) probe.refreshes = 0;

    setup?.renderer.emit(CliRenderEvents.FOCUS);
    await setup?.waitFor(
      () =>
        sessions.operations.includes("list:second") &&
        probes.get("files")?.refreshes === 1 &&
        probes.get("session-picker")?.refreshes === 1,
    );
    expect(focusedHosts).toEqual(["second"]);
    expect(sessions.operations).not.toContain("list:first");

    sessions.operations.length = 0;
    for (const probe of probes.values()) probe.refreshes = 0;
    const now = Date.now();
    app?.checkForResume(now);
    app?.checkForResume(now + 15_001);
    await setup?.waitFor(
      () =>
        sessions.operations.includes("list:second") &&
        probes.get("files")?.refreshes === 1 &&
        probes.get("session-picker")?.refreshes === 1,
    );
    expect(focusedHosts).toEqual(["second", "second"]);
    expect(sessions.operations).not.toContain("list:first");

    sessions.operations.length = 0;
    app?.destroy();
    app?.checkForResume(now + 30_002);
    setup?.renderer.emit(CliRenderEvents.FOCUS);
    await Bun.sleep(20);
    expect(sessions.operations).toEqual([]);
  });

  test("refreshes existing Host surfaces after connection and does not move the sidebar for a background Host", async () => {
    const config = twoHostConfig();
    const sessions = new FakeSessions();
    const connections = new FakeConnections();
    const probes = new Map<string, RefreshProbeRenderable>();
    const state = hostWorkspaceState("second", "Second host");
    const { controller } = await renderWorkspace(100, 30, {
      config,
      state,
      services: { sessions, connections: connections.service() },
      factory: (renderer) => ({
        create: (pane) => {
          const probe = new RefreshProbeRenderable(renderer, {
            id: `probe-${pane.id}`,
            content: pane.title,
          });
          if (pane.kind === "files" || pane.kind === "session-picker") probes.set(pane.kind, probe);
          return probe;
        },
      }),
    });
    await setup?.waitFor(() => sessions.operations.includes("list:second"));
    setup?.mockInput.pressKey("F2");
    await controller.flush();
    setup?.mockInput.pressKey("F2");
    await controller.flush();
    sessions.operations.length = 0;
    for (const probe of probes.values()) probe.refreshes = 0;

    connections.emit({ hostId: "second", status: "connected" });
    await setup?.waitFor(
      () =>
        sessions.operations.includes("list:second") &&
        probes.get("files")?.refreshes === 1 &&
        probes.get("session-picker")?.refreshes === 1,
    );

    sessions.operations.length = 0;
    connections.emit({ hostId: "first", status: "connected" });
    await Bun.sleep(20);
    expect(sessions.operations).toEqual([]);
    const list = app?.root.findDescendantById("sidebar-content-list") as SelectRenderable;
    expect(list.options[list.getSelectedIndex()]?.name).toContain("Second host");
  });

  test("closes embedded SSH authentication immediately when Cancel is clicked", async () => {
    const config = twoHostConfig();
    const connections = new FakeConnections();
    await renderWorkspace(100, 30, {
      config,
      state: hostWorkspaceState("second", "Second host"),
      services: { connections: connections.service() },
    });
    const backend = new MemoryTerminalBackend();
    connections.emit({
      hostId: "second",
      status: "authenticating",
      authenticationBackend: backend as unknown as PtyBackend,
    });
    await setup?.renderOnce();
    const cancel = app?.root.findDescendantById("ssh-authentication-cancel");
    if (!cancel || !setup) throw new Error("Expected SSH authentication Cancel button");
    await createMockMouse(setup.renderer).click(cancel.screenX + 1, cancel.screenY);
    await setup.renderOnce();

    expect(connections.cancelled).toEqual(["second"]);
    expect(app?.root.findDescendantById("ssh-authentication")).toBeUndefined();
  });

  test("lists every global command with shortcuts derived from the configured leader and quick switch", async () => {
    const config = defaultConfig();
    config.ui.leader = "ctrl+x";
    config.ui.quickSwitch = "f3";
    await renderWorkspace(120, 40, { config });

    setup?.mockInput.pressKey("F1");
    const list = app?.root.findDescendantById("command-palette-list") as SelectRenderable;
    expect(list.options).toHaveLength(20);
    const commands = list.options.map((option) => `${option.name}:${option.description}`);
    expect(commands).toContain("Switch Files / Terminal:F3");
    expect(commands).toContain("Split horizontally:Ctrl+X S");
    expect(commands).toContain("Send the leader key to the terminal:Ctrl+X Ctrl+X");
    expect(commands.map((value) => value.split(":")[0])).toEqual(
      expect.arrayContaining([
        "Close active pane",
        "Focus next pane",
        "Focus previous pane",
        "Open Local shell",
        "Close active tab",
        "Activate next tab",
        "Activate previous tab",
        "Grow active pane",
        "Shrink active pane",
        "Exchange active pane",
        "Show or hide Host tree",
        "Settings",
        "Transfers",
        "Send F2 to the terminal",
        "Quit safely",
      ]),
    );
  });

  test("applies locale, theme, and reconnect settings to the running workspace", async () => {
    const applied: Array<{
      previous: ReturnType<typeof defaultConfig>;
      next: ReturnType<typeof defaultConfig>;
    }> = [];
    await renderWorkspace(120, 40, {
      services: {
        saveConfig: async (next) => structuredClone(next),
        applyRuntimeConfig: async (previous, next) => {
          applied.push({ previous: structuredClone(previous), next: structuredClone(next) });
          return undefined;
        },
      },
    });
    leader("g");
    const settings = app?.root.findDescendantById("settings-modal") as SettingsRenderable;
    const list = settings.findDescendantById("settings-modal-list") as SelectRenderable;

    list.setSelectedIndex(0);
    settings.handleKeyPress(key("return"));
    let enumEditor = settings.findDescendantById(
      "settings-modal-editor-select",
    ) as SelectRenderable;
    enumEditor.setSelectedIndex(2);
    enumEditor.selectCurrent();

    list.setSelectedIndex(1);
    settings.handleKeyPress(key("return"));
    enumEditor = settings.findDescendantById("settings-modal-editor-select") as SelectRenderable;
    enumEditor.setSelectedIndex(2);
    enumEditor.selectCurrent();

    list.setSelectedIndex(9);
    settings.handleKeyPress(key("return"));
    expect(settings.inspectConfig().reconnect.enabled).toBe(false);
    settings.handleKeyPress(key("s", true));
    await setup?.waitFor(() => applied.length === 1);
    await setup?.renderOnce();

    expect(applied[0]?.previous.ui.locale).toBe("auto");
    expect(applied[0]?.next.ui.locale).toBe("zh-CN");
    expect(applied[0]?.next.ui.theme).toBe("light");
    expect(applied[0]?.next.reconnect.enabled).toBe(false);
    expect(currentTheme()).toBe("light");
    expect(setup?.captureCharFrame()).toContain("点击主机");
  });
});

function splitFixture(): WorkspaceSnapshot {
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
  firstTab.surfaces.files.root = {
    type: "split",
    id: "split-fixture",
    direction: "horizontal",
    ratio: 0.42,
    first: { type: "pane", paneId: "pane-files-start-1" },
    second: { type: "pane", paneId: "files-1" },
  };
  return state;
}

function twoHostConfig(): ReturnType<typeof defaultConfig> {
  const config = defaultConfig();
  config.hosts = [
    {
      id: "first",
      alias: "first-alias",
      label: "First host",
      defaultPath: "/srv/first",
      source: "manual",
    },
    {
      id: "second",
      alias: "second-alias",
      label: "Second host",
      defaultPath: "/srv/second",
      source: "manual",
    },
  ];
  return config;
}

function hostWorkspaceState(hostId: string, title: string): WorkspaceSnapshot {
  const created = createHostWorkspaceTab({
    tabId: `tab-${hostId}`,
    hostId,
    title,
    defaultPath: `/srv/${hostId}`,
  });
  const panes: Record<string, PaneState> = {};
  for (const pane of created.panes) panes[pane.id] = pane;
  return {
    schemaVersion: 2,
    activeTabId: created.tab.id,
    tabs: [created.tab],
    panes,
    sidebar: { visible: true, width: 28, section: "hosts" },
    updatedAt: new Date().toISOString(),
  };
}

function leader(keyName: string): void {
  setup?.mockInput.pressKey("g", { ctrl: true });
  setup?.mockInput.pressKey(keyName);
}

function key(name: string, ctrl = false): KeyEvent {
  return {
    name,
    sequence: name,
    raw: name,
    eventType: "press",
    ctrl,
    meta: false,
    shift: false,
    super: false,
    hyper: false,
    option: false,
    number: false,
  } as unknown as KeyEvent;
}
