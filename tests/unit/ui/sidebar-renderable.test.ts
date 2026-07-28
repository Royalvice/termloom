import { afterEach, describe, expect, test } from "bun:test";
import type { InputRenderable, KeyEvent } from "@opentui/core";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { defaultConfig, type TermLoomConfig } from "../../../src/config/schema.js";
import { I18n } from "../../../src/i18n/i18n.js";
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
  public sessions: TmuxSessionInfo[] = [
    {
      name: "work",
      attachedClients: 0,
      windows: 2,
      createdAt: new Date("2026-07-28T00:00:00.000Z"),
    },
  ];
  public readonly operations: string[] = [];

  public async list(hostId: string): Promise<readonly TmuxSessionInfo[]> {
    this.operations.push(`list:${hostId}`);
    return this.sessions;
  }

  public async create(hostId: string, name: string, cwd?: string): Promise<void> {
    this.operations.push(`create:${hostId}:${name}:${cwd}`);
    this.sessions.push({
      name,
      attachedClients: 0,
      windows: 1,
      createdAt: new Date("2026-07-28T00:00:00.000Z"),
    });
  }

  public async rename(hostId: string, currentName: string, nextName: string): Promise<void> {
    this.operations.push(`rename:${hostId}:${currentName}:${nextName}`);
    const session = this.sessions.find((candidate) => candidate.name === currentName);
    if (session) session.name = nextName;
  }

  public async kill(hostId: string, name: string): Promise<void> {
    this.operations.push(`kill:${hostId}:${name}`);
    this.sessions = this.sessions.filter((candidate) => candidate.name !== name);
  }
}

describe("SidebarRenderable", () => {
  test("navigates hosts, manages real tmux service actions, attaches, and opens files", async () => {
    const sessions = new FakeSessions();
    const opened: string[] = [];
    await createSidebar(sessions, {
      onTerminal: (hostId, session) => opened.push(`terminal:${hostId}:${session ?? "shell"}`),
      onFiles: (hostId, path) => opened.push(`files:${hostId}:${path}`),
    });
    await setup?.waitForFrame((frame) => frame.includes("Fixture host"));
    sidebar?.handleKeyPress(key("return"));
    expect(opened).toContain("terminal:fixture:main");

    sidebar?.handleKeyPress(key("right"));
    await setup?.waitForFrame((frame) => frame.includes("work"));
    sidebar?.handleKeyPress(key("return"));
    expect(opened).toContain("terminal:fixture:work");

    sidebar?.handleKeyPress(key("n"));
    const create = await waitForInput();
    create.value = "research";
    create.submit();
    await setup?.waitFor(() => sessions.operations.includes("create:fixture:research:/workspace"));
    await setup?.waitForFrame((frame) => frame.includes("research"));
    sidebar?.handleKeyPress(key("down"));
    sidebar?.handleKeyPress(key("r", true));
    const rename = await waitForInput();
    rename.value = "research-2";
    rename.submit();
    await setup?.waitFor(() => sessions.operations.includes("rename:fixture:research:research-2"));
    await setup?.waitForFrame((frame) => frame.includes("research-2"));
    sidebar?.handleKeyPress(key("down"));
    sidebar?.handleKeyPress(key("d"));
    const confirmation = await waitForInput();
    confirmation.value = "DELETE";
    confirmation.submit();
    await setup?.waitFor(() => sessions.operations.includes("kill:fixture:research-2"));

    sidebar?.setSection("files");
    await setup?.waitForFrame((frame) => frame.includes("/workspace"));
    sidebar?.handleKeyPress(key("return"));
    expect(opened).toContain("files:fixture:/workspace");
    sidebar?.handleKeyPress(key("p"));
    const path = await waitForInput();
    path.value = "/srv/project";
    path.submit();
    expect(opened).toContain("files:fixture:/srv/project");
  });

  test("adds a complete OpenSSH host configuration through sequential in-TUI prompts", async () => {
    const saved: TermLoomConfig[] = [];
    await createSidebar(new FakeSessions(), {
      save: async (config) => {
        saved.push(structuredClone(config));
        return config;
      },
    });
    await setup?.waitForFrame((frame) => frame.includes("Fixture host"));
    sidebar?.handleKeyPress(key("n"));
    for (const value of ["gpu", "gpu-alias", "GPU server", "/srv/work", "research"]) {
      const input = await waitForInput();
      input.value = value;
      input.submit();
    }
    await setup?.waitFor(() => saved.length === 1);
    expect(saved[0]?.hosts).toContainEqual({
      id: "gpu",
      alias: "gpu-alias",
      label: "GPU server",
      defaultPath: "/srv/work",
      defaultTmuxSession: "research",
    });
    await setup?.waitForFrame((frame) => frame.includes("GPU server"));
  });
});

async function createSidebar(
  sessions: FakeSessions,
  callbacks: {
    onTerminal?: (hostId: string, session?: string) => void;
    onFiles?: (hostId: string, path: string) => void;
    save?: (config: TermLoomConfig) => Promise<TermLoomConfig>;
  } = {},
): Promise<void> {
  const config = defaultConfig();
  config.hosts.push({
    id: "fixture",
    alias: "fixture-alias",
    label: "Fixture host",
    defaultPath: "/workspace",
    defaultTmuxSession: "main",
  });
  setup = await createTestRenderer({ width: 60, height: 24 });
  sidebar = new SidebarRenderable(setup.renderer, {
    id: "sidebar-fixture",
    config,
    section: "hosts",
    i18n: new I18n("en"),
    sessions,
    saveConfig: callbacks.save,
    onOpenTerminal: callbacks.onTerminal,
    onOpenFiles: callbacks.onFiles,
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
