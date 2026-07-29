import { type CliRenderer, type Renderable, TextRenderable } from "@opentui/core";
import type { ReconnectConfig } from "../config/schema.js";
import { DeferredSshTerminalRenderable } from "../connection/deferred-ssh-terminal-renderable.js";
import { RemoteTerminalRenderable } from "../connection/remote-terminal-renderable.js";
import { errorMessage, TermLoomError } from "../core/errors.js";
import type { FileProvider } from "../files/file-provider.js";
import type { FileProviderRouter } from "../files/file-provider-router.js";
import type { ContextMenuRequest } from "./dismissible-overlay-controller.js";
import type { I18n } from "../i18n/i18n.js";
import type { SshClient } from "../ssh/client.js";
import type { HostConnectionCoordinator } from "../ssh/connection-coordinator.js";
import { PtyBackend } from "../terminal/pty-backend.js";
import { TerminalRenderable } from "../terminal/terminal-renderable.js";
import type { TmuxService } from "../tmux/tmux-service.js";
import type { PaneState } from "../workspace/schema.js";
import { FileBrowserRenderable } from "./file-browser-renderable.js";
import { RichDocumentRenderable, type RichDocumentServices } from "./rich-document-renderable.js";
import { SessionPickerRenderable } from "./session-picker-renderable.js";
import { MissingHostRenderable } from "./missing-host-renderable.js";
import { StartPageRenderable } from "./start-page-renderable.js";
import { TerminalLauncherRenderable } from "./terminal-launcher-renderable.js";
import { theme } from "./theme.js";

export interface PaneViewFactory {
  create(pane: PaneState): Renderable;
  updateRuntimeConfig?(reconnect: ReconnectConfig, preview?: RichDocumentServices): void;
}

export interface PaneServices {
  ssh: SshClient;
  tmux: TmuxService;
  reconnect: ReconnectConfig;
  files: FileProviderRouter;
  preview?: RichDocumentServices;
  previewError?: unknown;
  connections?: HostConnectionCoordinator;
  hostDefaultPath?: (hostId: string) => string;
  hostDefaultSession?: (hostId: string) => string | undefined;
  hostProfile?: (
    hostId: string,
  ) => { alias: string; source: "ssh-config" | "manual" | "missing" } | undefined;
}

export interface PaneCallbacks {
  onPaneUpdate?(pane: PaneState): void;
  onOpenPreview?(
    pane: Extract<PaneState, { kind: "files" }>,
    entry: { name: string; path: string },
  ): void;
  onContextMenu?(request: ContextMenuRequest, restoreFocus: () => void): void;
  onFocusHosts?(): void;
  onAttachSession?(
    pane: Extract<PaneState, { kind: "session-picker" }>,
    session: import("../tmux/tmux-service.js").TmuxSessionInfo,
    inSplit: boolean,
  ): void;
  onRawShell?(pane: Extract<PaneState, { kind: "session-picker" }>, inSplit: boolean): void;
  onDirectSsh?(pane: Extract<PaneState, { kind: "terminal-launcher" }>): void;
  onSelectTmux?(pane: Extract<PaneState, { kind: "terminal-launcher" }>): void;
}

export class DefaultPaneViewFactory implements PaneViewFactory {
  public constructor(
    private readonly renderer: CliRenderer,
    private readonly i18n: I18n,
    private readonly services?: PaneServices,
    private readonly callbacks: PaneCallbacks = {},
  ) {}

  public updateRuntimeConfig(reconnect: ReconnectConfig, preview?: RichDocumentServices): void {
    if (!this.services) return;
    this.services.reconnect = structuredClone(reconnect);
    if (preview) this.services.preview = preview;
  }

