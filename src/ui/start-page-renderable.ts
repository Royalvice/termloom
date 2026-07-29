import {
  BoxRenderable,
  type KeyEvent,
  MouseButton,
  type RenderContext,
  TextAttributes,
  TextRenderable,
} from "@opentui/core";
import type { PaneState } from "../workspace/schema.js";
import { theme } from "./theme.js";

type StartPaneState = Extract<PaneState, { kind: "start" }>;

export interface StartPageOptions {
  id: string;
  pane: StartPaneState;
  onFocusHosts?: () => void;
}

export class StartPageRenderable extends BoxRenderable {
  private readonly onFocusHosts: (() => void) | undefined;

  public constructor(ctx: RenderContext, options: StartPageOptions) {
    super(ctx, {
      id: options.id,
      width: "100%",
      height: "100%",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      focusable: true,
      backgroundColor: theme.background,
    });
    this.onFocusHosts = options.onFocusHosts;
    this.add(
      new TextRenderable(ctx, {
        id: `${options.id}-title`,
        content: options.pane.surface === "files" ? "Files" : "Terminal",
        fg: theme.accent,
        attributes: TextAttributes.BOLD,
      }),
    );
    this.add(
      new TextRenderable(ctx, {
        id: `${options.id}-message`,
        marginTop: 1,
        content: "Select a Host from the left to begin.",
        fg: theme.foreground,
      }),
    );
    this.add(
      new TextRenderable(ctx, {
        id: `${options.id}-select-host`,
        marginTop: 1,
        content: " [ Select a Host ] ",
        fg: theme.background,
        bg: theme.accent,
        attributes: TextAttributes.BOLD,
        onMouseOver: () => ctx.setMousePointer("pointer"),
        onMouseOut: () => ctx.setMousePointer("default"),
        onMouseDown: (event) => {
          if (event.button !== MouseButton.LEFT) return;
          options.onFocusHosts?.();
          event.preventDefault();
          event.stopPropagation();
        },
      }),
    );
  }

  public override handleKeyPress(key: KeyEvent): boolean {
    if (key.eventType !== "release" && (key.name === "return" || key.name === "space")) {
      this.onFocusHosts?.();
      return true;
    }
    return false;
  }
}
