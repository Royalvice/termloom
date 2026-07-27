import { type CliRenderer, type Renderable, TextAttributes, TextRenderable } from "@opentui/core";
import type { I18n } from "../i18n/i18n.js";
import { PtyBackend } from "../terminal/pty-backend.js";
import { TerminalRenderable } from "../terminal/terminal-renderable.js";
import type { PaneState } from "../workspace/schema.js";
import { theme } from "./theme.js";

export interface PaneViewFactory {
  create(pane: PaneState): Renderable;
}

export class DefaultPaneViewFactory implements PaneViewFactory {
  public constructor(
    private readonly renderer: CliRenderer,
    private readonly i18n: I18n,
  ) {}

  public create(pane: PaneState): Renderable {
    if (pane.kind === "terminal" && !pane.hostId) {
      const { SHELL: configuredShell } = process.env;
      const backend = PtyBackend.spawn(configuredShell ?? "/bin/zsh", ["-l"]);
      return new TerminalRenderable(this.renderer, {
        id: `content-${pane.id}`,
        backend,
        width: "100%",
        height: "100%",
      });
    }

    const content =
      pane.kind === "terminal"
        ? `${this.i18n.t("status.connecting")} — ${pane.hostId ?? "local"}`
        : pane.kind === "files"
          ? `${pane.hostId}:${pane.path}`
          : `${pane.hostId}:${pane.path}`;
    return new TextRenderable(this.renderer, {
      id: `content-${pane.id}`,
      content,
      fg: theme.muted,
      attributes: TextAttributes.DIM,
      width: "100%",
      height: "100%",
      selectable: true,
    });
  }
}
