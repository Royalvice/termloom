import { expect, test } from "bun:test";
import { CliRenderEvents } from "@opentui/core";
import {
  createTerminalCapabilities,
  createTestRenderer,
  setRendererCapabilities,
} from "@opentui/core/testing";
import {
  selectMediaAdapter,
  waitForTerminalCapabilities,
} from "../../../src/media/capabilities.js";

test("waits for OpenTUI's capability event before selecting a live adapter", async () => {
  const setup = await createTestRenderer({ width: 40, height: 12 });
  try {
    const pending = waitForTerminalCapabilities(setup.renderer, 100);
    const expected = setRendererCapabilities(setup.renderer, {
      terminal: { name: "ghostty", version: "1.3.1", from_xtversion: true },
      kitty_graphics: false,
      rgb: true,
    });
    setup.renderer.emit(CliRenderEvents.CAPABILITIES);

    expect(await pending).toBe(expected);
    expect(selectMediaAdapter("auto", { TERM_PROGRAM: "ghostty" }, expected).name).toBe("kitty");
  } finally {
    setup.renderer.destroy();
  }
});

test("ignores partial capability events until XTVersion arrives", async () => {
  const setup = await createTestRenderer({ width: 40, height: 12 });
  try {
    const pending = waitForTerminalCapabilities(setup.renderer, 100);
    setRendererCapabilities(setup.renderer, { rgb: true, kitty_graphics: false });
    setup.renderer.emit(CliRenderEvents.CAPABILITIES);
    const expected = setRendererCapabilities(setup.renderer, {
      terminal: { name: "kitty", version: "0.48.1", from_xtversion: true },
      rgb: true,
      kitty_graphics: true,
    });
    setup.renderer.emit(CliRenderEvents.CAPABILITIES);

    expect(await pending).toBe(expected);
  } finally {
    setup.renderer.destroy();
  }
});

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

test("keeps a known Ghostty direct session on its native protocol despite OpenTUI 0.4.5's false probe", () => {
  const ghosttyFalseProbe = createTerminalCapabilities({
    terminal: { name: "ghostty", from_xtversion: true },
    kitty_graphics: false,
    rgb: true,
  });
  const expected = {
    name: "kitty",
    terminal: "ghostty",
    protocol: "kitty-unicode",
  } as const;
  expect(selectMediaAdapter("auto", {}, ghosttyFalseProbe)).toEqual(expected);
  expect(selectMediaAdapter("kitty", {}, ghosttyFalseProbe)).toEqual(expected);
});

test("uses OpenTUI's probed color and multiplexer capabilities", () => {
  const incompleteKittyProbe = createTerminalCapabilities({
    terminal: { name: "", from_xtversion: false },
    kitty_graphics: false,
    rgb: true,
  });
  expect(selectMediaAdapter("auto", { TERM: "xterm-kitty" }, incompleteKittyProbe)).toEqual({
    name: "kitty",
    terminal: "kitty",
    protocol: "kitty-unicode",
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
