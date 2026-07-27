import { RGBA } from "@opentui/core";
import type { IBufferCell } from "@xterm/headless";

const ANSI_16: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0, 0],
  [205, 49, 49],
  [13, 188, 121],
  [229, 229, 16],
  [36, 114, 200],
  [188, 63, 188],
  [17, 168, 205],
  [229, 229, 229],
  [102, 102, 102],
  [241, 76, 76],
  [35, 209, 139],
  [245, 245, 67],
  [59, 142, 234],
  [214, 112, 214],
  [41, 184, 219],
  [255, 255, 255],
];

export const DEFAULT_TERMINAL_FG = RGBA.fromInts(205, 214, 244, 255);
export const DEFAULT_TERMINAL_BG = RGBA.fromInts(17, 17, 27, 255);

export function ansiPaletteColor(index: number): RGBA {
  const normalized = Math.max(0, Math.min(255, Math.floor(index)));
  if (normalized < 16) {
    const color = ANSI_16[normalized] ?? ([0, 0, 0] as const);
    return RGBA.fromInts(color[0], color[1], color[2], 255);
  }
  if (normalized < 232) {
    const cube = normalized - 16;
    const red = Math.floor(cube / 36);
    const green = Math.floor((cube % 36) / 6);
    const blue = cube % 6;
    const channel = (value: number) => (value === 0 ? 0 : 55 + value * 40);
    return RGBA.fromInts(channel(red), channel(green), channel(blue), 255);
  }
  const gray = 8 + (normalized - 232) * 10;
  return RGBA.fromInts(gray, gray, gray, 255);
}

function rgbNumberToColor(value: number): RGBA {
  return RGBA.fromInts((value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff, 255);
}

export function cellForeground(cell: IBufferCell): RGBA {
  if (cell.isFgRGB()) return rgbNumberToColor(cell.getFgColor());
  if (cell.isFgPalette()) return ansiPaletteColor(cell.getFgColor());
  return DEFAULT_TERMINAL_FG;
}

export function cellBackground(cell: IBufferCell): RGBA {
  if (cell.isBgRGB()) return rgbNumberToColor(cell.getBgColor());
  if (cell.isBgPalette()) return ansiPaletteColor(cell.getBgColor());
  return DEFAULT_TERMINAL_BG;
}
