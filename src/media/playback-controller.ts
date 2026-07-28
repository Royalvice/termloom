import { EventEmitter } from "node:events";
import { errorMessage } from "../core/errors.js";
import type { MediaDecoder, MediaFrameStream, MediaProbe } from "./decoder.js";
import { MpvController, type MpvControllerOptions } from "./mpv-controller.js";
import type { RgbFrame } from "./types.js";

export type PlaybackKind = "gif" | "video";
export type PlaybackStatus = "loading" | "paused" | "playing" | "ended" | "error";

export interface MediaPlaybackState {
  kind: PlaybackKind;
  status: PlaybackStatus;
  positionSeconds: number;
  durationSeconds: number;
  volume: number;
  muted: boolean;
  clock: "ffmpeg" | "mpv";
  clockDriftSeconds?: number;
  error?: string;
}

export interface MediaPlaybackOptions {
  kind: PlaybackKind;
  framesPerSecond: number;
  loop?: boolean;
  autoplay?: boolean;
  volume?: number;
  muted?: boolean;
  maximumClockDriftSeconds?: number;
  mpv?: MpvControllerOptions;
}

export class MediaPlaybackController extends EventEmitter {
  private readonly options: Required<
    Pick<MediaPlaybackOptions, "kind" | "framesPerSecond" | "loop" | "autoplay">
  > &
    Pick<MediaPlaybackOptions, "maximumClockDriftSeconds" | "mpv">;
  private stateValue: MediaPlaybackState;
  private probeValue: MediaProbe | undefined;
  private mpv: MpvController | undefined;
  private stream: MediaFrameStream | undefined;
  private pumpPromise: Promise<void> | undefined;
  private initializePromise: Promise<void> | undefined;
  private generation = 0;
  private disposed = false;

  public constructor(
    private readonly sourcePath: string,
    private readonly decoder: MediaDecoder,
    options: MediaPlaybackOptions,
  ) {
    super();
    if (!Number.isFinite(options.framesPerSecond) || options.framesPerSecond <= 0) {
      throw new Error("Playback frame rate must be a positive number");
    }
    this.options = {
      kind: options.kind,
      framesPerSecond: options.framesPerSecond,
      loop: options.loop ?? options.kind === "gif",
      autoplay: options.autoplay ?? false,
      maximumClockDriftSeconds: options.maximumClockDriftSeconds,
      mpv: options.mpv,
    };
    this.stateValue = {
      kind: options.kind,
      status: "loading",
      positionSeconds: 0,
      durationSeconds: 0,
      volume: clamp(options.volume ?? 100, 0, 100),
      muted: options.muted ?? false,
      clock: "ffmpeg",
    };
  }

  public inspect(): MediaPlaybackState {
    return { ...this.stateValue };
  }

  public onFrame(listener: (frame: RgbFrame) => void): () => void {
    this.on("frame", listener);
    return () => this.off("frame", listener);
  }

  public onState(listener: (state: MediaPlaybackState) => void): () => void {
    this.on("state", listener);
    return () => this.off("state", listener);
  }

  public inspectProcesses(): { ffmpeg?: number; mpv?: number } {
    const ffmpeg = this.stream?.isRunning() ? this.stream.processId() : undefined;
    const mpv = this.mpv?.isRunning() ? this.mpv.processId() : undefined;
    return { ...(ffmpeg ? { ffmpeg } : {}), ...(mpv ? { mpv } : {}) };
  }

  public initialize(): Promise<void> {
    if (!this.initializePromise) {
      this.initializePromise = this.initializeOnce();
      if (this.options.autoplay) {
        void this.initializePromise.then(() => this.play()).catch(() => undefined);
      }
    }
    return this.initializePromise;
  }

  public async toggle(): Promise<void> {
    if (this.stateValue.status === "playing") await this.pause();
    else await this.play();
  }

  public async play(): Promise<void> {
    await this.initialize();
    this.assertAlive();
    if (this.stateValue.status === "playing") return;
    if (this.stateValue.status === "ended") await this.seek(0);
    const generation = ++this.generation;
    await this.stopStream();
    if (this.mpv) {
      await this.mpv.pause();
      await this.mpv.seek(this.stateValue.positionSeconds);
    }
    this.update({ status: "playing", error: undefined });
    const pump = this.pump(generation, this.stateValue.positionSeconds);
    this.pumpPromise = pump;
    void pump.finally(() => {
      if (this.pumpPromise === pump) this.pumpPromise = undefined;
    });
  }

  public async pause(): Promise<void> {
    await this.initialize();
    this.assertAlive();
    if (this.stateValue.status !== "playing") return;
    this.generation += 1;
    await this.stopStream();
    if (this.mpv) {
      await this.mpv.pause();
      if (this.stateValue.clock === "mpv") {
        this.update({ positionSeconds: await this.mpv.position() });
      }
    }
    this.update({ status: "paused" });
  }

  public async seek(seconds: number): Promise<void> {
    await this.initialize();
    this.assertAlive();
    const wasPlaying = this.stateValue.status === "playing";
    this.generation += 1;
    await this.stopStream();
    const target = this.normalizePosition(seconds);
    if (this.mpv) {
      await this.mpv.pause();
      await this.mpv.seek(target);
    }
    const frame = await this.decoder.decodeFrame(this.sourcePath, target);
    this.emit("frame", frame);
    this.update({ positionSeconds: target, status: "paused", clockDriftSeconds: undefined });
    if (wasPlaying) await this.play();
  }

  public async seekBy(deltaSeconds: number): Promise<void> {
    await this.seek(this.stateValue.positionSeconds + deltaSeconds);
  }

