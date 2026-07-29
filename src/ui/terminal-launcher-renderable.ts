import {
  BoxRenderable,
  type CliRenderer,
  type KeyEvent,
  MouseButton,
  TextAttributes,
  TextRenderable,
} from "@opentui/core";
import type { PaneState } from "../workspace/schema.js";
import { theme } from "./theme.js";

type TerminalLauncherPaneState = Extract<PaneState, { kind: "terminal-launcher" }>;

export interface TerminalLauncherOptions {
  id: string;
  pane: TerminalLauncherPaneState;
  onDirectSsh: (pane: TerminalLauncherPaneState) => void;
  onTmux: (pane: TerminalLauncherPaneState) => void;
}

export class TerminalLauncherRenderable extends BoxRenderable {
  private selected: "direct" | "tmux" = "direct";
  private readonly direct: TextRenderable;
  private readonly tmux: TextRenderable;

  public constructor(
    renderer: CliRenderer,
    private readonly optionsValue: TerminalLauncherOptions,
  ) {
    super(renderer, {
      id: optionsValue.id,
      width: "100%",
      height: "100%",
      flexDirection: "column",
      justifyContent: "center",
      alignItems: "center",
      gap: 1,
      focusable: true,
      backgroundColor: theme.background,
    });
    this.add(
      new TextRenderable(renderer, {
        id: `${optionsValue.id}-title`,
        content: "Choose how to open this host",
        fg: theme.foreground,
        attributes: TextAttributes.BOLD,
      }),
    );
    this.add(
      new TextRenderable(renderer, {
        id: `${optionsValue.id}-hint`,
        content: "Files stay connected independently from the terminal.",
        fg: theme.muted,
      }),
    );
    this.direct = this.button(
      renderer,
      "direct",
      "  Direct SSH  ·  Open a normal remote shell  ",
      () => optionsValue.onDirectSsh(optionsValue.pane),
    );
    this.tmux = this.button(
      renderer,
      "tmux",
      "  Tmux  ·  Choose or create a persistent session  ",
      () => optionsValue.onTmux(optionsValue.pane),
    );
    this.add(this.direct);
    this.add(this.tmux);
    this.updateSelection();
  }

  public override handleKeyPress(key: KeyEvent): boolean {
    if (key.eventType === "release" || key.ctrl || key.meta || key.super) return false;
    if (key.name === "up" || key.name === "down" || key.name === "tab") {
      this.selected = this.selected === "direct" ? "tmux" : "direct";
      this.updateSelection();
      return true;
    }
    if (key.name === "return") {
      if (this.selected === "direct") this.optionsValue.onDirectSsh(this.optionsValue.pane);
      else this.optionsValue.onTmux(this.optionsValue.pane);
      return true;
    }
    if (key.name === "1") {
      this.optionsValue.onDirectSsh(this.optionsValue.pane);
      return true;
    }
    if (key.name === "2") {
      this.optionsValue.onTmux(this.optionsValue.pane);
      return true;
    }
    return false;
  }

  public refreshAppearance(): void {
    this.backgroundColor = theme.background;
    this.updateSelection();
  }

  private button(
    renderer: CliRenderer,
    name: "direct" | "tmux",
    label: string,
    activate: () => void,
  ): TextRenderable {
    return new TextRenderable(renderer, {
      id: `${this.id}-${name}`,
      width: "100%",
      maxWidth: 52,
      height: 3,
      content: `\n${label}`,
      fg: theme.foreground,
      bg: theme.surface,
      onMouseOver: () => {
        this.selected = name;
        this.updateSelection();
        renderer.setMousePointer("pointer");
      },
      onMouseOut: () => renderer.setMousePointer("default"),
      onMouseDown: (event) => {
        if (event.button !== MouseButton.LEFT) return;
        this.selected = name;
        this.updateSelection();
        activate();
        event.preventDefault();
        event.stopPropagation();
      },
    });
  }

  private updateSelection(): void {
    this.direct.bg = this.selected === "direct" ? theme.selection : theme.surface;
    this.direct.fg = this.selected === "direct" ? theme.accent : theme.foreground;
    this.tmux.bg = this.selected === "tmux" ? theme.selection : theme.surface;
    this.tmux.fg = this.selected === "tmux" ? theme.accent : theme.foreground;
    this.requestRender();
  }
}
