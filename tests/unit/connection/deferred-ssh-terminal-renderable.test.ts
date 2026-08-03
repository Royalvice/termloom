import { afterEach, describe, expect, test } from "bun:test";
import { MouseButtons, createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import type { ReconnectConfig } from "../../../src/config/schema.js";
import { DeferredSshTerminalRenderable } from "../../../src/connection/deferred-ssh-terminal-renderable.js";
import { MemoryTerminalBackend } from "../../../src/terminal/backend.js";

let setup: TestRendererSetup | undefined;

afterEach(() => {
  setup?.renderer.destroy();
  setup = undefined;
});

const reconnect: ReconnectConfig = {
  enabled: true,
  initialDelayMs: 5,
  maxDelayMs: 10,
  multiplier: 2,
  jitter: 0,
};

describe("DeferredSshTerminalRenderable", () => {
  test("reconnects Direct SSH after an abnormal exit only after confirming its ControlMaster", async () => {
    const connections = new ConnectionStub();
    const backends: MemoryTerminalBackend[] = [];
    const terminal = await createTerminal(backends, connections);
    await waitUntil(() => backends.length === 1);
    backends[0]?.emitData("connected");
    expect(terminal.connection.phase).toBe("connected");

    backends[0]?.emitExit({ exitCode: 255 });
    expect(terminal.connection).toMatchObject({ phase: "reconnecting", attempt: 1 });
    await waitUntil(() => backends.length === 2);
    expect(connections.hostIds).toEqual(["fixture", "fixture"]);
    backends[1]?.emitData("reconnected");
    expect(terminal.connection.phase).toBe("connected");
  });

  test("keeps a clean Direct SSH exit detached until Enter or click requests reconnect", async () => {
    const connections = new ConnectionStub();
    const backends: MemoryTerminalBackend[] = [];
    const terminal = await createTerminal(backends, connections);
    await waitUntil(() => backends.length === 1);
    backends[0]?.emitData("connected");
    backends[0]?.emitExit({ exitCode: 0 });
    expect(terminal.connection.phase).toBe("detached");
    await waitUntil(() => terminalText(terminal).includes("Session ended"));
    await Bun.sleep(20);
    expect(backends).toHaveLength(1);

    terminal.handleKeyPress({
      name: "return",
      sequence: "\r",
      ctrl: false,
      shift: false,
      meta: false,
      option: false,
      super: false,
      hyper: false,
      eventType: "press",
      repeated: false,
      source: "raw",
    } as Parameters<DeferredSshTerminalRenderable["handleKeyPress"]>[0]);
    await waitUntil(() => backends.length === 2);
    backends[1]?.emitData("manual reconnect");
    backends[1]?.emitExit({ exitCode: 0 });
    await setup?.mockMouse.click(terminal.screenX, terminal.screenY, MouseButtons.LEFT);
    await waitUntil(() => backends.length === 3);
  });

  test("drops a delayed ControlMaster result after the Direct SSH pane is destroyed", async () => {
    let resolveConnection: (() => void) | undefined;
    const connections = {
      ensureConnected: () =>
        new Promise<void>((resolve) => {
          resolveConnection = resolve;
        }),
    };
    const backends: MemoryTerminalBackend[] = [];
    const terminal = await createTerminal(backends, connections);
    terminal.destroyRecursively();
    resolveConnection?.();
    await Bun.sleep(10);
    expect(backends).toHaveLength(0);
  });
});

async function createTerminal(
  backends: MemoryTerminalBackend[],
  connections: { ensureConnected(hostId: string): Promise<void> },
): Promise<DeferredSshTerminalRenderable> {
  setup = await createTestRenderer({ width: 80, height: 8 });
  const terminal = new DeferredSshTerminalRenderable(setup.renderer, {
    id: "direct-ssh",
    hostId: "fixture",
    ssh: {
      spawnTerminal: () => {
        const backend = new MemoryTerminalBackend();
        backends.push(backend);
        return backend;
      },
    },
    connections,
    reconnect,
    width: "100%",
    height: "100%",
  });
  setup.renderer.root.add(terminal);
  terminal.focus();
  await setup.renderOnce();
  return terminal;
}

class ConnectionStub {
  public readonly hostIds: string[] = [];

  public async ensureConnected(hostId: string): Promise<void> {
    this.hostIds.push(hostId);
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 250): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(2);
  }
  throw new Error("Timed out waiting for expected Direct SSH state");
}

function terminalText(terminal: DeferredSshTerminalRenderable): string {
  const buffer = terminal.terminal.buffer.active;
  return Array.from(
    { length: buffer.length },
    (_, index) => buffer.getLine(index)?.translateToString(true) ?? "",
  ).join("\n");
}
