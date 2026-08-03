import { describe, expect, test } from "bun:test";
import { TransferQueue } from "../../../src/sftp/transfer-queue.js";

describe("TransferQueue", () => {
  test("reports progress and completes work", async () => {
    const queue = new TransferQueue({ concurrency: 1, progressIntervalMs: 0 });
    const states: string[] = [];
    queue.onChange((job) => states.push(`${job.status}:${job.progress.bytes}`));
    const handle = queue.enqueue(
      request("source", "destination"),
      async ({ report, setResolvedDestination }) => {
        setResolvedDestination("destination");
        report({ bytes: 5, totalBytes: 10 });
        report({ bytes: 10, totalBytes: 10 });
        return { resolvedDestination: "destination", skippedSymbolicLinks: 0 };
      },
    );
    await expect(handle.completion).resolves.toEqual({
      resolvedDestination: "destination",
      skippedSymbolicLinks: 0,
    });
    expect(queue.get(handle.id)?.status).toBe("completed");
    expect(states).toContain("running:0");
    expect(states).toContain("running:10");
  });

  test("cancels queued and running work", async () => {
    const queue = new TransferQueue(1);
    const first = queue.enqueue(
      request("one", "one"),
      ({ signal }) =>
        new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
    );
    await Bun.sleep(0);
    const second = queue.enqueue(request("two", "two"), async () => ({
      resolvedDestination: "two",
      skippedSymbolicLinks: 0,
    }));
    expect(second.cancel()).toBe(true);
    await expect(second.completion).rejects.toMatchObject({ code: "PROCESS_CANCELLED" });
    expect(queue.get(second.id)?.status).toBe("cancelled");
    first.cancel();
    await expect(first.completion).rejects.toMatchObject({ code: "PROCESS_CANCELLED" });
    expect(queue.get(first.id)?.status).toBe("cancelled");
  });

  test("filters by ownership and bounds completed history by count and TTL", async () => {
    let now = Date.parse("2026-08-03T00:00:00.000Z");
    const queue = new TransferQueue({
      concurrency: 1,
      historyLimit: 2,
      historyTtlMs: 30 * 60 * 1_000,
      now: () => now,
    });
    for (let index = 0; index < 3; index += 1) {
      const handle = queue.enqueue(
        { ...request(`remote-${index}`, `local-${index}`), ownerPaneId: `pane-${index}` },
        async () => ({ resolvedDestination: `local-${index}`, skippedSymbolicLinks: 0 }),
      );
      await handle.completion;
      now += 1_000;
    }
    expect(queue.list()).toHaveLength(2);
    expect(queue.list({ ownerPaneId: "pane-2" })).toHaveLength(1);
    expect(queue.list({ hostId: "other-host" })).toHaveLength(0);
    now += 31 * 60 * 1_000;
    expect(queue.list()).toHaveLength(0);
  });

  test("throttles progress emissions while always emitting terminal state", async () => {
    const queue = new TransferQueue({ concurrency: 1, progressIntervalMs: 100 });
    const states: string[] = [];
    queue.onChange((job) => states.push(`${job.status}:${job.progress.bytes}`));
    const handle = queue.enqueue(request("remote", "local"), async ({ report }) => {
      for (let bytes = 1; bytes <= 50; bytes += 1) report({ bytes, totalBytes: 50 });
      return { resolvedDestination: "local", skippedSymbolicLinks: 0 };
    });
    await handle.completion;
    expect(states.at(-1)).toBe("completed:50");
    expect(states.filter((state) => state.startsWith("running:")).length).toBeLessThanOrEqual(2);
  });
});

function request(remotePath: string, localDestination: string) {
  return {
    hostId: "host-a",
    remotePath,
    sourceKind: "file" as const,
    localDestination,
    ownerPaneId: "pane-a",
  };
}
