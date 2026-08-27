import { access } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { MathLayout, MathRenderer } from "./math-layout.js";

const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const HEADER_BYTES = 8;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

type WireResponse = { Layout: MathLayout } | { Error: { code: string; message: string } } | "Bye";

interface WireProcess {
  stdin: Bun.Subprocess<"pipe", "pipe", "pipe">["stdin"];
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  kill(signal?: NodeJS.Signals): void;
}

/** Persistent IPC client for the strict Rust/term-maths LaTeX cell engine. */
export class NativeMathRenderer implements MathRenderer {
  private process: WireProcess | undefined;
  private reader: NativeReader | undefined;
  private pendingChunk: Uint8Array | undefined;
  private pendingOffset = 0;
  private operation = Promise.resolve();
  private closed = false;
  private stderrTail = "";
  private readonly cache = new Map<string, MathLayout>();

  public async layout(source: string, display: boolean, signal?: AbortSignal): Promise<MathLayout> {
    const normalized = source.replace(/\r\n?/g, "\n").trim();
    const key = `${display ? "display" : "inline"}:${normalized}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    return this.serial(async () => {
      this.throwIfClosed();
      if (signal?.aborted) throw cancelled();
      await this.ensureProcess();
      await this.write({ Layout: { source: normalized, display } }, signal);
      // Once a request is on the wire, finish consuming its response even if
      // the caller's view was cancelled. Otherwise the next serialized
      // request would read this stale frame and corrupt the length-prefixed
      // stream. Cancellation is observed immediately before the write and
      // again after the frame has been consumed.
      const response = await this.read(undefined);
      if (signal?.aborted) throw cancelled();
      if (isWireObject(response.header) && "Error" in response.header) {
        throw new NativeMathError(response.header.Error.code, response.header.Error.message);
      }
      if (!isWireObject(response.header) || !("Layout" in response.header)) {
        throw new Error("Native LaTeX renderer returned an unexpected response");
      }
      const layout = normalizeLayout(response.header.Layout, display);
      this.cache.set(key, layout);
      return layout;
    });
  }

  public async close(): Promise<void> {
    await this.serial(async () => {
      if (this.closed) return;
      this.closed = true;
      const process = this.process;
      if (!process) return;
      try {
        await this.write("Shutdown", undefined);
        await this.read(undefined);
      } catch {
        // The parent may already be tearing down the helper.
      }
      process.kill("SIGTERM");
      this.process = undefined;
      this.reader?.releaseLock();
      this.reader = undefined;
      this.pendingChunk = undefined;
      this.pendingOffset = 0;
      this.stderrTail = "";
    });
  }

  private async ensureProcess(): Promise<void> {
    if (this.process) return;
    const binary = await resolveMathBinary();
    const child = Bun.spawn([binary], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      detached: process.platform !== "win32",
    }) as unknown as WireProcess;
    this.process = child;
    this.reader = child.stdout.getReader();
    void this.drainStderr(child.stderr);
  }

  private async write(header: unknown, signal: AbortSignal | undefined): Promise<void> {
    if (signal?.aborted) throw cancelled();
    const process = this.process;
    if (!process) throw new Error("Native LaTeX renderer is not running");
    const headerBytes = encoder.encode(JSON.stringify(header));
    if (headerBytes.byteLength === 0 || headerBytes.byteLength > MAX_FRAME_BYTES) {
      throw new Error("Native LaTeX renderer frame is too large");
    }
    const frame = new Uint8Array(HEADER_BYTES + headerBytes.byteLength);
    const view = new DataView(frame.buffer);
    view.setUint32(0, headerBytes.byteLength, true);
    view.setUint32(4, 0, true);
    frame.set(headerBytes, HEADER_BYTES);
    process.stdin.write(frame);
  }

  private async read(signal: AbortSignal | undefined): Promise<{ header: WireResponse }> {
    const lengths = await this.readExact(HEADER_BYTES, signal);
    const view = new DataView(lengths.buffer, lengths.byteOffset, lengths.byteLength);
    const headerLength = view.getUint32(0, true);
    const payloadLength = view.getUint32(4, true);
    if (
      headerLength === 0 ||
      headerLength > MAX_FRAME_BYTES ||
      payloadLength !== 0 ||
      headerLength + payloadLength > MAX_FRAME_BYTES
    ) {
      throw new Error("Native LaTeX renderer returned an invalid frame size");
    }
    const headerBytes = await this.readExact(headerLength, signal);
    return { header: JSON.parse(decoder.decode(headerBytes)) as WireResponse };
  }

  private async readExact(length: number, signal: AbortSignal | undefined): Promise<Uint8Array> {
    if (length === 0) return new Uint8Array();
    const reader = this.reader;
    if (!reader) throw new Error("Native LaTeX renderer output is unavailable");
    const result = new Uint8Array(length);
    let offset = 0;
    while (offset < length) {
      if (signal?.aborted) throw cancelled();
      const fromPending = this.pendingChunk !== undefined;
      const pendingChunk = this.pendingChunk;
      const next = fromPending
        ? { done: false, value: pendingChunk?.subarray(this.pendingOffset) }
        : await reader.read();
      if (next.done || !next.value) {
        const detail = this.stderrTail.trim();
        throw new Error(
          detail.length > 0
            ? `Native LaTeX renderer exited unexpectedly: ${detail}`
            : "Native LaTeX renderer exited unexpectedly",
        );
      }
      const copyLength = Math.min(next.value.byteLength, length - offset);
      result.set(next.value.subarray(0, copyLength), offset);
      offset += copyLength;
      if (copyLength < next.value.byteLength) {
        if (!fromPending) this.pendingChunk = next.value;
        this.pendingOffset += copyLength;
      } else {
        this.pendingChunk = undefined;
        this.pendingOffset = 0;
      }
    }
    return result;
  }

  private async serial<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.operation;
    let release!: () => void;
    this.operation = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await task();
    } finally {
      release();
    }
  }

  private throwIfClosed(): void {
    if (this.closed) throw new Error("Native LaTeX renderer is closed");
  }

  private async drainStderr(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) return;
        if (next.value)
          this.stderrTail = `${this.stderrTail}${decoder.decode(next.value)}`.slice(-4096);
      }
    } catch {
      // Teardown can close stderr while stdout is settling.
    } finally {
      reader.releaseLock();
    }
  }
}

export class NativeMathError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "NativeMathError";
  }
}

function normalizeLayout(value: MathLayout, display: boolean): MathLayout {
  if (
    !value ||
    !Array.isArray(value.lines) ||
    !Number.isInteger(value.width) ||
    !Number.isInteger(value.height) ||
    !Number.isInteger(value.baseline) ||
    value.width < 1 ||
    value.height < 1 ||
    value.baseline < 0 ||
    value.baseline >= value.height ||
    value.lines.length !== value.height
  ) {
    throw new Error("Native LaTeX renderer returned invalid cell layout metadata");
  }
  return {
    lines: value.lines.map((line) => (typeof line === "string" ? line : String(line))),
    width: value.width,
    height: value.height,
    baseline: value.baseline,
    display,
  };
}

function isWireObject(value: WireResponse): value is Exclude<WireResponse, "Bye"> {
  return typeof value === "object" && value !== null;
}

async function resolveMathBinary(): Promise<string> {
  const candidates = [
    // biome-ignore lint/complexity/useLiteralKeys: Bun's env type uses an index signature.
    process.env["TERMLOOM_MATH_RENDERER"],
    join(dirname(process.execPath), "termloom-math"),
    join(dirname(process.execPath), "../libexec/termloom-math"),
    join(process.cwd(), "native/termloom-math/target/release/termloom-math"),
    join(process.cwd(), "native/termloom-math/target/debug/termloom-math"),
    join(import.meta.dir, "../../native/termloom-math/target/release/termloom-math"),
    join(import.meta.dir, "../../native/termloom-math/target/debug/termloom-math"),
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next development or packaged location.
    }
  }
  throw new Error(
    "Native LaTeX renderer is unavailable. Build native/termloom-math or set TERMLOOM_MATH_RENDERER.",
  );
}

function cancelled(): Error {
  return new DOMException("The native LaTeX render was cancelled", "AbortError");
}

type NativeReader = {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  releaseLock(): void;
};