  public async setVolume(volume: number): Promise<void> {
    await this.initialize();
    const target = clamp(volume, 0, 100);
    if (this.mpv) await this.mpv.setVolume(target);
    this.update({ volume: target });
  }

  public async adjustVolume(delta: number): Promise<void> {
    await this.setVolume(this.stateValue.volume + delta);
  }

  public async setMuted(muted: boolean): Promise<void> {
    await this.initialize();
    if (this.mpv) await this.mpv.setMuted(muted);
    this.update({ muted });
  }

  public async toggleMuted(): Promise<void> {
    await this.setMuted(!this.stateValue.muted);
  }

  public async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    await this.stopStream();
    await this.initializePromise?.catch(() => undefined);
    await this.mpv?.close();
    this.mpv = undefined;
    this.removeAllListeners();
  }

  private async initializeOnce(): Promise<void> {
    this.assertAlive();
    try {
      this.probeValue = await this.decoder.probe(this.sourcePath);
      this.assertAlive();
      const durationSeconds = this.probeValue.durationSeconds ?? 0;
      if (this.options.kind === "video" && this.probeValue.hasAudio) {
        this.mpv = new MpvController(this.sourcePath, this.options.mpv);
        const mpvState = await this.mpv.start();
        this.assertAlive();
        if (this.stateValue.volume !== mpvState.volume) {
          await this.mpv.setVolume(this.stateValue.volume);
        }
        if (this.stateValue.muted !== mpvState.muted) {
          await this.mpv.setMuted(this.stateValue.muted);
        }
        this.stateValue = {
          ...this.stateValue,
          durationSeconds: mpvState.durationSeconds || durationSeconds,
          clock: "mpv",
        };
      } else {
        this.stateValue = { ...this.stateValue, durationSeconds, clock: "ffmpeg" };
      }
      const frame = await this.decoder.decodeFrame(this.sourcePath, 0);
      this.assertAlive();
      this.emit("frame", frame);
      this.update({ status: "paused" });
    } catch (error) {
      if (!this.disposed) this.update({ status: "error", error: errorMessage(error) });
      await this.mpv?.close().catch(() => undefined);
      this.mpv = undefined;
      throw error;
    }
  }

  private async pump(generation: number, startSeconds: number): Promise<void> {
    try {
      const stream = await this.decoder.openFrameStream(this.sourcePath, {
        startSeconds,
        framesPerSecond: this.options.framesPerSecond,
        loop: this.options.loop,
        realtime: true,
      });
      if (generation !== this.generation || this.disposed) {
        await stream.close();
        return;
      }
      this.stream = stream;
      let first = true;
      let previousTimestamp: number | undefined;
      for await (const frame of stream) {
        if (generation !== this.generation || this.disposed) return;
        if (first) {
          first = false;
          if (this.mpv && this.stateValue.clock === "mpv") await this.mpv.play();
        } else if (
          this.mpv &&
          this.stateValue.clock === "mpv" &&
          previousTimestamp !== undefined &&
          (frame.timestampSeconds ?? 0) < previousTimestamp
        ) {
          await this.mpv.pause();
          await this.mpv.seek(frame.timestampSeconds ?? 0);
          await this.mpv.play();
        }
        previousTimestamp = frame.timestampSeconds;
        if (!(await this.synchronize(frame, generation))) continue;
        this.emit("frame", frame);
        this.emitState();
      }
      if (generation !== this.generation || this.disposed) return;
      await this.mpv?.pause().catch(() => undefined);
      this.update({
        status: "ended",
        positionSeconds: this.stateValue.durationSeconds,
        clockDriftSeconds: undefined,
      });
    } catch (error) {
      if (generation !== this.generation || this.disposed) return;
      this.update({ status: "error", error: errorMessage(error) });
    } finally {
      if (generation === this.generation) this.stream = undefined;
    }
  }

  private async synchronize(frame: RgbFrame, generation: number): Promise<boolean> {
    const timestamp = frame.timestampSeconds ?? this.stateValue.positionSeconds;
    if (!this.mpv || this.stateValue.clock !== "mpv") {
      this.stateValue = {
        ...this.stateValue,
        positionSeconds: timestamp,
        clockDriftSeconds: undefined,
      };
      return true;
    }
    let clockPosition = await this.mpv.position();
    let drift = timestamp - clockPosition;
    const maximum = this.options.maximumClockDriftSeconds ?? 0.35;
    if (drift > maximum) {
      await Bun.sleep(Math.min(500, Math.max(1, Math.round(drift * 1_000))));
      if (generation !== this.generation || this.disposed) return false;
      clockPosition = await this.mpv.position();
      drift = timestamp - clockPosition;
    }
    this.stateValue = {
      ...this.stateValue,
      positionSeconds: clockPosition,
      clockDriftSeconds: drift,
    };
    return drift >= -maximum;
  }

  private normalizePosition(seconds: number): number {
    const duration = this.stateValue.durationSeconds;
    if (this.options.loop && duration > 0) {
      return ((seconds % duration) + duration) % duration;
    }
    return clamp(seconds, 0, duration || Number.MAX_SAFE_INTEGER);
  }

  private async stopStream(): Promise<void> {
    const stream = this.stream;
    const pump = this.pumpPromise;
    this.stream = undefined;
    await stream?.close();
    await pump?.catch(() => undefined);
    if (this.pumpPromise === pump) this.pumpPromise = undefined;
  }

  private update(patch: Partial<MediaPlaybackState>): void {
    this.stateValue = { ...this.stateValue, ...patch };
    this.emitState();
  }

  private emitState(): void {
    this.emit("state", this.inspect());
  }

  private assertAlive(): void {
    if (this.disposed) throw new Error("Media playback controller is disposed");
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
