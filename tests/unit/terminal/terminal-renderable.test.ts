import { afterEach, describe, expect, test } from "bun:test";
import { type PasteEvent, TextAttributes } from "@opentui/core";
import { createTestRenderer, MouseButtons, type TestRendererSetup } from "@opentui/core/testing";
import { MemoryTerminalBackend } from "../../../src/terminal/backend.js";
import { TerminalRenderable } from "../../../src/terminal/terminal-renderable.js";
import { theme } from "../../../src/ui/theme.js";

let setup: TestRendererSetup | undefined;

afterEach(() => {
  setup?.renderer.destroy();
  setup = undefined;
});

async function createTerminal(
  width = 24,
  height = 6,
  onPathActivation?: (path: string, alternatePaths?: readonly string[]) => void | Promise<void>,
  onPathHover?: (path: string | undefined) => void,
  onCopyToClipboard?: (text: string) => boolean,
) {
  setup = await createTestRenderer({ width, height });
  const backend = new MemoryTerminalBackend(width, height);
  const terminal = new TerminalRenderable(setup.renderer, {
    id: "terminal",
    backend,
    width: "100%",
    height: "100%",
    onPathActivation: (token) => onPathActivation?.(token.path, token.alternatePaths),
    onPathHover: (token) => onPathHover?.(token?.path),
    onCopyToClipboard,
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

  test("extracts absolute, file URI, and line-column terminal path tokens", async () => {
    const { terminal } = await createTerminal(80, 4);
    const value = 'open "file:///tmp/termloom example.ts:42:7"';
    await terminal.feed(value);
    expect(terminal.pathAtCell(value.indexOf("/tmp") + 3, 0)).toEqual({
      raw: "file:///tmp/termloom example.ts:42:7",
      path: "/tmp/termloom example.ts",
    });

    const shellError = "-bash: /workspace/output: Is a directory";
    await terminal.feed(`\r\n${shellError}`);
    expect(terminal.pathAtCell(shellError.indexOf("/workspace") + 4, 1)).toEqual({
      raw: "/workspace/output:",
      path: "/workspace/output",
      alternatePaths: ["/workspace/output:"],
    });

    await terminal.feed("\r\nrelative/project.ts:3:1");
    expect(terminal.pathAtCell(4, 2)).toBeUndefined();
  });

  test("uses Ctrl+left click for a path activation and otherwise forwards terminal mouse input", async () => {
    const activated: string[] = [];
    const {
      terminal,
      backend,
      setup: rendererSetup,
    } = await createTerminal(80, 5, (path) => {
      activated.push(path);
    });
    const value = "/workspace/src/file.ts:42:7";
    await terminal.feed(`\u001b[?1000h\u001b[?1006h${value}`);
    const x = terminal.screenX + value.indexOf("/workspace") + 3;
    const y = terminal.screenY;

    const beforeCtrlClick = backend.written.length;
    await rendererSetup.mockMouse.click(x, y, MouseButtons.LEFT, { modifiers: { ctrl: true } });
    expect(activated).toEqual(["/workspace/src/file.ts"]);
    expect(backend.written.slice(beforeCtrlClick)).not.toContain("\u001b[<16;");

    const beforeOrdinaryClick = backend.written.length;
    await rendererSetup.mockMouse.click(x, y, MouseButtons.LEFT);
    expect(activated).toEqual(["/workspace/src/file.ts"]);
    expect(backend.written.slice(beforeOrdinaryClick)).toContain("\u001b[<0;");
  });

  test("activates one absolute path across terminal soft-wrap rows", async () => {
    const activated: string[] = [];
    const { terminal, setup: rendererSetup } = await createTerminal(72, 5, (path) => {
      activated.push(path);
    });
    const value =
      "/srv/termloom-demo/benchmarks/video_sprite_8_actions_20260827T000000Z/review/hello-world-laser.mp4";
    await terminal.feed(value);

    expect(value.length).toBeGreaterThan(terminal.terminal.cols);
    expect(terminal.pathAtCell(8, 1)).toEqual({ path: value, raw: value });

    await rendererSetup.mockMouse.click(
      terminal.screenX + 8,
      terminal.screenY + 1,
      MouseButtons.LEFT,
      { modifiers: { ctrl: true } },
    );
    expect(activated).toEqual([value]);
  });

  test("activates a soft-wrapped shell-escaped absolute path with its filesystem spelling", async () => {
    const activated: Array<{ path: string; alternatePaths?: readonly string[] }> = [];
    const { terminal, setup: rendererSetup } = await createTerminal(
      72,
      5,
      (path, alternatePaths) => {
        activated.push({ path, alternatePaths });
      },
    );
    const visible = String.raw`/srv/termloom-demo/benchmarks/escaped\_path\_fixture\_20260827T000000Z/review/idle.gif`;
    const filesystem =
      "/srv/termloom-demo/benchmarks/escaped_path_fixture_20260827T000000Z/review/idle.gif";
    await terminal.feed(visible);

    expect(terminal.pathAtCell(8, 1)).toEqual({
      raw: visible,
      path: filesystem,
      alternatePaths: [visible],
    });
    await rendererSetup.mockMouse.click(
      terminal.screenX + 8,
      terminal.screenY + 1,
      MouseButtons.LEFT,
      { modifiers: { ctrl: true } },
    );
    expect(activated).toEqual([{ path: filesystem, alternatePaths: [visible] }]);
  });

  test("renders a discoverable path link and strengthens it on hover", async () => {
    const hovers: Array<string | undefined> = [];
    const { terminal, setup: rendererSetup } = await createTerminal(80, 5, undefined, (path) =>
      hovers.push(path),
    );
    const value = "-bash: /workspace/output: Is a directory";
    await terminal.feed(value);
    await rendererSetup.renderOnce();
    const x = terminal.screenX + value.indexOf("/workspace") + 3;
    const y = terminal.screenY;

    const initialSpan = rendererSetup
      .captureSpans()
      .lines.flatMap((line) => line.spans)
      .find((candidate) => candidate.text.includes("/workspace/output"));
    expect(initialSpan).toBeDefined();
    const initialAttributes = initialSpan?.attributes ?? 0;
    expect(initialAttributes & TextAttributes.UNDERLINE).toBe(TextAttributes.UNDERLINE);
    expect(initialAttributes & TextAttributes.BOLD).toBe(0);

    await rendererSetup.mockMouse.moveTo(x, y);
    await rendererSetup.renderOnce();

    const span = rendererSetup
      .captureSpans()
      .lines.flatMap((line) => line.spans)
      .find((candidate) => candidate.text.includes("/workspace/output"));
    expect(span).toBeDefined();
    const hoverAttributes = span?.attributes ?? 0;
    expect(hoverAttributes & TextAttributes.UNDERLINE).toBe(TextAttributes.UNDERLINE);
    expect(hoverAttributes & TextAttributes.BOLD).toBe(TextAttributes.BOLD);
    expect(hovers).toEqual(["/workspace/output"]);

    await rendererSetup.mockMouse.moveTo(terminal.screenX, y);
    expect(hovers.at(-1)).toBeUndefined();
  });

  test("selects terminal cells with mouse drag, highlights them, and copies with Command+C", async () => {
    const copied: string[] = [];
    const { terminal, setup: rendererSetup } = await createTerminal(
      40,
      5,
      undefined,
      undefined,
      (text) => {
        copied.push(text);
        return true;
      },
    );
    await terminal.feed("hello world\r\nsecond line");
    await rendererSetup.renderOnce();

    await rendererSetup.mockMouse.drag(
      terminal.screenX + 1,
      terminal.screenY,
      terminal.screenX + 5,
      terminal.screenY,
    );
    await rendererSetup.renderOnce();

    expect(terminal.getSelectedText()).toBe("ello");
    const selectedSpan = rendererSetup
      .captureSpans()
      .lines.flatMap((line) => line.spans)
      .find((span) => span.text.includes("ello"));
    expect(selectedSpan?.bg.toInts()).toEqual(hexInts(theme.selectionStrong));

    terminal.handleKeyPress({
      name: "c",
      sequence: "c",
      ctrl: false,
      shift: false,
      meta: false,
      option: false,
      super: true,
      eventType: "press",
    } as never);
    expect(copied).toEqual(["ello"]);
  });

  test("uses Shift+drag for selection when the child terminal enables mouse tracking", async () => {
    const copied: string[] = [];
    const {
      terminal,
      backend,
      setup: rendererSetup,
    } = await createTerminal(40, 5, undefined, undefined, (text) => {
      copied.push(text);
      return true;
    });
    await terminal.feed("tracked text\u001b[?1000h");
    await rendererSetup.renderOnce();
    await rendererSetup.mockMouse.drag(
      terminal.screenX,
      terminal.screenY,
      terminal.screenX + 6,
      terminal.screenY,
      MouseButtons.LEFT,
      { modifiers: { shift: true } },
    );
    await rendererSetup.renderOnce();
    expect(terminal.getSelectedText()).toBe("tracked");
    expect(backend.written).not.toContain("\u001b[<");
    terminal.handleKeyPress({
      name: "c",
      sequence: "c",
      ctrl: false,
      shift: false,
      meta: false,
      option: false,
      super: true,
      eventType: "press",
    } as never);
    expect(copied).toEqual(["tracked"]);
  });
});

function hexInts(hex: string): [number, number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff, 255];
}
