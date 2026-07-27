import { describe, expect, test } from "bun:test";
import {
  ReconnectSession,
  type ConnectionPhase,
} from "../../../src/connection/reconnect-session.js";
import { MemoryTerminalBackend } from "../../../src/terminal/backend.js";

describe("ReconnectSession", () => {
  test("reattaches after abnormal exit and treats clean detach as intentional", async () => {
    const backends: MemoryTerminalBackend[] = [];
    const phases: ConnectionPhase[] = [];
    const session = new ReconnectSession(
      () => {
        const backend = new MemoryTerminalBackend();
        backends.push(backend);
        return backend;
      },
      { enabled: true, initialDelayMs: 5, maxDelayMs: 10, multiplier: 2, jitter: 0 },
      {
        onBackend: () => undefined,
        onState: (state) => phases.push(state.phase),
      },
    );
    session.start();
    backends[0]?.emitData("connected");
    expect(session.current.phase).toBe("connected");
    backends[0]?.emitExit({ exitCode: 255 });
    expect(session.current).toMatchObject({ phase: "reconnecting", attempt: 1, nextDelayMs: 5 });
    await waitUntil(() => backends.length === 2);
    backends[1]?.emitData("reattached");
    expect(session.current.phase).toBe("connected");
    backends[1]?.emitExit({ exitCode: 0 });
    expect(session.current.phase).toBe("detached");
    await Bun.sleep(15);
    expect(backends).toHaveLength(2);
    expect(phases).toContain("reconnecting");
    session.stop();
  });
});

async function waitUntil(predicate: () => boolean, timeoutMs = 250): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(2);
  }
  throw new Error("Timed out waiting for reconnect");
}
