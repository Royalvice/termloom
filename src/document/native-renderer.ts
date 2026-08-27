import { access } from "node:fs/promises";
import { dirname, join } from "node:path";

const MAX_FRAME_BYTES = 64 * 1024 * 1024;
const HEADER_BYTES = 8;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface NativeMarkdownRenderRequest {
  markdown: string;
  widthPx: number;
  tileHeightPx: number;
  ppi?: number;
  theme?: string;
  baseDir?: string;
  signal?: AbortSignal;
}

export interface NativeMarkdownMetadata {
  widthPx: number;
  tileHeightPx: number;
  totalHeightPx: number;
  tileCount: number;
  visualLines: readonly NativeMarkdownVisualLine[];
}

export interface NativeMarkdownVisualLine {
  yPx: number;
  mdBlockRange?: readonly [number, number];
  mdOffset?: number;
}

type WireResponse =
  | { Ready: NativeMarkdownMetadata }
  | { Tile: { index: number } }
  | { Error: { message: string } }
  | "Bye";

interface WireProcess {
  stdin: Bun.Subprocess<"pipe", "pipe", "pipe">["stdin"];
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  kill(signal?: NodeJS.Signals): void;
  exited: Promise<number>;
}

/**
 * Bun-side IPC client for the Rust/Typst Markdown renderer.
 *
 * The transport uses an 8-byte little-endian pair (JSON-header length,
 * binary-payload length), followed by UTF-8 JSON and an optional raw PNG
 * payload. This keeps the native helper independent from Bun's package graph.
 */
export class NativeMarkdownRenderer {
  private process: WireProcess | undefined;
  private reader: NativeReader | undefined;
  private pendingChunk: Uint8Array | undefined;
  private pendingOffset = 0;
  private operation = Promise.resolve();
  private closed = false;
  private stderrTail = "";

  public async render(request: NativeMarkdownRenderRequest): Promise<NativeMarkdownDocument> {
    return this.serial(async () => {
      this.throwIfClosed();
      const signal = request.signal;
      if (signal?.aborted) throw cancelled();
      await this.ensureProcess();
      await this.write(
        {
          Render: {
            markdown: request.markdown,
            width_px: positiveInteger(request.widthPx, "widthPx"),
            tile_height_px: positiveInteger(request.tileHeightPx, "tileHeightPx"),
            ppi: positiveFinite(request.ppi ?? 144, "ppi"),
            theme: request.theme?.trim() || "catppuccin",
            ...(request.baseDir ? { base_dir: request.baseDir } : {}),
          },
        },
        new Uint8Array(),
        signal,
      );
      const response = await this.read(signal);
      if (isWireObject(response.header) && "Error" in response.header) {
        throw new Error(response.header.Error.message);
      }
      if (!isWireObject(response.header) || !("Ready" in response.header)) {
        throw new Error("Native Markdown renderer did not return metadata");
      }
      return new NativeMarkdownDocument(this, response.header.Ready, signal);
    });
  }

  public async tile(index: number, signal?: AbortSignal): Promise<Uint8Array> {
    return this.serial(async () => {
      this.throwIfClosed();
      if (!Number.isInteger(index) || index < 0) throw new Error("tile index must be non-negative");
      await this.ensureProcess();
      await this.write({ Tile: { index } }, new Uint8Array(), signal);
      const response = await this.read(signal);
      if (isWireObject(response.header) && "Error" in response.header) {
        throw new Error(response.header.Error.message);
      }
      if (
        !isWireObject(response.header) ||
        !("Tile" in response.header) ||
        response.header.Tile.index !== index
      ) {
        throw new Error("Native Markdown renderer returned an unexpected tile");
      }
      return response.payload;
    });
  }

