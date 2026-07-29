import {
  BoxRenderable,
  type KeyEvent,
  MouseButton,
  type RenderContext,
  TextAttributes,
  TextRenderable,
} from "@opentui/core";
import { theme } from "./theme.js";

export interface MissingHostOptions {
  id: string;
  alias: string;
  onRemap?: () => void;
}

export class MissingHostRenderable extends BoxRenderable {
  private readonly onRemap: (() => void) | undefined;

  public constructor(ctx: RenderContext, options: MissingHostOptions) {
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
    this.onRemap = options.onRemap;
    this.add(
      new TextRenderable(ctx, {
        id: `${options.id}-title`,
        content: "SSH alias missing",
        fg: theme.error,
        attributes: TextAttributes.BOLD,
      }),
    );
    this.add(
      new TextRenderable(ctx, {
        id: `${options.id}-message`,
        marginTop: 1,
        content: `The saved workspace refers to '${options.alias}', which is no longer available.`,
        fg: theme.foreground,
      }),
    );
    this.add(
      new TextRenderable(ctx, {
        id: `${options.id}-remap`,
        marginTop: 1,
        content: " [ Remap SSH alias ] ",
        fg: theme.background,
        bg: theme.accent,
        attributes: TextAttributes.BOLD,
        onMouseOver: () => ctx.setMousePointer("pointer"),
        onMouseOut: () => ctx.setMousePointer("default"),
        onMouseDown: (event) => {
          if (event.button !== MouseButton.LEFT) return;
          this.onRemap?.();
          event.preventDefault();
          event.stopPropagation();
        },
      }),
    );
  }

  public override handleKeyPress(key: KeyEvent): boolean {
    if (key.eventType !== "release" && (key.name === "return" || key.name === "space")) {
      this.onRemap?.();
      return true;
    }
    return false;
  }
}
