import { expect, test } from "bun:test";
import { createTerminalCapabilities } from "@opentui/core/testing";
import { selectMediaAdapter } from "../../../src/media/capabilities.js";

test("selects explicit terminal media adapters by real terminal identity", () => {
  expect(selectMediaAdapter("auto", { TERM_PROGRAM: "ghostty" })).toEqual({
    name: "kitty",
    terminal: "ghostty",
    protocol: "kitty-unicode",
  });
  expect(selectMediaAdapter("auto", { TERM: "xterm-kitty" })).toEqual({
    name: "kitty",
    terminal: "kitty",
    protocol: "kitty-unicode",
  });
  expect(selectMediaAdapter("auto", { TERM_PROGRAM: "WezTerm" })).toEqual({
    name: "iterm2",
    terminal: "wezterm",
    protocol: "iterm2-inline",
  });
  expect(selectMediaAdapter("auto", { TERM_PROGRAM: "iTerm.app" })).toEqual({
    name: "iterm2",
    terminal: "iterm2",
    protocol: "iterm2-inline",
  });
  expect(selectMediaAdapter("auto", { TERM_PROGRAM: "Apple_Terminal" })).toEqual({
    name: "truecolor-cells",
    terminal: "generic",
    protocol: "truecolor-half-block",
  });
});

test("uses OpenTUI's probed graphics, color, and multiplexer capabilities", () => {
  const ghosttyWithoutKitty = createTerminalCapabilities({
    terminal: { name: "ghostty" },
    kitty_graphics: false,
    rgb: true,
  });
  expect(selectMediaAdapter("auto", {}, ghosttyWithoutKitty)).toEqual({
    name: "truecolor-cells",
    terminal: "ghostty",
    protocol: "truecolor-half-block",
  });

  const noRgb = createTerminalCapabilities({
    terminal: { name: "xterm" },
    kitty_graphics: false,
    rgb: false,
  });
  expect(() => selectMediaAdapter("truecolor-cells", {}, noRgb)).toThrow(
    "24-bit color media is unavailable",
  );
});

test("uses the in-buffer adapter under tmux and rejects unsupported forced protocols", () => {
  expect(selectMediaAdapter("auto", { TERM_PROGRAM: "ghostty", TMUX: "/tmp/tmux" })).toEqual({
    name: "truecolor-cells",
    terminal: "ghostty",
    protocol: "truecolor-half-block",
  });
  expect(() => selectMediaAdapter("kitty", { TERM_PROGRAM: "iTerm.app" })).toThrow(
    "Kitty Unicode image placement is unavailable",
  );
  expect(() =>
    selectMediaAdapter("iterm2", { TERM_PROGRAM: "iTerm.app", TMUX: "/tmp/tmux" }),
  ).toThrow("iTerm2 inline images is unavailable");
});
