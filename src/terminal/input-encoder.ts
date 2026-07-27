import type { KeyEvent, MouseEvent } from "@opentui/core";
import type { Terminal } from "@xterm/headless";

const KEY_SEQUENCES: Readonly<Record<string, string>> = {
  escape: "\u001b",
  enter: "\r",
  return: "\r",
  kpenter: "\r",
  linefeed: "\n",
  backspace: "\u007f",
  tab: "\t",
  insert: "\u001b[2~",
  delete: "\u001b[3~",
  pageup: "\u001b[5~",
  pagedown: "\u001b[6~",
  f1: "\u001bOP",
  f2: "\u001bOQ",
  f3: "\u001bOR",
  f4: "\u001bOS",
  f5: "\u001b[15~",
  f6: "\u001b[17~",
  f7: "\u001b[18~",
  f8: "\u001b[19~",
  f9: "\u001b[20~",
  f10: "\u001b[21~",
  f11: "\u001b[23~",
  f12: "\u001b[24~",
};

export function encodeKeyEvent(key: KeyEvent, terminal: Terminal): string {
  if (key.name === "tab" && key.shift) return "\u001b[Z";
  if (key.name === "up") return terminal.modes.applicationCursorKeysMode ? "\u001bOA" : "\u001b[A";
  if (key.name === "down")
    return terminal.modes.applicationCursorKeysMode ? "\u001bOB" : "\u001b[B";
  if (key.name === "right")
    return terminal.modes.applicationCursorKeysMode ? "\u001bOC" : "\u001b[C";
  if (key.name === "left")
    return terminal.modes.applicationCursorKeysMode ? "\u001bOD" : "\u001b[D";
  if (key.name === "home")
    return terminal.modes.applicationCursorKeysMode ? "\u001bOH" : "\u001b[H";
  if (key.name === "end") return terminal.modes.applicationCursorKeysMode ? "\u001bOF" : "\u001b[F";
  return KEY_SEQUENCES[key.name] ?? key.sequence;
}

export function encodePaste(text: string, bracketed: boolean): string {
  return bracketed ? `\u001b[200~${text}\u001b[201~` : text;
}

export type MouseEncoding = "x10" | "utf8" | "sgr" | "urxvt";

export class MouseProtocolTracker {
  private encoding: MouseEncoding = "x10";

  public install(terminal: Terminal): () => void {
    const enable = terminal.parser.registerCsiHandler({ prefix: "?", final: "h" }, (params) => {
      this.update(params, true);
      return false;
    });
    const disable = terminal.parser.registerCsiHandler({ prefix: "?", final: "l" }, (params) => {
      this.update(params, false);
      return false;
    });
    return () => {
      enable.dispose();
      disable.dispose();
    };
  }

  public get current(): MouseEncoding {
    return this.encoding;
  }

  private update(params: (number | number[])[], enabled: boolean): void {
    const values = params.flatMap((value) => (Array.isArray(value) ? value : [value]));
    if (values.includes(1006)) this.encoding = enabled ? "sgr" : "x10";
    if (values.includes(1015)) this.encoding = enabled ? "urxvt" : "x10";
    if (values.includes(1005)) this.encoding = enabled ? "utf8" : "x10";
  }
}

export function encodeMouseEvent(
  event: MouseEvent,
  localX: number,
  localY: number,
  encoding: MouseEncoding,
): string | null {
  const x = Math.max(1, Math.floor(localX) + 1);
  const y = Math.max(1, Math.floor(localY) + 1);
  const modifiers =
    (event.modifiers.shift ? 4 : 0) +
    (event.modifiers.alt ? 8 : 0) +
    (event.modifiers.ctrl ? 16 : 0);

  let button = event.button;
  let release = false;
  if (event.type === "scroll") {
    button = 64 + (event.scroll?.direction === "down" ? 1 : 0);
  } else if (event.type === "move" || event.type === "drag") {
    button = Math.max(0, event.button) + 32;
  } else if (event.type === "up" || event.type === "drag-end") {
    release = true;
    if (encoding !== "sgr") button = 3;
  } else if (event.type !== "down") {
    return null;
  }

  const code = button + modifiers;
  if (encoding === "sgr") {
    return `\u001b[<${code};${x};${y}${release ? "m" : "M"}`;
  }
  if (encoding === "urxvt") {
    return `\u001b[${code + 32};${x};${y}M`;
  }

  const encodeCoordinate = (value: number) => String.fromCodePoint(Math.min(2047, value + 32));
  return `\u001b[M${String.fromCodePoint(code + 32)}${encodeCoordinate(x)}${encodeCoordinate(y)}`;
}
