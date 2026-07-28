import { extname } from "node:path";
import { z } from "zod";
import { TermLoomError } from "../core/errors.js";
import { redactText, runProcess } from "../process/process-runner.js";
import type { RgbFrame } from "./types.js";

const ProbeSchema = z.object({
  streams: z
    .array(
      z
        .object({
          width: z.number().int().positive(),
          height: z.number().int().positive(),
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
}

export interface MediaDecoderOptions {
  ffmpegBinary?: string;
  ffprobeBinary?: string;
  maxWidth?: number;
  maxHeight?: number;
}

export class MediaDecoder {
  public readonly ffmpegBinary: string;
  public readonly ffprobeBinary: string;
  private readonly maxWidth: number;
  private readonly maxHeight: number;

  public constructor(options: MediaDecoderOptions = {}) {
    this.ffmpegBinary = requiredBinary(options.ffmpegBinary, "ffmpeg");
    this.ffprobeBinary = requiredBinary(options.ffprobeBinary, "ffprobe");
    this.maxWidth = options.maxWidth ?? 1600;
    this.maxHeight = options.maxHeight ?? 1200;
  }

  public async probe(path: string): Promise<MediaProbe> {
    const result = await runProcess(
      this.ffprobeBinary,
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height,codec_name,duration,avg_frame_rate,r_frame_rate,nb_frames:format=duration",
        "-of",
        "json",
        "--",
        path,
      ],
      { timeoutMs: 15_000 },
    );
    const parsed = ProbeSchema.parse(JSON.parse(result.stdout));
    const stream = parsed.streams[0];
    if (!stream) throw new Error("ffprobe returned no video stream");
    const durationSeconds = positiveNumber(stream.duration ?? parsed.format?.duration);
    return {
      width: stream.width,
      height: stream.height,
      codec: stream.codec_name,
      durationSeconds,
      frameRate: parseFrameRate(stream.avg_frame_rate ?? stream.r_frame_rate),
      frameCount: positiveInteger(stream.nb_frames),
    };
  }

  public async decodeFrame(path: string, atSeconds = 0): Promise<RgbFrame> {
    const metadata = await this.probe(path);
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
    const bytes = await runBinary(this.ffmpegBinary, args, 30_000);
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
}

async function runBinary(command: string, args: readonly string[], timeoutMs: number) {
  const subprocess = Bun.spawn([command, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    subprocess.kill("SIGTERM");
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
