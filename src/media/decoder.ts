import { extname } from "node:path";
import type { ReadableStreamDefaultReader as NodeReadableStreamDefaultReader } from "node:stream/web";
import { z } from "zod";
import { errorMessage, TermLoomError } from "../core/errors.js";
import { redactText, runProcess } from "../process/process-runner.js";
import type { RgbFrame } from "./types.js";

const ProbeSchema = z.object({
  streams: z
    .array(
      z
        .object({
          codec_type: z.string().optional(),
          width: z.number().int().positive().optional(),
          height: z.number().int().positive().optional(),
          codec_name: z.string().optional(),
          duration: z.string().optional(),
          avg_frame_rate: z.string().optional(),
          r_frame_rate: z.string().optional(),
          nb_frames: z.string().optional(),
        })
        .passthrough(),
    )
    .min(1),
  format: z
    .object({
      duration: z.string().optional(),
    })
    .passthrough()
    .optional(),
});

export interface MediaProbe {
  width: number;
  height: number;
  codec?: string;
  durationSeconds?: number;
  frameRate?: number;
  frameCount?: number;
  hasAudio: boolean;
}

export interface MediaDecoderOptions {
  ffmpegBinary?: string;
  ffprobeBinary?: string;
  maxWidth?: number;
  maxHeight?: number;
}

export interface FrameStreamOptions {
  startSeconds?: number;
  framesPerSecond: number;
  loop?: boolean;
  realtime?: boolean;
  signal?: AbortSignal;
}

export interface MediaDecodeOptions {
  signal?: AbortSignal;
}

export class MediaDecoder {
  public readonly ffmpegBinary: string;
  public readonly ffprobeBinary: string;
  private readonly maxWidth: number;
  private readonly maxHeight: number;

  public constructor(options: MediaDecoderOptions = {}) {
    this.ffmpegBinary = requiredBinary(options.ffmpegBinary, "ffmpeg");
    this.ffprobeBinary = requiredBinary(options.ffprobeBinary, "ffprobe");
    this.maxWidth = boundedDimension(options.maxWidth ?? 4096, "width");
    this.maxHeight = boundedDimension(options.maxHeight ?? 4096, "height");
  }

  public async probe(path: string, options: MediaDecodeOptions = {}): Promise<MediaProbe> {
    const result = await runProcess(
      this.ffprobeBinary,
      [
        "-v",
        "error",
        "-show_entries",
        "stream=codec_type,width,height,codec_name,duration,avg_frame_rate,r_frame_rate,nb_frames:format=duration",
        "-of",
        "json",
        "--",
        path,
      ],
      { timeoutMs: 15_000, signal: options.signal },
    );
    const parsed = ProbeSchema.parse(JSON.parse(result.stdout));
    const stream = parsed.streams.find(
      (candidate) =>
        candidate.codec_type === "video" ||
        (candidate.width !== undefined && candidate.height !== undefined),
    );
    if (!stream?.width || !stream.height) throw new Error("ffprobe returned no video stream");
    const durationSeconds = positiveNumber(stream.duration ?? parsed.format?.duration);
    return {
      width: stream.width,
      height: stream.height,
      codec: stream.codec_name,
      durationSeconds,
      frameRate: parseFrameRate(stream.avg_frame_rate ?? stream.r_frame_rate),
      frameCount: positiveInteger(stream.nb_frames),
      hasAudio: parsed.streams.some((candidate) => candidate.codec_type === "audio"),
    };
  }

  public async decodeFrame(
    path: string,
    atSeconds = 0,
    options: MediaDecodeOptions = {},
  ): Promise<RgbFrame> {
    const metadata = await this.probe(path, options);
    const target = fit(metadata.width, metadata.height, this.maxWidth, this.maxHeight);
    const args = ["-v", "error", "-i", path];
    if (atSeconds > 0) args.push("-ss", atSeconds.toFixed(6));
    args.push(
      "-frames:v",
      "1",
      "-vf",
      `scale=${target.width}:${target.height}:flags=lanczos`,
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "pipe:1",
    );
    const bytes = await runBinary(this.ffmpegBinary, args, 30_000, options.signal);
    const expected = target.width * target.height * 3;
    if (bytes.length !== expected) {
      throw new TermLoomError({
        code: "PROCESS_FAILED",
        message: `ffmpeg returned ${bytes.length} RGB bytes; expected ${expected}`,
        details: { width: target.width, height: target.height, extension: extname(path) },
      });
    }
    return { width: target.width, height: target.height, rgb: bytes, timestampSeconds: atSeconds };
  }

