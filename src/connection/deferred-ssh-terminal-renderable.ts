import type { RenderContext } from "@opentui/core";
import { errorMessage } from "../core/errors.js";
import type { SshClient } from "../ssh/client.js";
import type { HostConnectionCoordinator } from "../ssh/connection-coordinator.js";
import {
  TerminalRenderable,
  type TerminalRenderableOptions,
} from "../terminal/terminal-renderable.js";

export interface DeferredSshTerminalOptions extends Omit<TerminalRenderableOptions, "backend"> {
  hostId: string;
  ssh: SshClient;
  connections: HostConnectionCoordinator;
}

export class DeferredSshTerminalRenderable extends TerminalRenderable {
  private cancelled = false;

  public constructor(ctx: RenderContext, options: DeferredSshTerminalOptions) {
    super(ctx, options);
    void this.feed("\u001b[33m[TermLoom] Connecting through OpenSSH…\u001b[0m\r\n");
    void options.connections
      .ensureConnected(options.hostId)
      .then(() => {
        if (this.cancelled || this.isDestroyed) return;
        this.attachBackend(options.ssh.spawnTerminal(options.hostId));
      })
      .catch((error) => {
        if (this.cancelled || this.isDestroyed) return;
        void this.feed(`\u001b[31m[TermLoom] ${errorMessage(error)}\u001b[0m\r\n`);
      });
  }

  protected override destroySelf(): void {
    this.cancelled = true;
    super.destroySelf();
  }
}
