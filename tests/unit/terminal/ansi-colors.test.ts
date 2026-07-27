import { describe, expect, test } from "bun:test";
import { ansiPaletteColor } from "../../../src/terminal/ansi-colors.js";

describe("ansiPaletteColor", () => {
  test("maps ANSI, cube, and grayscale entries", () => {
    expect(ansiPaletteColor(1).toInts()).toEqual([205, 49, 49, 255]);
    expect(ansiPaletteColor(16).toInts()).toEqual([0, 0, 0, 255]);
    expect(ansiPaletteColor(196).toInts()).toEqual([255, 0, 0, 255]);
    expect(ansiPaletteColor(255).toInts()).toEqual([238, 238, 238, 255]);
  });
});
