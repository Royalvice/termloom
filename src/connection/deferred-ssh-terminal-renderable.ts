import { type KeyEvent, MouseButton, type MouseEvent, type RenderContext } from "@opentui/core";
import type { ReconnectConfig } from "../config/schema.js";
import { errorMessage } from "../core/errors.js";
import type { TerminalBackend } from "../terminal/backend.js";
import {
  TerminalRenderable,
  type TerminalRenderableOptions,
} from "../terminal/terminal-renderable.js";
import { type ConnectionState, ReconnectSession } from "./reconnect-session.js";

export interface DeferredSshTerminalOptions extends Omit<TerminalRenderableOptions, "backend"> {
  hostId: string;
  ssh: { spawnTerminal(hostId: string): TerminalBackend };
  connections: { ensureConnected(hostId: string): Promise<void> };
  reconnect: ReconnectConfig;
}

/** A Direct SSH pane with the same recoverable lifecycle as a remote tmux attachment. */
export class DeferredSshTerminalRenderable extends TerminalRenderable {
  private readonly session: ReconnectSession;
  private connectionState: ConnectionState = { phase: "idle", attempt: 0 };

  public constructor(ctx: RenderContext, options: DeferredSshTerminalOptions) {
    super(ctx, options);
    this.session = new ReconnectSession(
      () => options.ssh.spawnTerminal(options.hostId),
      options.reconnect,
      {
        beforeConnect: () => options.connections.ensureConnected(options.hostId),
        onBackend: (backend) => this.attachBackend(backend),
        onState: (state) => {
          this.connectionState = state;
          if (state.phase === "connecting") {
            void this.feed("\u001b[33m[TermLoom] Connecting through OpenSSH…\u001b[0m\r\n");
          } else if (state.phase === "reconnecting") {
            void this.feed(
              `\r\n\u001b[33m[TermLoom] Connection lost. Reconnecting (attempt ${state.attempt})…\u001b[0m\r\n`,
            );
          } else if (state.phase === "detached" && state.lastExit?.exitCode === 0) {
            void this.feed(
              "\r\n\u001b[33m[TermLoom] Session ended. Press Enter or click to reconnect.\u001b[0m\r\n",
            );
          }
        },
        onConnectError: (error) => {
          if (!this.isDestroyed) {
            void this.feed(`\r\n\u001b[31m[TermLoom] ${errorMessage(error)}\u001b[0m\r\n`);
          }
        },
      },
    );
    this.session.start();
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

  public override handleKeyPress(key: KeyEvent): boolean {
    if (
      key.eventType !== "release" &&
      this.connectionState.phase === "detached" &&
      (key.name === "return" || key.name === "enter")
    ) {
      this.reconnectNow();
      return true;
    }
    return super.handleKeyPress(key);
  }

  protected override onMouseEvent(event: MouseEvent): void {
    if (
      this.connectionState.phase === "detached" &&
      event.type === "down" &&
      event.button === MouseButton.LEFT
    ) {
      this.reconnectNow();
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    super.onMouseEvent(event);
  }

  protected override destroySelf(): void {
    this.session.stop();
    super.destroySelf();
  }
}
