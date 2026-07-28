import type { TerminalCapabilities } from "@opentui/core";
import { TermLoomError } from "../core/errors.js";
import type { MediaAdapterSelection } from "./types.js";

export type ConfiguredMediaAdapter = "auto" | "kitty" | "iterm2" | "truecolor-cells";

export interface MediaCapabilityEnvironment {
  TERM?: string;
  TERM_PROGRAM?: string;
  TMUX?: string;
  COLORTERM?: string;
}

export function selectMediaAdapter(
  configured: ConfiguredMediaAdapter,
  environment: MediaCapabilityEnvironment = process.env as MediaCapabilityEnvironment,
  capabilities?: TerminalCapabilities | null,
): MediaAdapterSelection {
  const terminal = identifyTerminal(environment, capabilities);
  const multiplexed =
    Boolean(environment.TMUX) ||
    (capabilities !== undefined && capabilities !== null && capabilities.multiplexer !== "none");
  if (configured === "truecolor-cells") {
    return cellSelection(terminal, capabilities);
  }
  if (configured === "kitty") {
    if (
      multiplexed ||
      (terminal !== "ghostty" && terminal !== "kitty") ||
      capabilities?.kitty_graphics === false
    ) {
      return unsupported("Kitty Unicode image placement", terminal, multiplexed);
    }
    return { name: "kitty", terminal, protocol: "kitty-unicode" };
  }
  if (configured === "iterm2") {
    if (multiplexed || (terminal !== "iterm2" && terminal !== "wezterm")) {
      return unsupported("iTerm2 inline images", terminal, multiplexed);
    }
    return { name: "iterm2", terminal, protocol: "iterm2-inline" };
  }
  if (multiplexed) return cellSelection(terminal, capabilities);
  if (terminal === "ghostty" || terminal === "kitty") {
    if (capabilities?.kitty_graphics === false) return cellSelection(terminal, capabilities);
    return { name: "kitty", terminal, protocol: "kitty-unicode" };
  }
  if (terminal === "iterm2" || terminal === "wezterm") {
    return { name: "iterm2", terminal, protocol: "iterm2-inline" };
  }
  return cellSelection(terminal, capabilities);
}

function identifyTerminal(
  environment: MediaCapabilityEnvironment,
  capabilities?: TerminalCapabilities | null,
): MediaAdapterSelection["terminal"] {
  const program = environment.TERM_PROGRAM?.toLocaleLowerCase() ?? "";
  const term = [environment.TERM, capabilities?.terminal.name]
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .toLocaleLowerCase();
  if (program.includes("ghostty") || term.includes("ghostty")) return "ghostty";
  if (program === "kitty" || term.includes("kitty")) return "kitty";
  if (program.includes("wezterm")) return "wezterm";
  if (program === "iterm.app" || program.includes("iterm")) return "iterm2";
  return "generic";
}

function cellSelection(
  terminal: MediaAdapterSelection["terminal"],
  capabilities?: TerminalCapabilities | null,
): MediaAdapterSelection {
  if (capabilities?.rgb === false) {
    return unsupported("24-bit color media", terminal, capabilities.multiplexer !== "none");
  }
  return { name: "truecolor-cells", terminal, protocol: "truecolor-half-block" };
}

function unsupported(
  capability: string,
  terminal: MediaAdapterSelection["terminal"],
  multiplexed: boolean,
): never {
  throw new TermLoomError({
    code: "CAPABILITY_UNSUPPORTED",
    message: `${capability} is unavailable in ${multiplexed ? "the current multiplexer" : terminal}`,
    hint: "Use media.adapter = 'auto' or 'truecolor-cells', or run TermLoom directly.",
    details: { capability, terminal, multiplexed },
  });
}