  public async close(): Promise<void> {
    await this.serial(async () => {
      if (this.closed) return;
      this.closed = true;
      if (!this.process) return;
      try {
        await this.write({ Shutdown: null }, new Uint8Array(), undefined);
        await this.read(undefined);
      } catch {
        // The helper may already have been torn down by the parent abort path.
      }
      this.process.kill("SIGTERM");
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
    const binary = await resolveRendererBinary();
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

  private async write(
    header: unknown,
    payload: Uint8Array,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    if (signal?.aborted) throw cancelled();
    const process = this.process;
    if (!process) throw new Error("Native Markdown renderer is not running");
    const headerBytes = encoder.encode(JSON.stringify(header));
    if (
      headerBytes.byteLength === 0 ||
      headerBytes.byteLength > MAX_FRAME_BYTES ||
      payload.byteLength > MAX_FRAME_BYTES ||
      headerBytes.byteLength + payload.byteLength > MAX_FRAME_BYTES
    ) {
      throw new Error("Native Markdown renderer frame is too large");
    }
    const frame = new Uint8Array(HEADER_BYTES + headerBytes.byteLength + payload.byteLength);
    const view = new DataView(frame.buffer);
    view.setUint32(0, headerBytes.byteLength, true);
    view.setUint32(4, payload.byteLength, true);
    frame.set(headerBytes, HEADER_BYTES);
    frame.set(payload, HEADER_BYTES + headerBytes.byteLength);
    process.stdin.write(frame);
  }

  private async read(
    signal: AbortSignal | undefined,
  ): Promise<{ header: WireResponse; payload: Uint8Array }> {
    const lengths = await this.readExact(HEADER_BYTES, signal);
    const view = new DataView(lengths.buffer, lengths.byteOffset, lengths.byteLength);
    const headerLength = view.getUint32(0, true);
    const payloadLength = view.getUint32(4, true);
    if (
      headerLength === 0 ||
      headerLength > MAX_FRAME_BYTES ||
      payloadLength > MAX_FRAME_BYTES ||
      headerLength + payloadLength > MAX_FRAME_BYTES
    ) {
      throw new Error("Native Markdown renderer returned an invalid frame size");
    }
    const headerBytes = await this.readExact(headerLength, signal);
    const payload = await this.readExact(payloadLength, signal);
    return { header: JSON.parse(decoder.decode(headerBytes)) as WireResponse, payload };
  }

  private async readExact(length: number, signal: AbortSignal | undefined): Promise<Uint8Array> {
    if (length === 0) return new Uint8Array();
    const reader = this.reader;
    if (!reader) throw new Error("Native Markdown renderer output is unavailable");
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
            ? `Native Markdown renderer exited unexpectedly: ${detail}`
            : "Native Markdown renderer exited unexpectedly",
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
    if (this.closed) throw new Error("Native Markdown renderer is closed");
  }

  private async drainStderr(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) return;
        if (!next.value) continue;
        this.stderrTail = `${this.stderrTail}${decoder.decode(next.value, { stream: true })}`.slice(
          -4096,
        );
      }
    } catch {
      // Process teardown can close stderr while the stdout protocol is still
      // settling; the stdout response remains the authoritative error path.
    } finally {
      reader.releaseLock();
    }
  }
}

export class NativeMarkdownDocument {
  public constructor(
    private readonly renderer: NativeMarkdownRenderer,
    public readonly metadata: NativeMarkdownMetadata,
    private readonly signal?: AbortSignal,
  ) {}

  public tile(index: number): Promise<Uint8Array> {
    return this.renderer.tile(index, this.signal);
  }
}

type NativeReader = {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  releaseLock(): void;
};

function isWireObject(value: WireResponse): value is Exclude<WireResponse, "Bye"> {
  return typeof value === "object" && value !== null;
}

async function resolveRendererBinary(): Promise<string> {
  const candidates = [
    // biome-ignore lint/complexity/useLiteralKeys: Bun's env type uses an index signature.
    process.env["TERMLOOM_RENDERER"],
    join(dirname(process.execPath), "termloom-render"),
    join(dirname(process.execPath), "../libexec/termloom-render"),
    join(process.cwd(), "native/termloom-render/target/release/termloom-render"),
    join(process.cwd(), "native/termloom-render/target/debug/termloom-render"),
    join(import.meta.dir, "../../native/termloom-render/target/release/termloom-render"),
    join(import.meta.dir, "../../native/termloom-render/target/debug/termloom-render"),
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
    "Native Markdown renderer is unavailable. Build native/termloom-render or set TERMLOOM_RENDERER.",
  );
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function positiveFinite(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive and finite`);
  return value;
}

function cancelled(): Error {
  return new DOMException("The native Markdown render was cancelled", "AbortError");
}
