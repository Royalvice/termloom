import { describe, expect, test } from "bun:test";
import type { SshClient } from "../../../src/ssh/client.js";
import { HostConnectionCoordinator } from "../../../src/ssh/connection-coordinator.js";

describe("HostConnectionCoordinator", () => {
  test("does not rebroadcast connected while reusing a known healthy ControlMaster", async () => {
    const calls = { resolve: 0, check: 0, spawn: 0 };
    const ssh = {
      async resolveHost() {
        calls.resolve += 1;
        return {};
      },
      async checkMaster() {
        calls.check += 1;
        return true;
      },
      spawnMaster() {
        calls.spawn += 1;
        throw new Error("A healthy ControlMaster must not start authentication");
      },
    } as unknown as SshClient;
    const coordinator = new HostConnectionCoordinator(ssh);
    const statuses: string[] = [];
    coordinator.onChange((event) => statuses.push(event.status));

    await coordinator.ensureConnected("fixture");
    expect(statuses).toEqual(["resolving", "connected"]);

    await coordinator.ensureConnected("fixture");
    expect(statuses).toEqual(["resolving", "connected"]);
    expect(calls).toEqual({ resolve: 2, check: 2, spawn: 0 });
  });
});
