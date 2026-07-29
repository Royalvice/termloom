#!/usr/bin/env bun

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { createCliRenderer, type KeyEvent, type TextRenderable } from "@opentui/core";
import { lookup } from "mime-types";
import { atomicWriteUtf8 } from "../src/core/atomic-file.js";
import { DomainPermissionGate } from "../src/document/domain-permission.js";
import { ResourceCache } from "../src/document/resource-cache.js";
import { ResourceLoader, type RemoteResourceProvider } from "../src/document/resource-loader.js";
import type { ConflictPolicy, FileEntry } from "../src/files/file-provider.js";
import { runDoctor, type DoctorReport } from "../src/doctor/doctor.js";
import { I18n } from "../src/i18n/i18n.js";
import { selectMediaAdapter, waitForTerminalCapabilities } from "../src/media/capabilities.js";
import { MediaDecoder } from "../src/media/decoder.js";
import { FormulaRenderer } from "../src/media/formula-renderer.js";
import { SvgRasterizer } from "../src/media/svg-rasterizer.js";
import { redactText, runProcess } from "../src/process/process-runner.js";
import { TransferQueue } from "../src/sftp/transfer-queue.js";
import { DocumentMediaBlockRenderable } from "../src/ui/media-block-renderable.js";
import { RichDocumentRenderable } from "../src/ui/rich-document-renderable.js";

interface ProbeOptions {
  label: string;
  mode: "direct" | "tmux";
  output: string;
  holdMs: number;
  startupDelayMs: number;
}

interface MatrixEvidence {
  schemaVersion: 1;
  generatedAt: string;
  ok: boolean;
  label: string;
  mode: ProbeOptions["mode"];
  environment: {
    TERM?: string;
    TERM_PROGRAM?: string;
    TERM_PROGRAM_VERSION?: string;
    COLORTERM?: string;
    tmux: boolean;
  };
  doctor?: DoctorReport;
  showcase?: {
    width: number;
    height: number;
    capabilities: DoctorReport["terminal"]["capabilities"];
    adapter: DoctorReport["terminal"]["adapter"];
    fullscreen: boolean;
    markdown: boolean;
    image: ProbeMediaEvidence;
    gif: ProbeMediaEvidence;
    video: ProbeMediaEvidence;
    formula: string;
  };
  error?: string;
}

interface ProbeMediaEvidence {
  status: string;
  frame?: { width: number; height: number; timestampSeconds?: number };
  playback?: ReturnType<DocumentMediaBlockRenderable["inspectPlayback"]>;
  processKinds: readonly string[];
}

const options = parseOptions(process.argv.slice(2));
const title = `TermLoom Matrix ${options.label} ${options.mode}`;
const environment = terminalEnvironment();
const evidence: MatrixEvidence = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  ok: false,
  label: options.label,
  mode: options.mode,
  environment,
};
let fixtureDirectory: string | undefined;
let preview: RichDocumentRenderable | undefined;
let renderer: Awaited<ReturnType<typeof createCliRenderer>> | undefined;

process.stdout.write(`\u001b]2;${title}\u0007`);

