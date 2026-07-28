import { type CliRenderer, type Renderable, TextRenderable } from "@opentui/core";
import type { ReconnectConfig } from "../config/schema.js";
import { RemoteTerminalRenderable } from "../connection/remote-terminal-renderable.js";
import { errorMessage, TermLoomError } from "../core/errors.js";
import type { I18n } from "../i18n/i18n.js";
import type { FileBrowserService } from "./file-browser-renderable.js";
import type { SshClient } from "../ssh/client.js";
import { PtyBackend } from "../terminal/pty-backend.js";
import { TerminalRenderable } from "../terminal/terminal-renderable.js";
import type { TmuxService } from "../tmux/tmux-service.js";
import type { PaneState } from "../workspace/schema.js";
import { FileBrowserRenderable } from "./file-browser-renderable.js";
import { RichDocumentRenderable, type RichDocumentServices } from "./rich-document-renderable.js";
import { theme } from "./theme.js";

export interface PaneViewFactory {
  create(pane: PaneState): Renderable;
}

export interface PaneServices {
  ssh: SshClient;
  tmux: TmuxService;
  reconnect: ReconnectConfig;
  sftp?: FileBrowserService;
  preview?: RichDocumentServices;
  previewError?: unknown;
}

export interface PaneCallbacks {
  onPaneUpdate?(pane: PaneState): void;
  onOpenPreview?(
    pane: Extract<PaneState, { kind: "files" }>,
    entry: { name: string; path: string },
  ): void;
}

export class DefaultPaneViewFactory implements PaneViewFactory {
  public constructor(
    private readonly renderer: CliRenderer,
    private readonly i18n: I18n,
    private readonly services?: PaneServices,
    private readonly callbacks: PaneCallbacks = {},
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

    if (pane.kind === "files") {
      const service = this.services?.sftp;
      if (!service) {
        return new TextRenderable(this.renderer, {
          id: `content-${pane.id}`,
          content: this.i18n.t("error.missingDependency", { dependency: "rclone" }),
          fg: theme.error,
          width: "100%",
          height: "100%",
          selectable: true,
        });
      }
      return new FileBrowserRenderable(this.renderer, {
        id: `content-${pane.id}`,
        pane,
        service,
        i18n: this.i18n,
        onPaneUpdate: (updated) => this.callbacks.onPaneUpdate?.(updated),
        onOpenPreview: (filesPane, entry) => this.callbacks.onOpenPreview?.(filesPane, entry),
      });
    }

    if (pane.kind === "preview") {
      const preview = this.services?.preview;
      if (!preview) {
        const message = this.services?.previewError
          ? errorMessage(this.services.previewError)
          : "Preview services are unavailable";
        return new TextRenderable(this.renderer, {
          id: `content-${pane.id}`,
          content: this.i18n.t("preview.error", { message }),
          fg: theme.error,
          width: "100%",
          height: "100%",
          selectable: true,
        });
      }
      return new RichDocumentRenderable(this.renderer, {
        id: `content-${pane.id}`,
        pane,
        i18n: this.i18n,
        onPaneUpdate: (updated) => this.callbacks.onPaneUpdate?.(updated),
        ...preview,
      });
    }

    return assertUnreachable(pane);
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

function assertUnreachable(value: never): never {
  throw new Error(`Unsupported pane state: ${JSON.stringify(value)}`);
}
