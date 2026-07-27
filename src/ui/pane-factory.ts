import { type CliRenderer, type Renderable, TextAttributes, TextRenderable } from "@opentui/core";
import type { ReconnectConfig } from "../config/schema.js";
import { RemoteTerminalRenderable } from "../connection/remote-terminal-renderable.js";
import { TermLoomError } from "../core/errors.js";
import type { I18n } from "../i18n/i18n.js";
import type { SshClient } from "../ssh/client.js";
import { PtyBackend } from "../terminal/pty-backend.js";
import { TerminalRenderable } from "../terminal/terminal-renderable.js";
import type { TmuxService } from "../tmux/tmux-service.js";
import type { PaneState } from "../workspace/schema.js";
import { theme } from "./theme.js";

export interface PaneViewFactory {
  create(pane: PaneState): Renderable;
}

export interface PaneServices {
  ssh: SshClient;
  tmux: TmuxService;
  reconnect: ReconnectConfig;
}

export class DefaultPaneViewFactory implements PaneViewFactory {
  public constructor(
    private readonly renderer: CliRenderer,
    private readonly i18n: I18n,
    private readonly services?: PaneServices,
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

    if (pane.kind === "terminal") {
      const hostId = pane.hostId;
      if (!hostId) throw new Error("Expected remote terminal host id");
      const services = this.requireRemoteServices(hostId);
      if (pane.tmuxSession) {
        return new RemoteTerminalRenderable(this.renderer, {
          id: `content-${pane.id}`,
          hostId,
          tmuxSession: pane.tmuxSession,
          cwd: pane.cwd,
          tmux: services.tmux,
          reconnect: services.reconnect,
          width: "100%",
          height: "100%",
        });
      }
      const backend = services.ssh.spawnTerminal(hostId);
      return new TerminalRenderable(this.renderer, {
        id: `content-${pane.id}`,
        backend,
        width: "100%",
        height: "100%",
      });
    }

    const label = pane.kind === "files" ? this.i18n.t("pane.files") : this.i18n.t("pane.preview");
    const content = `${label}\n${pane.hostId}:${pane.path}`;
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

  private requireRemoteServices(hostId: string): PaneServices {
    if (!this.services) {
      throw new TermLoomError({
        code: "DEPENDENCY_MISSING",
        message: `Remote services are unavailable for ${hostId}`,
        details: { hostId },
      });
    }
    this.services.ssh.host(hostId);
    return this.services;
  }
}
