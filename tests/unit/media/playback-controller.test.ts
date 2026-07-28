import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MediaDecoder } from "../../../src/media/decoder.js";
import {
  MediaPlaybackController,
  type MediaPlaybackState,
} from "../../../src/media/playback-controller.js";
import type { RgbFrame } from "../../../src/media/types.js";
import { runProcess } from "../../../src/process/process-runner.js";

const temporaryDirectories: string[] = [];
const controllers = new Set<MediaPlaybackController>();

afterEach(async () => {
  await Promise.all([...controllers].map((controller) => controller.dispose()));
  controllers.clear();
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("MediaPlaybackController", () => {
  test("synchronizes FFmpeg video frames to a real windowless mpv audio clock", async () => {
    const path = await videoFixture("audio.mp4", true);
    const controller = playback(path, "video");
    const frames: RgbFrame[] = [];
    const states: MediaPlaybackState[] = [];
    controller.onFrame((frame) => frames.push(frame));
    controller.onState((state) => states.push(state));

    await controller.initialize();
    expect(controller.inspect()).toMatchObject({ status: "paused", clock: "mpv" });
    await controller.play();
    await waitUntil(() => frames.length >= 4 && controller.inspect().positionSeconds > 0.15);

    const playing = controller.inspect();
    expect(playing.status).toBe("playing");
    expect(Math.abs(playing.clockDriftSeconds ?? Number.POSITIVE_INFINITY)).toBeLessThanOrEqual(
      0.35,
    );
    expect(states.some((state) => state.status === "playing" && state.clock === "mpv")).toBe(true);

    await controller.pause();
    const pausedAt = controller.inspect().positionSeconds;
    const pausedFrameCount = frames.length;
    await Bun.sleep(180);
    expect(controller.inspect().positionSeconds).toBeWithin(pausedAt - 0.06, pausedAt + 0.06);
    expect(frames).toHaveLength(pausedFrameCount);

    await controller.seek(0.75);
    expect(controller.inspect()).toMatchObject({ status: "paused", positionSeconds: 0.75 });
    expect(frames.at(-1)?.timestampSeconds).toBe(0.75);
    await controller.setVolume(31);
    await controller.setMuted(true);
    expect(controller.inspect()).toMatchObject({ volume: 31, muted: true });
  }, 30_000);

  test("uses the FFmpeg clock for a silent MP4 while retaining pane controls", async () => {
    const path = await videoFixture("silent.mp4", false);
    const controller = playback(path, "video");
    const frames: RgbFrame[] = [];
    controller.onFrame((frame) => frames.push(frame));

    await controller.initialize();
    expect(controller.inspect()).toMatchObject({ status: "paused", clock: "ffmpeg" });
    await controller.play();
    await waitUntil(() => frames.length >= 4 && controller.inspect().positionSeconds >= 0.2);
    expect(controller.inspect()).toMatchObject({ status: "playing", clock: "ffmpeg" });
    expect(controller.inspect().clockDriftSeconds).toBeUndefined();
    await controller.pause();
  }, 30_000);

  test("loops, pauses, and seeks an animated GIF entirely through FFmpeg", async () => {
    const path = await gifFixture();
    const controller = playback(path, "gif", true);
    const frames: RgbFrame[] = [];
    controller.onFrame((frame) => frames.push(frame));

    await controller.initialize();
    await waitUntil(() => controller.inspect().status === "playing" && frames.length >= 4);
    expect(controller.inspect()).toMatchObject({ kind: "gif", clock: "ffmpeg" });
    await controller.pause();
    const frameCount = frames.length;
    await Bun.sleep(150);
    expect(frames).toHaveLength(frameCount);

    await controller.seek(0.25);
    expect(controller.inspect()).toMatchObject({ status: "paused", positionSeconds: 0.25 });
    expect(frames.at(-1)?.timestampSeconds).toBe(0.25);
    await controller.play();
    await waitUntil(() => frames.length > frameCount + 2);
  }, 30_000);

  test("disposes safely while initialization is still in flight", async () => {
    const path = await videoFixture("dispose.mp4", true);
    const controller = playback(path, "video");
    const initialization = controller.initialize();
    await controller.dispose();
    await initialization.catch(() => undefined);
    expect(() => controller.inspect()).not.toThrow();
    await expect(controller.play()).rejects.toThrow("disposed");
  }, 30_000);
});

function playback(path: string, kind: "gif" | "video", autoplay = false): MediaPlaybackController {
  const controller = new MediaPlaybackController(
    path,
    new MediaDecoder({ maxWidth: 48, maxHeight: 36 }),
    {
      kind,
      framesPerSecond: 10,
      autoplay,
      loop: kind === "gif",
      maximumClockDriftSeconds: 0.35,
      mpv: { audioOutput: "null" },
    },
  );
  controllers.add(controller);
  return controller;
}

async function videoFixture(name: string, audio: boolean): Promise<string> {
  const directory = await temporaryDirectory();
  const path = join(directory, name);
  const ffmpeg = requiredFfmpeg();
  const args = ["-v", "error", "-f", "lavfi", "-i", "testsrc=size=48x36:rate=12"];
  if (audio) args.push("-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000");
  args.push(
    "-t",
    "1.5",
    "-c:v",
    "mpeg4",
    "-q:v",
    "4",
    ...(audio ? ["-c:a", "aac", "-shortest"] : []),
    "-y",
    path,
  );
  await runProcess(ffmpeg, args, { timeoutMs: 20_000 });
  return path;
}

async function gifFixture(): Promise<string> {
  const directory = await temporaryDirectory();
  const path = join(directory, "animated.gif");
  await runProcess(
    requiredFfmpeg(),
    ["-v", "error", "-f", "lavfi", "-i", "testsrc=size=48x36:rate=10", "-t", "0.8", "-y", path],
    { timeoutMs: 20_000 },
  );
  return path;
}

function requiredFfmpeg(): string {
  const binary = Bun.which("ffmpeg");
  if (!binary) throw new Error("ffmpeg is required for the playback fixture");
  return binary;
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "termloom-playback-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(20);
  }
  throw new Error("Timed out waiting for media playback state");
}
