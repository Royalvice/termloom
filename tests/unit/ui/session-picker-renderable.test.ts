import { afterEach, describe, expect, test } from "bun:test";
import type {
  InputRenderable,
  KeyEvent,
  ScrollBoxRenderable,
  SelectRenderable,
} from "@opentui/core";
import {
  createMockMouse,
  createTestRenderer,
  MouseButtons,
  type TestRendererSetup,
} from "@opentui/core/testing";
import type { TmuxSessionInfo } from "../../../src/tmux/tmux-service.js";
import type { ContextMenuRequest } from "../../../src/ui/dismissible-overlay-controller.js";
import {
  SessionPickerRenderable,
  type SessionPickerService,
} from "../../../src/ui/session-picker-renderable.js";
import type { PaneState } from "../../../src/workspace/schema.js";

type SessionPickerPaneState = Extract<PaneState, { kind: "session-picker" }>;

let setup: TestRendererSetup | undefined;
let picker: SessionPickerRenderable | undefined;

afterEach(() => {
  picker?.destroyRecursively();
  setup?.renderer.destroy();
  picker = undefined;
  setup = undefined;
});

class FakeSessions implements SessionPickerService {
  public sessions: TmuxSessionInfo[] = [session("work", 2, 1), session("research", 3, 0)];
  public readonly operations: string[] = [];

  public async list(hostId: string): Promise<readonly TmuxSessionInfo[]> {
    this.operations.push(`list:${hostId}`);
    return this.sessions;
  }

  public async create(hostId: string, name: string, cwd?: string): Promise<void> {
    this.operations.push(`create:${hostId}:${name}:${cwd}`);
    this.sessions.push(session(name, 1, 0));
  }

  public async rename(hostId: string, currentName: string, nextName: string): Promise<void> {
    this.operations.push(`rename:${hostId}:${currentName}:${nextName}`);
    const current = this.sessions.find((candidate) => candidate.name === currentName);
    if (current) current.name = nextName;
  }

  public async kill(hostId: string, name: string): Promise<void> {
    this.operations.push(`kill:${hostId}:${name}`);
    this.sessions = this.sessions.filter((candidate) => candidate.name !== name);
  }
}

