import type { RenderContext } from "@opentui/core";
import type { ReconnectConfig } from "../config/schema.js";
import { errorMessage } from "../core/errors.js";
import type { HostConnectionCoordinator } from "../ssh/connection-coordinator.js";
import {
  TerminalRenderable,
  type TerminalRenderableOptions,
} from "../terminal/terminal-renderable.js";
import type { TmuxService } from "../tmux/tmux-service.js";
import { type ConnectionState, ReconnectSession } from "./reconnect-session.js";

export interface RemoteTerminalRenderableOptions
  extends Omit<TerminalRenderableOptions, "backend"> {
  hostId: string;
  tmuxSession: string;
  cwd?: string;
  tmux: TmuxService;
  reconnect: ReconnectConfig;
  connections?: HostConnectionCoordinator;
  onConnectionState?: (state: ConnectionState) => void;
}

export class RemoteTerminalRenderable extends TerminalRenderable {
  private readonly session: ReconnectSession;
  private connectionState: ConnectionState = { phase: "idle", attempt: 0 };

  public constructor(ctx: RenderContext, options: RemoteTerminalRenderableOptions) {
    super(ctx, options);
    this.session = new ReconnectSession(
      () => options.tmux.attachBackend(options.hostId, options.tmuxSession, options.cwd),
      options.reconnect,
      {
        onBackend: (backend) => this.attachBackend(backend),
        onState: (state) => {
          this.connectionState = state;
          options.onConnectionState?.(state);
          if (state.phase === "reconnecting") {
            void this.feed(
              `\r\n\u001b[33m[TermLoom] Reconnecting (attempt ${state.attempt})...\u001b[0m\r\n`,
            );
            if (options.connections) {
              void options.connections
                .ensureConnected(options.hostId)
                .then(() => {
                  if (!this.isDestroyed && this.connectionState.phase === "reconnecting") {
                    this.session.reconnectNow();
                  }
                })
                .catch(() => undefined);
            }
          } else if (state.phase === "detached" && state.lastExit?.exitCode !== 0) {
            void this.feed("\r\n\u001b[31m[TermLoom] Connection closed.\u001b[0m\r\n");
          }
        },
      },
    );
    if (options.connections) {
      void options.connections
        .ensureConnected(options.hostId)
        .then(() => {
          if (!this.isDestroyed) this.session.start();
        })
        .catch((error) => {
          void this.feed(`\r\n\u001b[31m[TermLoom] ${errorMessage(error)}\u001b[0m\r\n`);
        });
    } else {
      this.session.start();
    }
  }

  public get connection(): ConnectionState {
    return this.connectionState;
  }

  public reconnectNow(): void {
    this.session.reconnectNow();
  }

  public updateReconnectConfig(config: ReconnectConfig): void {
    this.session.updateConfig(config);
  }

  protected override destroySelf(): void {
    this.session.stop();
    super.destroySelf();
  }
}
