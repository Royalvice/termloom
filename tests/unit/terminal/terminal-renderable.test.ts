import { afterEach, describe, expect, test } from "bun:test";
import type { PasteEvent } from "@opentui/core";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { MemoryTerminalBackend } from "../../../src/terminal/backend.js";
import { TerminalRenderable } from "../../../src/terminal/terminal-renderable.js";

let setup: TestRendererSetup | undefined;

afterEach(() => {
  setup?.renderer.destroy();
  setup = undefined;
});

async function createTerminal(width = 24, height = 6) {
  setup = await createTestRenderer({ width, height });
  const backend = new MemoryTerminalBackend(width, height);
  const terminal = new TerminalRenderable(setup.renderer, {
    id: "terminal",
    backend,
    width: "100%",
    height: "100%",
  });
  setup.renderer.root.add(terminal);
  terminal.focus();
  await setup.renderOnce();
  return { terminal, backend, setup };
}

describe("TerminalRenderable", () => {
  test("renders ANSI, truecolor, CJK, emoji, and wide continuation cells", async () => {
    const { terminal, setup: rendererSetup } = await createTerminal();
    await terminal.feed("plain \u001b[1;38;2;10;20;30m彩🙂\u001b[0m");
    await rendererSetup.renderOnce();
    const frame = rendererSetup.captureCharFrame();
    expect(frame).toContain("plain");
    expect(frame).toContain("彩");
    expect(frame).toContain("🙂");
    const colored = terminal.inspectCell(6, 0);
    expect(colored).toMatchObject({ chars: "彩", width: 2, foreground: 0x0a141e, bold: true });
    expect(terminal.inspectCell(7, 0)).toMatchObject({ width: 0 });
  });

  test("switches alternate screen and restores the normal screen", async () => {
    const { terminal, setup: rendererSetup } = await createTerminal();
    await terminal.feed("normal");
    await terminal.feed("\u001b[?1049h\u001b[HALT");
    await rendererSetup.renderOnce();
    expect(terminal.cursor.buffer).toBe("alternate");
    expect(rendererSetup.captureCharFrame()).toContain("ALT");
    await terminal.feed("\u001b[?1049l");
    await rendererSetup.renderOnce();
    expect(terminal.cursor.buffer).toBe("normal");
    expect(rendererSetup.captureCharFrame()).toContain("normal");
  });

  test("forwards key input, bracketed paste, mouse, and resize", async () => {
    const { terminal, backend, setup: rendererSetup } = await createTerminal(20, 5);
    terminal.handleKeyPress({
      name: "a",
      sequence: "a",
      ctrl: false,
      shift: false,
      meta: false,
      option: false,
      super: false,
      hyper: false,
      eventType: "press",
      repeated: false,
      source: "raw",
    } as unknown as Parameters<TerminalRenderable["handleKeyPress"]>[0]);
    await terminal.feed("\u001b[?2004h\u001b[?1000h\u001b[?1006h");
    terminal.handlePaste({
      bytes: new TextEncoder().encode("paste"),
      preventDefault: () => undefined,
    } as PasteEvent);
    await rendererSetup.mockMouse.click(2, 2);
    rendererSetup.resize(30, 8);
    await rendererSetup.renderOnce();
    expect(backend.written).toContain("a");
    expect(backend.written).toContain("\u001b[200~paste\u001b[201~");
    expect(backend.written).toContain("\u001b[<0;3;3M");
    expect(backend.cols).toBe(30);
    expect(backend.rows).toBe(8);
  });

  test("tracks cursor coordinates", async () => {
    const { terminal } = await createTerminal();
    await terminal.feed("abc\u001b[2;5H");
    expect(terminal.cursor).toEqual({ x: 4, y: 1, buffer: "normal" });
  });
});
