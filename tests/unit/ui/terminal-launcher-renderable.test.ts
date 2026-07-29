import { afterEach, describe, expect, test } from "bun:test";
import { KeyEvent } from "@opentui/core";
import { createMockMouse, createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { TerminalLauncherRenderable } from "../../../src/ui/terminal-launcher-renderable.js";
import type { PaneState } from "../../../src/workspace/schema.js";

type TerminalLauncherPane = Extract<PaneState, { kind: "terminal-launcher" }>;

let setup: TestRendererSetup | undefined;
let launcher: TerminalLauncherRenderable | undefined;

afterEach(() => {
  launcher?.destroyRecursively();
  setup?.renderer.destroy();
  launcher = undefined;
  setup = undefined;
});

describe("TerminalLauncherRenderable", () => {
  test("opens Direct SSH and Tmux only after their mouse buttons are clicked", async () => {
    const actions: string[] = [];
    await createLauncher(actions, 49);
    if (!setup || !launcher) throw new Error("Expected terminal launcher");
    await setup.waitForFrame((frame) => frame.includes("Direct SSH") && frame.includes("Tmux"));
    expect(actions).toEqual([]);

    const mouse = createMockMouse(setup.renderer);
    const direct = requiredDescendant("launcher-direct");
    const tmux = requiredDescendant("launcher-tmux");
    await mouse.click(direct.screenX + 2, direct.screenY + 1);
    await mouse.click(tmux.screenX + 2, tmux.screenY + 1);

    expect(actions).toEqual(["direct:fixture", "tmux:fixture"]);
  });

  test("supports arrow, Tab, Enter, and numeric keyboard choices", async () => {
    const actions: string[] = [];
    await createLauncher(actions);
    if (!launcher) throw new Error("Expected terminal launcher");

    expect(launcher.handleKeyPress(key("return", "\r"))).toBe(true);
    expect(launcher.handleKeyPress(key("down", "\u001b[B"))).toBe(true);
    expect(launcher.handleKeyPress(key("return", "\r"))).toBe(true);
    expect(launcher.handleKeyPress(key("tab", "\t"))).toBe(true);
    expect(launcher.handleKeyPress(key("return", "\r"))).toBe(true);
    expect(launcher.handleKeyPress(key("1", "1"))).toBe(true);
    expect(launcher.handleKeyPress(key("2", "2"))).toBe(true);
    expect(launcher.handleKeyPress(key("x", "x"))).toBe(false);

    expect(actions).toEqual([
      "direct:fixture",
      "tmux:fixture",
      "direct:fixture",
      "direct:fixture",
      "tmux:fixture",
    ]);
  });
});

async function createLauncher(actions: string[], width = 80): Promise<void> {
  setup = await createTestRenderer({ width, height: 24 });
  const pane: TerminalLauncherPane = {
    id: "launcher-pane",
    kind: "terminal-launcher",
    title: "Terminal",
    target: { kind: "ssh", hostId: "fixture" },
  };
  launcher = new TerminalLauncherRenderable(setup.renderer, {
    id: "launcher",
    pane,
    onDirectSsh: (value) => actions.push(`direct:${value.target.hostId}`),
    onTmux: (value) => actions.push(`tmux:${value.target.hostId}`),
  });
  setup.renderer.root.add(launcher);
  launcher.focus();
}

function requiredDescendant(id: string) {
  const descendant = launcher?.findDescendantById(id);
  if (!descendant) throw new Error(`Expected ${id}`);
  return descendant;
}

function key(name: string, sequence: string): KeyEvent {
  return new KeyEvent({
    name,
    sequence,
    raw: sequence,
    eventType: "press",
    source: "raw",
    ctrl: false,
    shift: false,
    meta: false,
    option: false,
    super: false,
    hyper: false,
    number: /^\d$/.test(name),
  });
}
