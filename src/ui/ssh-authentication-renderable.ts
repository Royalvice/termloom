import {
  BoxRenderable,
  MouseButton,
  type RenderContext,
  TextAttributes,
  TextRenderable,
} from "@opentui/core";
import type { PtyBackend } from "../terminal/pty-backend.js";
import { TerminalRenderable } from "../terminal/terminal-renderable.js";
import { theme } from "./theme.js";

export interface SshAuthenticationOptions {
  id: string;
  hostLabel: string;
  backend: PtyBackend;
  onRetry: () => void;
  onCancel: () => void;
}

export class SshAuthenticationRenderable extends BoxRenderable {
  private readonly status: TextRenderable;

  public constructor(ctx: RenderContext, options: SshAuthenticationOptions) {
    super(ctx, {
      id: options.id,
      position: "absolute",
      left: 0,
      top: 0,
      width: "100%",
      height: "100%",
      zIndex: 200,
      border: true,
      borderStyle: "double",
      borderColor: theme.accent,
      title: ` SSH · ${options.hostLabel} `,
      flexDirection: "column",
      backgroundColor: theme.background,
    });
    this.status = new TextRenderable(ctx, {
      id: `${options.id}-status`,
      width: "100%",
      height: 2,
      content: "Complete the OpenSSH prompt below. Credentials are never saved by TermLoom.",
      fg: theme.warning,
      attributes: TextAttributes.BOLD,
    });
    this.add(this.status);
    const terminal = new TerminalRenderable(ctx, {
      id: `${options.id}-terminal`,
      backend: options.backend,
      width: "100%",
      flexGrow: 1,
    });
    this.add(terminal);
    const buttons = new BoxRenderable(ctx, {
      id: `${options.id}-buttons`,
      height: 1,
      width: "100%",
      flexDirection: "row",
      backgroundColor: theme.surfaceRaised,
    });
    buttons.add(button(ctx, `${options.id}-retry`, " Retry ", options.onRetry));
    buttons.add(button(ctx, `${options.id}-cancel`, " Cancel ", options.onCancel));
    this.add(buttons);
    terminal.focus();
  }

  public setError(message: string): void {
    this.status.content = `${message} · Retry or Cancel`;
    this.status.fg = theme.error;
    this.requestRender();
  }
}

function button(ctx: RenderContext, id: string, label: string, run: () => void): TextRenderable {
  return new TextRenderable(ctx, {
    id,
    content: label,
    fg: theme.background,
    bg: theme.accent,
    attributes: TextAttributes.BOLD,
    onMouseOver: () => ctx.setMousePointer("pointer"),
    onMouseOut: () => ctx.setMousePointer("default"),
    onMouseDown: (event) => {
      if (event.button !== MouseButton.LEFT) return;
      run();
      event.preventDefault();
      event.stopPropagation();
    },
  });
}
