export type ThemePreference = "system" | "dark" | "light";
export type ResolvedTheme = "dark" | "light";

export interface ThemePalette {
  background: string;
  surface: string;
  surfaceRaised: string;
  selection: string;
  foreground: string;
  muted: string;
  accent: string;
  accentSecondary: string;
  success: string;
  warning: string;
  error: string;
  border: string;
  activeBorder: string;
}

const darkTheme: ThemePalette = {
  background: "#11111b",
  surface: "#181825",
  surfaceRaised: "#1e1e2e",
  selection: "#313244",
  foreground: "#cdd6f4",
  muted: "#7f849c",
  accent: "#89b4fa",
  accentSecondary: "#cba6f7",
  success: "#a6e3a1",
  warning: "#f9e2af",
  error: "#f38ba8",
  border: "#45475a",
  activeBorder: "#89b4fa",
};

const lightTheme: ThemePalette = {
  background: "#eff1f5",
  surface: "#e6e9ef",
  surfaceRaised: "#dce0e8",
  selection: "#ccd0da",
  foreground: "#4c4f69",
  muted: "#6c6f85",
  accent: "#1e66f5",
  accentSecondary: "#8839ef",
  success: "#40a02b",
  warning: "#df8e1d",
  error: "#d20f39",
  border: "#9ca0b0",
  activeBorder: "#1e66f5",
};

export const theme: ThemePalette = { ...darkTheme };
let resolvedTheme: ResolvedTheme = "dark";

export function applyTheme(
  preference: ThemePreference,
  terminalTheme: ResolvedTheme | null | undefined,
): ResolvedTheme {
  resolvedTheme = preference === "system" ? (terminalTheme ?? "dark") : preference;
  Object.assign(theme, resolvedTheme === "light" ? lightTheme : darkTheme);
  return resolvedTheme;
}

export function currentTheme(): ResolvedTheme {
  return resolvedTheme;
}
