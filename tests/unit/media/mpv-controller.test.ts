import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MpvController } from "../../../src/media/mpv-controller.js";
import { runProcess } from "../../../src/process/process-runner.js";

const temporaryDirectories: string[] = [];
let controller: MpvController | undefined;

afterEach(async () => {
  await controller?.close();
  controller = undefined;
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

test("controls an actual windowless mpv clock through JSON IPC", async () => {
  const path = await videoFixture();
  controller = new MpvController(path, { audioOutput: "null" });
  const initial = await controller.start();

  expect(controller.launchFlags).toContain("--no-video");
  expect(controller.launchFlags).toContain("--force-window=no");
  expect(controller.launchFlags).toContain("--audio-display=no");
  expect(initial.paused).toBe(true);
  expect(initial.durationSeconds).toBeGreaterThan(1);

  await controller.play();
  await Bun.sleep(250);
  expect(await controller.position()).toBeGreaterThan(0.1);
  await controller.pause();
  const pausedAt = await controller.position();
  await Bun.sleep(120);
  expect(await controller.position()).toBeWithin(pausedAt - 0.05, pausedAt + 0.05);

  expect(await controller.seek(0.75)).toBeWithin(0.65, 0.85);
  await controller.setVolume(37);
  await controller.setMuted(true);
  const changed = await controller.state();
  expect(changed.paused).toBe(true);
  expect(changed.volume).toBeWithin(36.5, 37.5);
  expect(changed.muted).toBe(true);
}, 30_000);

async function videoFixture(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "termloom-mpv-test-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "clock.mp4");
  const ffmpeg = Bun.which("ffmpeg");
  if (!ffmpeg) throw new Error("ffmpeg is required for the mpv fixture");
  await runProcess(
    ffmpeg,
    [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=64x48:rate=12",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=48000",
      "-t",
      "1.5",
      "-c:v",
      "mpeg4",
      "-q:v",
      "4",
      "-c:a",
      "aac",
      "-shortest",
      "-y",
      path,
    ],
    { timeoutMs: 20_000 },
  );
  return path;
}