describe("SessionPickerRenderable", () => {
  test("supports mouse attach, root context actions, toolbar actions, and Escape", async () => {
    const service = new FakeSessions();
    const attached: string[] = [];
    const rawShells: string[] = [];
    const contextRequests: ContextMenuRequest[] = [];
    await createPicker(service, attached, rawShells, {
      onContextMenu: (request) => contextRequests.push(request),
    });
    if (!setup || !picker) throw new Error("Expected session picker");
    await setup.waitForFrame((frame) => frame.includes("research"));
    const mouse = createMockMouse(setup.renderer);
    const list = requiredDescendant(`${picker.id}-list`);

    await mouse.click(list.screenX + 2, list.screenY + 2);
    await mouse.doubleClick(list.screenX + 2, list.screenY + 2);
    expect(attached).toContain("research:replace");

    await mouse.click(list.screenX + 2, list.screenY + 2, MouseButtons.RIGHT);
    contextRequests
      .at(-1)
      ?.actions.find((action) => action.id === "open-split")
      ?.run();
    expect(attached).toContain("research:split");
    expect(attached.filter((value) => value === "research:split")).toHaveLength(1);

    await mouse.click(list.screenX + 2, list.screenY + 2, MouseButtons.RIGHT);
    contextRequests
      .at(-1)
      ?.actions.find((action) => action.id === "rename")
      ?.run();
    const rename = await waitForInput();
    rename.value = "research-2";
    rename.submit();
    await setup.waitFor(() => service.operations.includes("rename:fixture:research:research-2"));
    await setup.waitForFrame((frame) => frame.includes("research-2"));

    await mouse.click(list.screenX + 2, list.screenY + 2, MouseButtons.RIGHT);
    contextRequests
      .at(-1)
      ?.actions.find((action) => action.id === "kill")
      ?.run();
    const confirmation = await waitForInput();
    confirmation.value = "DELETE";
    confirmation.submit();
    await setup.waitFor(() => service.operations.includes("kill:fixture:research-2"));
    expect(picker.findDescendantById(`${picker.id}-context-list`)).toBeUndefined();

    const newButton = requiredDescendant(`${picker.id}-new`);
    await mouse.click(newButton.screenX + 2, newButton.screenY);
    const create = await waitForInput();
    create.value = "daily";
    create.submit();
    await setup.waitFor(() => service.operations.includes("create:fixture:daily:/srv/work"));
    expect(attached).toContain("daily:replace");

    await mouse.click(newButton.screenX + 2, newButton.screenY);
    await waitForInput();
    setup.mockInput.pressKey("\x1b");
    await Bun.sleep(80);
    expect(picker.findDescendantById(`${picker.id}-modal-input`)).toBeUndefined();

    const raw = requiredDescendant(`${picker.id}-raw`);
    await mouse.click(raw.screenX + 2, raw.screenY);
    expect(rawShells).toEqual(["replace"]);

    const refresh = requiredDescendant(`${picker.id}-refresh`);
    const beforeRefresh = service.operations.filter((value) => value === "list:fixture").length;
    await mouse.click(refresh.screenX + 1, refresh.screenY);
    await setup.waitFor(
      () => service.operations.filter((value) => value === "list:fixture").length > beforeRefresh,
    );
  });

  test("keeps the empty state inert while exposing New and Raw SSH actions", async () => {
    const service = new FakeSessions();
    service.sessions = [];
    const attached: string[] = [];
    const rawShells: string[] = [];
    await createPicker(service, attached, rawShells);
    if (!setup || !picker) throw new Error("Expected session picker");
    await setup.waitForFrame((frame) => frame.includes("No tmux sessions"));
    const mouse = createMockMouse(setup.renderer);
    const list = requiredDescendant(`${picker.id}-list`);

    await mouse.doubleClick(list.screenX + 2, list.screenY);
    expect(attached).toEqual([]);

    const raw = requiredDescendant(`${picker.id}-raw`);
    await mouse.click(raw.screenX + 2, raw.screenY);
    expect(rawShells).toEqual(["replace"]);

    picker.handleKeyPress(key("n"));
    const create = await waitForInput();
    create.value = "first";
    create.submit();
    await setup.waitFor(() => service.operations.includes("create:fixture:first:/srv/work"));
    expect(attached).toContain("first:replace");
  });

  test("prefers the configured default session and keeps narrow actions scrollable", async () => {
    const service = new FakeSessions();
    await createPicker(service, [], [], { defaultSession: "research", width: 32 });
    if (!setup || !picker) throw new Error("Expected session picker");
    await setup.waitForFrame((frame) => frame.includes("research"));

    const list = requiredDescendant(`${picker.id}-list`) as SelectRenderable;
    expect(list.getSelectedIndex()).toBe(1);

    const toolbar = requiredDescendant(`${picker.id}-toolbar`) as ScrollBoxRenderable;
    const before = toolbar.scrollLeft;
    await createMockMouse(setup.renderer).scroll(toolbar.screenX + 1, toolbar.screenY, "right");
    await setup.renderOnce();
    expect(toolbar.scrollLeft).toBeGreaterThan(before);
  });
});

async function createPicker(
  service: FakeSessions,
  attached: string[],
  rawShells: string[],
  options: {
    defaultSession?: string;
    width?: number;
    onContextMenu?: (request: ContextMenuRequest) => void;
  } = {},
): Promise<void> {
  setup = await createTestRenderer({ width: options.width ?? 72, height: 24 });
  const pane: SessionPickerPaneState = {
    id: "session-pane",
    kind: "session-picker",
    title: "Sessions",
    target: { kind: "ssh", hostId: "fixture" },
  };
  picker = new SessionPickerRenderable(setup.renderer, {
    id: "session-picker",
    pane,
    service,
    defaultPath: "/srv/work",
    defaultSession: options.defaultSession,
    onAttach: (_pane, value, inSplit) =>
      attached.push(`${value.name}:${inSplit ? "split" : "replace"}`),
    onRawShell: (_pane, inSplit) => rawShells.push(inSplit ? "split" : "replace"),
    onContextMenu: (request) => options.onContextMenu?.(request),
  });
  setup.renderer.root.add(picker);
  picker.focus();
}

function requiredDescendant(id: string) {
  const descendant = picker?.findDescendantById(id);
  if (!descendant) throw new Error(`Expected ${id}`);
  return descendant;
}

async function waitForDescendant(id: string) {
  await setup?.waitFor(() => Boolean(picker?.findDescendantById(id)));
  return requiredDescendant(id);
}

async function waitForInput(): Promise<InputRenderable> {
  const input = await waitForDescendant(`${picker?.id}-modal-input`);
  if (!("submit" in input)) throw new Error("Expected session prompt input");
  return input as InputRenderable;
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

function session(name: string, windows: number, attachedClients: number): TmuxSessionInfo {
  return {
    name,
    attachedClients,
    windows,
    createdAt: new Date("2026-07-28T00:00:00.000Z"),
  };
}