  public async openFrameStream(
    path: string,
    options: FrameStreamOptions,
  ): Promise<MediaFrameStream> {
    if (!Number.isFinite(options.framesPerSecond) || options.framesPerSecond <= 0) {
      throw new Error("Frame stream rate must be a positive number");
    }
    if (options.signal?.aborted) throw cancelledStream();
    const metadata = await this.probe(path, { signal: options.signal });
    const target = fit(metadata.width, metadata.height, this.maxWidth, this.maxHeight);
    const startSeconds = Math.max(0, options.startSeconds ?? 0);
    const args = ["-v", "error"];
    if (options.realtime !== false) args.push("-re");
    if (options.loop) args.push("-stream_loop", "-1");
    if (startSeconds > 0) args.push("-ss", startSeconds.toFixed(6));
    args.push(
      "-i",
      path,
      "-an",
      "-vf",
      `fps=${options.framesPerSecond},scale=${target.width}:${target.height}:flags=lanczos`,
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "pipe:1",
    );
    let subprocess: Bun.Subprocess<"ignore", "pipe", "pipe">;
    try {
      subprocess = Bun.spawn([this.ffmpegBinary, ...args], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        detached: process.platform !== "win32",
      });
    } catch (error) {
      throw new TermLoomError({
        code: "PROCESS_FAILED",
        message: `Unable to start ffmpeg frame stream: ${errorMessage(error)}`,
        cause: error,
        details: { command: this.ffmpegBinary },
      });
    }
    return new MediaFrameStream(
      subprocess,
      target.width,
      target.height,
      startSeconds,
      options.framesPerSecond,
      options.loop ? metadata.durationSeconds : undefined,
      options.signal,
    );
  }
}

export class MediaFrameStream implements AsyncIterable<RgbFrame> {
  private readonly reader: NodeReadableStreamDefaultReader<Uint8Array<ArrayBuffer>>;
  private readonly stderrPromise: Promise<string>;
  private readonly frameBytes: number;
  private pendingChunk: Uint8Array<ArrayBuffer> | undefined;
  private pendingOffset = 0;
  private frameIndex = 0;
  private closed = false;
  private finished = false;
  private readonly abort: () => void;

  public constructor(
    private readonly subprocess: Bun.Subprocess<"ignore", "pipe", "pipe">,
    private readonly width: number,
    private readonly height: number,
    private readonly startSeconds: number,
    private readonly framesPerSecond: number,
    private readonly loopDurationSeconds: number | undefined,
    private readonly signal: AbortSignal | undefined,
  ) {
    this.reader = subprocess.stdout.getReader();
    this.stderrPromise = new Response(subprocess.stderr).text();
    this.frameBytes = width * height * 3;
    this.abort = () => void this.close();
    signal?.addEventListener("abort", this.abort, { once: true });
  }

  public [Symbol.asyncIterator](): AsyncIterator<RgbFrame> {
    return this.frames();
  }

  public processId(): number {
    return this.subprocess.pid;
  }

  public isRunning(): boolean {
    return this.subprocess.exitCode === null;
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.signal?.removeEventListener("abort", this.abort);
    terminateSubprocess(this.subprocess, "SIGTERM");
    const forceKill = setTimeout(() => terminateSubprocess(this.subprocess, "SIGKILL"), 500);
    forceKill.unref?.();
    await this.reader.cancel().catch(() => undefined);
    await Promise.all([this.subprocess.exited, this.stderrPromise])
      .catch(() => undefined)
      .finally(() => clearTimeout(forceKill));
  }

  private async *frames(): AsyncGenerator<RgbFrame> {
    try {
      while (!this.closed) {
        const rgb = await this.readFrame();
        if (!rgb) return;
        let timestampSeconds = this.startSeconds + this.frameIndex / this.framesPerSecond;
        if (this.loopDurationSeconds && this.loopDurationSeconds > 0) {
          timestampSeconds %= this.loopDurationSeconds;
        }
        this.frameIndex += 1;
        yield { width: this.width, height: this.height, rgb, timestampSeconds };
      }
    } finally {
      await this.close();
    }
  }

