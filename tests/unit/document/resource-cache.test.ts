import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResourceCache } from "../../../src/document/resource-cache.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("ResourceCache shared producers", () => {
  test("keeps the producer alive when one of two consumers cancels", async () => {
    const directory = await temporaryDirectory();
    const cache = new ResourceCache(directory, 1024 * 1024);
    let writes = 0;
    let producerSignal: AbortSignal | undefined;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const write = async (path: string, signal: AbortSignal) => {
      writes += 1;
      producerSignal = signal;
      await gate;
      signal.throwIfAborted();
      await writeFile(path, "shared", { mode: 0o600 });
    };
    const firstController = new AbortController();
    const secondController = new AbortController();

    const first = cache.materialize("shared", ".bin", write, {
      signal: firstController.signal,
    });
    const second = cache.materialize("shared", ".bin", write, {
      signal: secondController.signal,
    });
    await waitUntil(() => producerSignal !== undefined);
    firstController.abort(new DOMException("first cancelled", "AbortError"));

    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    expect(producerSignal?.aborted).toBe(false);
    release?.();
    expect((await second).cacheHit).toBe(false);
    expect(writes).toBe(1);
  });

  test("aborts the producer and removes its partial after the last consumer cancels", async () => {
    const directory = await temporaryDirectory();
    const cache = new ResourceCache(directory, 1024 * 1024);
    let producerAborted = false;
    let started = false;
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    const write = async (path: string, signal: AbortSignal) => {
      started = true;
      await writeFile(path, "partial", { mode: 0o600 });
      await new Promise<void>((_resolve, reject) => {
        const onAbort = () => {
          producerAborted = true;
          reject(signal.reason);
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      });
    };
    const firstController = new AbortController();
    const secondController = new AbortController();
    try {
      const first = cache.materialize("cancel-all", ".bin", write, {
        signal: firstController.signal,
      });
      const second = cache.materialize("cancel-all", ".bin", write, {
        signal: secondController.signal,
      });
      await waitUntil(() => started);
      firstController.abort(new DOMException("first cancelled", "AbortError"));
      await expect(first).rejects.toMatchObject({ name: "AbortError" });
      expect(producerAborted).toBe(false);

      secondController.abort(new DOMException("second cancelled", "AbortError"));
      await expect(second).rejects.toMatchObject({ name: "AbortError" });
      await waitUntil(() => producerAborted);
      await waitUntil(async () =>
        (await readdir(directory)).every((name) => !name.endsWith(".partial")),
      );
      await Bun.sleep(0);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  test("starts a fresh producer instead of joining an aborted inflight entry", async () => {
    const directory = await temporaryDirectory();
    const cache = new ResourceCache(directory, 1024 * 1024);
    let attempts = 0;
    let firstStarted = false;
    const write = async (path: string, signal: AbortSignal) => {
      attempts += 1;
      if (attempts === 1) {
        firstStarted = true;
        await new Promise<void>((_resolve, reject) => {
          const onAbort = () => reject(signal.reason);
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        });
      }
      signal.throwIfAborted();
      await writeFile(path, "replacement", { mode: 0o600 });
    };
    const cancelled = new AbortController();
    const first = cache.materialize("restart", ".bin", write, { signal: cancelled.signal });
    await waitUntil(() => firstStarted);
    cancelled.abort(new DOMException("cancelled", "AbortError"));
    await expect(first).rejects.toMatchObject({ name: "AbortError" });

    const replacement = await cache.materialize("restart", ".bin", write);
    expect(replacement.cacheHit).toBe(false);
    expect(attempts).toBe(2);
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "termloom-cache-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function waitUntil(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(5);
  }
  throw new Error("Timed out waiting for cache state");
}