try {
  await Bun.sleep(options.startupDelayMs);
  const doctor = await runDoctor({ probeTerminal: true });
  evidence.doctor = doctor;
  if (
    doctor.terminal.capabilitySource !== "opentui" ||
    !doctor.terminal.capabilities ||
    doctor.terminal.status === "fail" ||
    !doctor.terminal.adapter
  ) {
    throw new Error(`Live terminal capability probe failed: ${doctor.terminal.message}`);
  }

  fixtureDirectory = await mkdtemp(join(tmpdir(), "termloom-terminal-matrix-"));
  const resources = await createRemoteResources(fixtureDirectory, options);
  const remote = fixtureRemoteProvider(resources);
  const cache = new ResourceCache(join(fixtureDirectory, "cache"), 64 * 1024 * 1024);
  const permissions = new DomainPermissionGate();
  const rasterizer = new SvgRasterizer({ cache });
  renderer = await createCliRenderer({
    exitOnCtrlC: false,
    useKittyKeyboard: null,
    useMouse: false,
    targetFps: 30,
  });
  const showcaseCapabilities = await waitForTerminalCapabilities(renderer);
  const adapter = selectMediaAdapter(
    "auto",
    {
      TERM: environment.TERM,
      TERM_PROGRAM: environment.TERM_PROGRAM,
      COLORTERM: environment.COLORTERM,
      ...(environment.tmux ? { TMUX: "present" } : {}),
    },
    showcaseCapabilities,
  );
  preview = new RichDocumentRenderable(renderer, {
    id: "matrix-preview",
    pane: {
      id: "matrix-pane",
      kind: "preview",
      title: title,
      target: { kind: "ssh", hostId: "matrix-fixture" },
      path: "/docs/README.md",
      scrollOffset: 0,
    },
    i18n: new I18n("en"),
    loader: new ResourceLoader({ remote, cache, permissions }),
    permissions,
    decoder: new MediaDecoder({ maxWidth: 240, maxHeight: 160 }),
    rasterizer,
    formula: new FormulaRenderer({ cache, rasterizer }),
    adapter,
    output: process.stdout,
    videoFramesPerSecond: 12,
    autoplayGif: true,
    mpv: { audioOutput: "null" },
  });
  const activePreview = preview;
  renderer.root.add(activePreview);
  activePreview.focus();

  await waitUntil(
    () =>
      activePreview.findDescendantById("document-media-1") !== undefined &&
      activePreview.findDescendantById("document-media-2") !== undefined &&
      activePreview.findDescendantById("document-media-3") !== undefined &&
      activePreview.findDescendantById("status-math-1") !== undefined,
    () => "RichDocument media nodes were not created",
  );
  const image = media(activePreview, "document-media-1");
  const gif = media(activePreview, "document-media-2");
  const video = media(activePreview, "document-media-3");
  await waitUntil(
    () =>
      image.inspectFrame() !== undefined &&
      gif.inspectPlayback()?.status === "playing" &&
      video.inspectPlayback()?.status === "paused" &&
      statusText(activePreview, "status-math-1").includes(adapter.name),
    () =>
      JSON.stringify({
        image: statusText(activePreview, "status-media-1"),
        gif: gif.inspectPlayback(),
        video: video.inspectPlayback(),
        formula: statusText(activePreview, "status-math-1"),
      }),
  );

  activePreview.handleKeyPress(key("tab"));
  if (activePreview.selectedMedia() !== video) throw new Error("Video was not selected by the TUI");
  await video.togglePlayback();
  activePreview.handleKeyPress(key("f"));
  await waitUntil(
    () =>
      activePreview.isMediaFullscreen() &&
      video.inspectPlayback()?.status === "playing" &&
      (video.inspectFrame()?.timestampSeconds ?? 0) > 0.1 &&
      Object.keys(video.inspectProcesses()).length === 2,
    () =>
      JSON.stringify({
        fullscreen: activePreview.isMediaFullscreen(),
        video: video.inspectPlayback(),
        processes: video.inspectProcesses(),
      }),
  );
  await Bun.sleep(500);

  evidence.showcase = {
    width: renderer.width,
    height: renderer.height,
    capabilities: showcaseCapabilities,
    adapter,
    fullscreen: activePreview.isMediaFullscreen(),
    markdown: activePreview.findDescendantById("matrix-preview-markdown") !== undefined,
    image: mediaEvidence(activePreview, image, "status-media-1"),
    gif: mediaEvidence(activePreview, gif, "status-media-2"),
    video: mediaEvidence(activePreview, video, "status-media-3"),
    formula: statusText(activePreview, "status-math-1"),
  };
  evidence.ok =
    evidence.showcase.markdown &&
    evidence.showcase.fullscreen &&
    Boolean(evidence.showcase.image.frame) &&
    evidence.showcase.gif.playback?.status === "playing" &&
    evidence.showcase.video.playback?.status === "playing" &&
    evidence.showcase.formula.includes(adapter.name) &&
    doctor.terminal.adapter?.name === adapter.name &&
    doctor.terminal.adapter.protocol === adapter.protocol &&
    doctor.terminal.adapter.terminal === adapter.terminal;
  await video.togglePlayback();
  await writeEvidence(options.output, evidence);
  await Bun.sleep(options.holdMs);
} catch (error) {
  evidence.error = redactText(error instanceof Error ? error.message : String(error));
  await writeEvidence(options.output, evidence);
  console.error(evidence.error);
  process.exitCode = 1;
} finally {
  preview?.destroyRecursively();
  await preview?.waitForMediaDisposal();
  renderer?.destroy();
  if (fixtureDirectory) await rm(fixtureDirectory, { recursive: true, force: true });
}