  public create(pane: PaneState): Renderable {
    const remoteHostId = pane.target.kind === "ssh" ? pane.target.hostId : undefined;
    const profile = remoteHostId ? this.services?.hostProfile?.(remoteHostId) : undefined;
    if (
      remoteHostId &&
      (profile?.source === "missing" || !this.services?.ssh.hasHost(remoteHostId))
    ) {
      return new MissingHostRenderable(this.renderer, {
        id: `content-${pane.id}`,
        alias: profile?.alias ?? remoteHostId,
        onRemap: () => this.callbacks.onFocusHosts?.(),
      });
    }

    if (pane.kind === "terminal" && pane.target.kind === "local") {
      const { SHELL: configuredShell } = process.env;
      const backend = PtyBackend.spawn(configuredShell ?? "/bin/zsh", ["-l"], {
        cwd: pane.cwd,
      });
      return new TerminalRenderable(this.renderer, {
        id: `content-${pane.id}`,
        backend,
        width: "100%",
        height: "100%",
      });
    }

    if (pane.kind === "terminal") {
      if (pane.target.kind !== "ssh") throw new Error("Expected an SSH terminal target");
      const hostId = pane.target.hostId;
      const services = this.requireRemoteServices(hostId);
      if (pane.tmuxSession) {
        return new RemoteTerminalRenderable(this.renderer, {
          id: `content-${pane.id}`,
          hostId,
          tmuxSession: pane.tmuxSession,
          cwd: pane.cwd,
          tmux: services.tmux,
          reconnect: services.reconnect,
          connections: services.connections,
          width: "100%",
          height: "100%",
        });
      }
      if (services.connections) {
        return new DeferredSshTerminalRenderable(this.renderer, {
          id: `content-${pane.id}`,
          hostId,
          ssh: services.ssh,
          connections: services.connections,
          width: "100%",
          height: "100%",
        });
      }
      return new TerminalRenderable(this.renderer, {
        id: `content-${pane.id}`,
        backend: services.ssh.spawnTerminal(hostId),
        width: "100%",
        height: "100%",
      });
    }

    if (pane.kind === "files") {
      let provider: FileProvider | undefined;
      try {
        provider = this.services?.files.forTarget(pane.target);
      } catch (error) {
        return new TextRenderable(this.renderer, {
          id: `content-${pane.id}`,
          content: errorMessage(error),
          fg: theme.error,
          width: "100%",
          height: "100%",
          selectable: true,
        });
      }
      if (!provider) throw new Error("File provider router is unavailable");
      return new FileBrowserRenderable(this.renderer, {
        id: `content-${pane.id}`,
        pane,
        provider,
        i18n: this.i18n,
        preview: this.services?.preview,
        onPaneUpdate: (updated) => this.callbacks.onPaneUpdate?.(updated),
        onOpenPreview: (filesPane, entry) => this.callbacks.onOpenPreview?.(filesPane, entry),
        onContextMenu: (request, restoreFocus) =>
          this.callbacks.onContextMenu?.(request, restoreFocus),
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

    if (pane.kind === "start") {
      return new StartPageRenderable(this.renderer, {
        id: `content-${pane.id}`,
        pane,
        onFocusHosts: () => this.callbacks.onFocusHosts?.(),
      });
    }

    if (pane.kind === "session-picker") {
      const hostId = pane.target.hostId;
      const services = this.requireRemoteServices(hostId);
      return new SessionPickerRenderable(this.renderer, {
        id: `content-${pane.id}`,
        pane,
        service: services.tmux,
        defaultPath: services.hostDefaultPath?.(hostId),
        defaultSession: services.hostDefaultSession?.(hostId),
        onAttach: (picker, session, inSplit) =>
          this.callbacks.onAttachSession?.(picker, session, inSplit),
        onRawShell: (picker, inSplit) => this.callbacks.onRawShell?.(picker, inSplit),
        onContextMenu: (request, restoreFocus) =>
          this.callbacks.onContextMenu?.(request, restoreFocus),
      });
    }

    if (pane.kind === "terminal-launcher") {
      this.requireRemoteServices(pane.target.hostId);
      return new TerminalLauncherRenderable(this.renderer, {
        id: `content-${pane.id}`,
        pane,
        onDirectSsh: (launcher) => this.callbacks.onDirectSsh?.(launcher),
        onTmux: (launcher) => this.callbacks.onSelectTmux?.(launcher),
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
    if (!this.services.ssh.hasHost(hostId)) {
      throw new TermLoomError({
        code: "SSH_HOST_UNKNOWN",
        message: `Unknown SSH host: ${hostId}`,
        details: { hostId },
      });
    }
    return this.services;
  }
}

function assertUnreachable(value: never): never {
  throw new Error(`Unsupported pane state: ${JSON.stringify(value)}`);
}
