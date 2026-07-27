import { describe, expect, test } from "bun:test";
import type { KeyEvent, MouseEvent } from "@opentui/core";
import { Terminal } from "@xterm/headless";
import {
  encodeKeyEvent,
  encodeMouseEvent,
  encodePaste,
} from "../../../src/terminal/input-encoder.js";

const key = (overrides: Partial<KeyEvent>): KeyEvent =>
  ({
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
    ...overrides,
  }) as KeyEvent;

describe("terminal input encoding", () => {
  test("honors application cursor mode", async () => {
    const terminal = new Terminal({ allowProposedApi: true });
    expect(encodeKeyEvent(key({ name: "up", sequence: "\u001b[A" }), terminal)).toBe("\u001b[A");
    await new Promise<void>((resolve) => terminal.write("\u001b[?1h", resolve));
    expect(encodeKeyEvent(key({ name: "up", sequence: "\u001b[A" }), terminal)).toBe("\u001bOA");
    terminal.dispose();
  });

  test("wraps bracketed paste exactly once", () => {
    expect(encodePaste("a\nb", false)).toBe("a\nb");
    expect(encodePaste("a\nb", true)).toBe("\u001b[200~a\nb\u001b[201~");
  });

  test("encodes SGR mouse coordinates and release", () => {
    const base = {
      button: 0,
      x: 4,
      y: 7,
      modifiers: { shift: false, alt: false, ctrl: false },
      target: null,
      preventDefault: () => undefined,
      stopPropagation: () => undefined,
    } as unknown as MouseEvent;
    expect(encodeMouseEvent({ ...base, type: "down" } as MouseEvent, 2, 3, "sgr")).toBe(
      "\u001b[<0;3;4M",
    );
    expect(encodeMouseEvent({ ...base, type: "up" } as MouseEvent, 2, 3, "sgr")).toBe(
      "\u001b[<0;3;4m",
    );
  });
});
