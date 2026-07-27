import { describe, expect, test } from "bun:test";
import { TransferQueue } from "../../../src/sftp/transfer-queue.js";

describe("TransferQueue", () => {
  test("reports progress and completes work", async () => {
    const queue = new TransferQueue(1);
    const states: string[] = [];
    queue.onChange((job) => states.push(`${job.status}:${job.progress.bytes}`));
    const handle = queue.enqueue(
      { direction: "upload", source: "source", destination: "destination" },
      async ({ report }) => {
        report({ bytes: 5, totalBytes: 10 });
        report({ bytes: 10, totalBytes: 10 });
        return { destination: "destination" };
      },
    );
    await expect(handle.completion).resolves.toEqual({ destination: "destination" });
    expect(queue.get(handle.id)?.status).toBe("completed");
    expect(states).toContain("running:0");
    expect(states).toContain("running:10");
  });

  test("cancels queued and running work", async () => {
    const queue = new TransferQueue(1);
    const first = queue.enqueue(
      { direction: "download", source: "one", destination: "one" },
      ({ signal }) =>
        new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
    );
    await Bun.sleep(0);
    const second = queue.enqueue(
      { direction: "download", source: "two", destination: "two" },
      async () => ({ destination: "two" }),
    );
    expect(second.cancel()).toBe(true);
    await expect(second.completion).rejects.toMatchObject({ code: "PROCESS_CANCELLED" });
    expect(queue.get(second.id)?.status).toBe("cancelled");
    first.cancel();
    await expect(first.completion).rejects.toMatchObject({ code: "PROCESS_CANCELLED" });
    expect(queue.get(first.id)?.status).toBe("cancelled");
  });
});