function parseOptions(args: readonly string[]): ProbeOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name?.startsWith("--") || value === undefined) {
      throw new Error(`Invalid terminal matrix arguments near ${name ?? "end"}`);
    }
    values.set(name, value);
  }
  const label = values.get("--label");
  const mode = values.get("--mode");
  const output = values.get("--output");
  if (!label || (mode !== "direct" && mode !== "tmux") || !output) {
    throw new Error("Required: --label NAME --mode direct|tmux --output PATH");
  }
  const holdMs = Number.parseInt(values.get("--hold-ms") ?? "20000", 10);
  if (!Number.isInteger(holdMs) || holdMs < 0 || holdMs > 120_000) {
    throw new Error("--hold-ms must be an integer between 0 and 120000");
  }
  const startupDelayMs = Number.parseInt(values.get("--startup-delay-ms") ?? "0", 10);
  if (!Number.isInteger(startupDelayMs) || startupDelayMs < 0 || startupDelayMs > 10_000) {
    throw new Error("--startup-delay-ms must be an integer between 0 and 10000");
  }
  return { label, mode, output: resolve(output), holdMs, startupDelayMs };
}

function terminalEnvironment(): MatrixEvidence["environment"] {
  const {
    TERM: term,
    TERM_PROGRAM: termProgram,
    TERM_PROGRAM_VERSION: termProgramVersion,
    COLORTERM: colorTerm,
    TMUX: tmux,
  } = process.env;
  return {
    ...(term ? { TERM: term } : {}),
    ...(termProgram ? { TERM_PROGRAM: termProgram } : {}),
    ...(termProgramVersion ? { TERM_PROGRAM_VERSION: termProgramVersion } : {}),
    ...(colorTerm ? { COLORTERM: colorTerm } : {}),
    tmux: Boolean(tmux),
  };
}

async function createRemoteResources(
  directory: string,
  probe: ProbeOptions,
): Promise<ReadonlyMap<string, Uint8Array>> {
  const ffmpeg = Bun.which("ffmpeg");
  if (!ffmpeg) throw new Error("ffmpeg is required for the terminal matrix probe");
  const imagePath = join(directory, "matrix.png");
  const gifPath = join(directory, "matrix.gif");
  const videoPath = join(directory, "matrix.mp4");
  await runProcess(
    ffmpeg,
    [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=320x180:rate=1",
      "-frames:v",
      "1",
      "-y",
      imagePath,
    ],
    { timeoutMs: 20_000 },
  );
  await runProcess(
    ffmpeg,
    ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=240x135:rate=10", "-t", "3", "-y", gifPath],
    { timeoutMs: 20_000 },
  );
  await runProcess(
    ffmpeg,
    [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=320x180:rate=12",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=48000",
      "-t",
      "8",
      "-c:v",
      "mpeg4",
      "-q:v",
      "4",
      "-c:a",
      "aac",
      "-shortest",
      "-y",
      videoPath,
    ],
    { timeoutMs: 20_000 },
  );
  const markdown = [
    `# TermLoom terminal matrix: ${probe.label}`,
    "",
    `Mode: **${probe.mode}** · real OpenTUI renderer · remote-resource fixture`,
    "",
    "| Feature | Probe |",
    "| --- | --- |",
    "| Markdown + GFM | loaded |",
    "| PNG / GIF / MP4 / formula | loaded below |",
    "",
    "![PNG test pattern](assets/matrix.png)",
    "",
    "![Animated GIF test pattern](assets/matrix.gif)",
    "",
    "Formula: $E = mc^2$",
    "",
    '<video controls><source src="assets/matrix.mp4" type="video/mp4"></video>',
  ].join("\n");
  return new Map([
    ["/docs/README.md", Buffer.from(markdown)],
    ["/docs/assets/matrix.png", new Uint8Array(await readFile(imagePath))],
    ["/docs/assets/matrix.gif", new Uint8Array(await readFile(gifPath))],
    ["/docs/assets/matrix.mp4", new Uint8Array(await readFile(videoPath))],
  ]);
}

