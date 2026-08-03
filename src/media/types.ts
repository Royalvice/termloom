export type MediaAdapterName = "kitty" | "iterm2" | "truecolor-cells";

export interface RgbFrame {
  width: number;
  height: number;
  rgb: Uint8Array;
  timestampSeconds?: number;
}

export interface MediaOutput {
  write(chunk: string): boolean;
  once(event: "drain", listener: () => void): unknown;
  off?(event: "drain", listener: () => void): unknown;
}

export interface MediaAdapterSelection {
  name: MediaAdapterName;
  terminal: "ghostty" | "kitty" | "wezterm" | "iterm2" | "generic";
  protocol: "kitty-unicode" | "iterm2-inline" | "truecolor-half-block";
}