  private async readFrame(): Promise<Uint8Array | undefined> {
    const frame = new Uint8Array(this.frameBytes);
    let frameOffset = 0;
    while (frameOffset < this.frameBytes) {
      if (!this.pendingChunk || this.pendingOffset >= this.pendingChunk.byteLength) {
        const { value, done } = await this.reader.read();
        if (done) {
          await this.finish();
          if (this.closed) return;
          if (frameOffset !== 0) {
            throw new TermLoomError({
              code: "PROCESS_FAILED",
              message: `ffmpeg ended with a partial RGB frame (${frameOffset}/${this.frameBytes} bytes)`,
            });
          }
          return;
        }
        if (!value || value.byteLength === 0) continue;
        this.pendingChunk = value;
        this.pendingOffset = 0;
      }
      const chunk = this.pendingChunk;
      const available = chunk.byteLength - this.pendingOffset;
      const copied = Math.min(available, this.frameBytes - frameOffset);
      frame.set(chunk.subarray(this.pendingOffset, this.pendingOffset + copied), frameOffset);
      frameOffset += copied;
      this.pendingOffset += copied;
      if (this.pendingOffset >= chunk.byteLength) {
        this.pendingChunk = undefined;
        this.pendingOffset = 0;
      }
    }
    return frame;
  }

  private async finish(): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    const [exitCode, stderr] = await Promise.all([this.subprocess.exited, this.stderrPromise]);
    if (this.closed || exitCode === 0) return;
    throw new TermLoomError({
      code: "PROCESS_FAILED",
      message: `ffmpeg frame stream exited with status ${exitCode}: ${redactText(stderr.trim())}`,
      details: { exitCode },
    });
  }
}

async function runBinary(
  command: string,
  args: readonly string[],
  timeoutMs: number,
  signal?: AbortSignal,
) {
  if (signal?.aborted) throw cancelledStream();
  const subprocess = Bun.spawn([command, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    detached: process.platform !== "win32",
  });
  let timedOut = false;
  let aborted = false;
  let forceKill: ReturnType<typeof setTimeout> | undefined;
  const terminate = () => {
    terminateSubprocess(subprocess, "SIGTERM");
    forceKill ??= setTimeout(() => terminateSubprocess(subprocess, "SIGKILL"), 500);
    forceKill.unref?.();
  };
  const onAbort = () => {
    aborted = true;
    terminate();
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    terminate();
  }, timeoutMs);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      subprocess.exited,
      new Response(subprocess.stdout).arrayBuffer(),
      new Response(subprocess.stderr).text(),
    ]);
    if (timedOut) {
      throw new TermLoomError({
        code: "PROCESS_TIMEOUT",
        message: `${command} timed out after ${timeoutMs} ms`,
      });
    }
    if (aborted) throw cancelledStream();
    if (exitCode !== 0) {
      throw new TermLoomError({
        code: "PROCESS_FAILED",
        message: `${command} exited with status ${exitCode}: ${redactText(stderr.trim())}`,
        details: { command, exitCode },
      });
    }
    return new Uint8Array(stdout);
  } finally {
    clearTimeout(timeout);
    if (forceKill) clearTimeout(forceKill);
    signal?.removeEventListener("abort", onAbort);
  }
}

function terminateSubprocess(
  subprocess: Pick<Bun.Subprocess, "pid" | "exitCode" | "kill">,
  signal: NodeJS.Signals,
): void {
  if (subprocess.exitCode !== null) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-subprocess.pid, signal);
      return;
    } catch {
      // Fall through when the process group already exited or is unavailable.
    }
  }
  try {
    subprocess.kill(signal);
  } catch {
    // The subprocess already exited.
  }
}

function requiredBinary(configured: string | undefined, name: string): string {
  const binary = configured ?? Bun.which(name);
  if (binary) return binary;
  throw new TermLoomError({
    code: "DEPENDENCY_MISSING",
    message: `${name} was not found`,
    hint: `Install ${name} and run termloom doctor again.`,
    details: { dependency: name },
  });
}

function fit(width: number, height: number, maxWidth: number, maxHeight: number) {
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function boundedDimension(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 4096) {
    throw new Error(`Media ${label} limit must be an integer between 1 and 4096`);
  }
  return value;
}

function positiveNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function positiveInteger(value: string | undefined): number | undefined {
  const parsed = positiveNumber(value);
  return parsed === undefined ? undefined : Math.floor(parsed);
}

function parseFrameRate(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const [numerator, denominator] = value.split("/").map(Number);
  if (!numerator || !denominator) return positiveNumber(value);
  const result = numerator / denominator;
  return Number.isFinite(result) && result > 0 ? result : undefined;
}

function cancelledStream(): TermLoomError {
  return new TermLoomError({ code: "PROCESS_CANCELLED", message: "ffmpeg frame stream cancelled" });
}