function fixtureRemoteProvider(resources: ReadonlyMap<string, Uint8Array>): RemoteResourceProvider {
  const queue = new TransferQueue(2);
  const resource = (path: string): Uint8Array => {
    const content = resources.get(path);
    if (!content) throw new Error(`Missing remote fixture: ${path}`);
    return content;
  };
  return {
    async stat(_hostId: string, path: string): Promise<FileEntry> {
      const content = resource(path);
      const mimeType = lookup(extname(path));
      return {
        name: path.split("/").at(-1) ?? path,
        path,
        size: content.byteLength,
        isDirectory: false,
        isSymbolicLink: false,
        ...(mimeType ? { mimeType } : {}),
        modifiedAt: new Date("2026-07-28T00:00:00.000Z"),
        hashes: {},
      };
    },
    download(_hostId: string, source: string, destination: string, _policy?: ConflictPolicy) {
      return queue.enqueue({ direction: "download", source, destination }, async () => {
        await writeFile(destination, resource(source), { mode: 0o600 });
        return { destination };
      });
    },
  };
}

function media(preview: RichDocumentRenderable, id: string): DocumentMediaBlockRenderable {
  const block = preview.findDescendantById(id);
  if (!(block instanceof DocumentMediaBlockRenderable)) throw new Error(`Missing ${id}`);
  return block;
}

function mediaEvidence(
  preview: RichDocumentRenderable,
  block: DocumentMediaBlockRenderable,
  statusId: string,
): ProbeMediaEvidence {
  const frame = block.inspectFrame();
  const playback = block.inspectPlayback();
  return {
    status: statusText(preview, statusId),
    ...(frame
      ? {
          frame: {
            width: frame.width,
            height: frame.height,
            ...(frame.timestampSeconds === undefined
              ? {}
              : { timestampSeconds: frame.timestampSeconds }),
          },
        }
      : {}),
    ...(playback ? { playback } : {}),
    processKinds: Object.keys(block.inspectProcesses()).sort(),
  };
}

function statusText(preview: RichDocumentRenderable, id: string): string {
  const status = preview.findDescendantById(id) as TextRenderable | undefined;
  return status?.content.chunks.map((chunk) => chunk.text).join("") ?? "";
}

function key(name: string): KeyEvent {
  return {
    name,
    sequence: name,
    raw: name,
    eventType: "press",
    ctrl: false,
    shift: false,
    meta: false,
    option: false,
    super: false,
    hyper: false,
    number: false,
  } as unknown as KeyEvent;
}

async function waitUntil(predicate: () => boolean, diagnostic: () => string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(25);
  }
  throw new Error(`Timed out: ${diagnostic()}`);
}

async function writeEvidence(path: string, value: MatrixEvidence): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await atomicWriteUtf8(path, `${JSON.stringify(value, null, 2)}\n`);
}
