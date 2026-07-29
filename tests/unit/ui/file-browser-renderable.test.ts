import { afterEach, describe, expect, test } from "bun:test";
import type { InputRenderable, KeyEvent } from "@opentui/core";
import {
  createMockMouse,
  createTestRenderer,
  MouseButtons,
  type TestRendererSetup,
} from "@opentui/core/testing";
import { TermLoomError } from "../../../src/core/errors.js";
import {
  paginateEntries,
  type ConflictPolicy,
  type DirectoryPage,
  type DirectoryQuery,
  type FileEntry,
  type FileOperationResult,
  type FileProvider,
} from "../../../src/files/file-provider.js";
import { I18n } from "../../../src/i18n/i18n.js";
import { TransferQueue, type TransferHandle } from "../../../src/sftp/transfer-queue.js";
import type { ContextMenuRequest } from "../../../src/ui/dismissible-overlay-controller.js";
import { FileBrowserRenderable } from "../../../src/ui/file-browser-renderable.js";
import { theme } from "../../../src/ui/theme.js";

let setup: TestRendererSetup | undefined;
let browser: FileBrowserRenderable | undefined;

afterEach(() => {
  browser?.destroyRecursively();
  setup?.renderer.destroy();
  browser = undefined;
  setup = undefined;
});

class FakeFileProvider implements FileProvider {
  public readonly kind: "local" | "sftp";
  public readonly queue = new TransferQueue(1);
  public readonly operations: string[] = [];
  public readonly listRequests: string[] = [];
  public readonly directoryGates = new Map<string, Promise<void>>();
  public conflictNext = false;
  public totalPages = 1;
  public readonly directories = new Map<string, FileEntry[]>([
    [
      "/workspace",
      [
        entry("folder-a", "/workspace/folder-a", true),
        entry("folder-b", "/workspace/folder-b", true),
        entry("README.md", "/workspace/README.md", false, 1_024, "text/markdown"),
        entry("photo.png", "/workspace/photo.png", false, 2_048, "image/png"),
        entry("clip.mp4", "/workspace/clip.mp4", false, 4_096, "video/mp4"),
        entry("source.ts", "/workspace/source.ts", false, 512, "text/typescript"),
      ],
    ],
    ["/", [entry("workspace", "/workspace", true)]],
    ["/workspace/folder-a", [entry("old.txt", "/workspace/folder-a/old.txt", false)]],
    ["/workspace/folder-b", [entry("new.txt", "/workspace/folder-b/new.txt", false)]],
  ]);

  public constructor(kind: "local" | "sftp" = "sftp") {
    this.kind = kind;
  }

  public async list(path: string, options: DirectoryQuery = {}): Promise<DirectoryPage> {
    this.listRequests.push(`${path}:${options.page ?? 1}:${options.query ?? ""}`);
    const gate = this.directoryGates.get(path);
    if (gate) await gate;
    const page = paginateEntries(path, this.directories.get(path) ?? [], options);
    return this.totalPages === 1 ? page : { ...page, totalPages: this.totalPages };
  }

  public async stat(path: string): Promise<FileEntry> {
    for (const entries of this.directories.values()) {
      const found = entries.find((value) => value.path === path);
      if (found) return found;
    }
    throw new Error(`Missing fixture entry: ${path}`);
  }

  public async createDirectory(path: string): Promise<void> {
    this.operations.push(`mkdir:${path}`);
  }

  public async createFile(path: string): Promise<void> {
    this.operations.push(`touch:${path}`);
  }

  public async rename(
    source: string,
    destination: string,
    policy: ConflictPolicy = "error",
  ): Promise<FileOperationResult> {
    if (this.conflictNext && policy === "error") {
      this.conflictNext = false;
      throw new TermLoomError({ code: "TRANSFER_CONFLICT", message: "conflict" });
    }
    this.operations.push(`rename:${source}:${destination}:${policy}`);
    return { status: "completed", destination };
  }

  public async copy(
    source: string,
    destination: string,
    policy: ConflictPolicy = "error",
  ): Promise<FileOperationResult> {
    this.operations.push(`copy:${source}:${destination}:${policy}`);
    return { status: "completed", destination };
  }

  public async move(
    source: string,
    destination: string,
    policy: ConflictPolicy = "error",
  ): Promise<FileOperationResult> {
    this.operations.push(`move:${source}:${destination}:${policy}`);
    return { status: "completed", destination };
  }

  public upload(
    localPath: string,
    remotePath: string,
    policy: ConflictPolicy = "error",
  ): TransferHandle {
    this.operations.push(`upload:${localPath}:${remotePath}:${policy}`);
    return this.queue.enqueue(
      { direction: "upload", source: localPath, destination: remotePath },
      async () => ({ destination: remotePath }),
    );
  }

  public download(
    remotePath: string,
    localPath: string,
    policy: ConflictPolicy = "error",
  ): TransferHandle {
    this.operations.push(`download:${remotePath}:${localPath}:${policy}`);
    return this.queue.enqueue(
      { direction: "download", source: remotePath, destination: localPath },
      async () => ({ destination: localPath }),
    );
  }
}

describe("FileBrowserRenderable", () => {
  test("coalesces a refresh requested while the current directory is still loading", async () => {
    const provider = new FakeFileProvider();
    let release: (() => void) | undefined;
    provider.directoryGates.set(
      "/workspace",
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    await createBrowser(provider);
    await setup?.waitFor(() => provider.listRequests.includes("/workspace:1:"));

    const queued = browser?.refresh();
    provider.directoryGates.delete("/workspace");
    release?.();
    await queued;

    expect(
      provider.listRequests.filter((request) => request.startsWith("/workspace:")),
    ).toHaveLength(2);
    await setup?.renderOnce();
    expect(setup?.captureCharFrame()).toContain("README.md");
    expect(setup?.captureCharFrame()).not.toContain("Loading…");
  });

  test("uses three, two, and single-column layouts at the fixed breakpoints", async () => {
    const provider = new FakeFileProvider();
    await createBrowser(provider, { width: 120, height: 24 });
    await waitForReady();
    expect(requiredDescendant("files-parent-column").visible).toBe(true);
    expect(requiredDescendant("files-current-column").visible).toBe(true);
    expect(requiredDescendant("files-preview-column").visible).toBe(true);

    setup?.resize(80, 24);
    await setup?.renderOnce();
    expect(requiredDescendant("files-parent-column").visible).toBe(false);
    expect(requiredDescendant("files-current-column").visible).toBe(true);
    expect(requiredDescendant("files-preview-column").visible).toBe(true);

    setup?.resize(44, 24);
    await setup?.renderOnce();
    expect(requiredDescendant("files-parent-column").visible).toBe(false);
    expect(requiredDescendant("files-current-column").visible).toBe(true);
    expect(requiredDescendant("files-preview-column").visible).toBe(false);

    browser?.handleKeyPress(key("down"));
    browser?.handleKeyPress(key("down"));
    browser?.handleKeyPress(key("return"));
    await setup?.renderOnce();
    expect(requiredDescendant("files-current-column").visible).toBe(false);
    expect(requiredDescendant("files-preview-column").visible).toBe(true);

    browser?.handleKeyPress(key("escape"));
    await setup?.renderOnce();
    expect(requiredDescendant("files-current-column").visible).toBe(true);
    expect(requiredDescendant("files-preview-column").visible).toBe(false);
  });

  test("renders file kinds with actual theme-colored spans", async () => {
    const provider = new FakeFileProvider();
    await createBrowser(provider, { width: 120 });
    await waitForReady();
    await setup?.renderOnce();

    expect(spanColor("folder-a")).toEqual(hexInts(theme.accent));
    expect(spanColor("README.md")).toEqual(hexInts(theme.success));
    expect(spanColor("photo.png")).toEqual(hexInts("#89dceb"));
    expect(spanColor("clip.mp4")).toEqual(hexInts(theme.warning));
    expect(spanColor("source.ts")).toEqual(hexInts(theme.muted));
  });

  test("single-clicks preview files, double-clicks directories, and persists selection", async () => {
    const provider = new FakeFileProvider();
    const updates: string[] = [];
    await createBrowser(provider, {
      width: 120,
      onUpdate: (selectedPath) => updates.push(selectedPath),
    });
    await waitForReady();
    const mouse = createMockMouse(requiredSetup().renderer);
    const readme = requiredDescendant("files-current-list-row-4");

    await mouse.click(readme.screenX + 2, readme.screenY);
    expect(updates).toContain("/workspace/README.md");
    await Bun.sleep(180);
    await requiredSetup().waitForFrame((frame) => frame.includes("text/markdown"));

    const folder = requiredDescendant("files-current-list-row-0");
    await mouse.doubleClick(folder.screenX + 2, folder.screenY);
    await requiredSetup().waitFor(() =>
      provider.listRequests.some((value) => value.startsWith("/workspace/folder-a:")),
    );
    expect(updates).toContain("/workspace/folder-a");
  });

  test("prevents a slower stale directory preview from replacing the latest selection", async () => {
    const provider = new FakeFileProvider();
    let releaseOld: (() => void) | undefined;
    provider.directoryGates.set(
      "/workspace/folder-a",
      new Promise<void>((resolve) => {
        releaseOld = resolve;
      }),
    );
    await createBrowser(provider, { width: 120 });
    await waitForReady();
    await Bun.sleep(180);
    browser?.handleKeyPress(key("down"));
    await Bun.sleep(180);
    await requiredSetup().waitForFrame((frame) => frame.includes("new.txt"));

    provider.directoryGates.delete("/workspace/folder-a");
    releaseOld?.();
    await Bun.sleep(20);
    await requiredSetup().renderOnce();
    const frame = requiredSetup().captureCharFrame();
    expect(frame).toContain("new.txt");
    expect(frame).not.toContain("old.txt");
  });

  test("anchors remote context actions at the pointer and never exposes Delete", async () => {
    const provider = new FakeFileProvider("sftp");
    const requests: ContextMenuRequest[] = [];
    const splitPreviews: string[] = [];
    await createBrowser(provider, {
      width: 120,
      onContextMenu: (request) => requests.push(request),
      onOpenPreview: (path) => splitPreviews.push(path),
    });
    await waitForReady();
    const row = requiredDescendant("files-current-list-row-4");
    const x = row.screenX + 5;
    const y = row.screenY;
    await createMockMouse(requiredSetup().renderer).click(x, y, MouseButtons.RIGHT);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.x).toBe(x);
    expect(requests[0]?.y).toBe(y);
    expect(requests[0]?.actions.map((action) => action.label)).toEqual([
      "Open Preview",
      "Open in Split",
      "Rename…",
      "Copy…",
      "Move…",
      "Download…",
    ]);
    expect(requests[0]?.actions.some((action) => /delete/i.test(action.label))).toBe(false);
    requests[0]?.actions.find((action) => action.id === "open-split")?.run();
    expect(splitPreviews).toEqual(["/workspace/README.md"]);
  });

  test("exposes all non-destructive contextual operations through F1 commands", async () => {
    const provider = new FakeFileProvider("sftp");
    await createBrowser(provider, { width: 120 });
    await waitForReady();
    const readme = requiredDescendant("files-current-list-row-4");
    await createMockMouse(requiredSetup().renderer).click(readme.screenX + 2, readme.screenY);

    const commands = browser?.contextCommands() ?? [];
    expect(commands.map((command) => command.id)).toEqual([
      "file-refresh",
      "file-search",
      "file-new-file",
      "file-new-folder",
      "file-upload",
      "file-open",
      "file-open-split",
      "file-rename",
      "file-copy",
      "file-move",
      "file-download",
    ]);
    expect(commands.some((command) => /delete/i.test(`${command.id} ${command.title}`))).toBe(
      false,
    );

    commands.find((command) => command.id === "file-new-file")?.run();
    const newFile = await waitForInput();
    newFile.value = "notes.md";
    newFile.submit();
    await requiredSetup().waitFor(() => provider.operations.includes("touch:/workspace/notes.md"));

    provider.conflictNext = true;
    browser
      ?.contextCommands()
      .find((command) => command.id === "file-rename")
      ?.run();
    const rename = await waitForInput();
    rename.value = "/workspace/README-v2.md";
    rename.submit();
    const conflict = await waitForInput("Conflict policy");
    conflict.value = "overwrite";
    conflict.submit();
    await requiredSetup().waitFor(() =>
      provider.operations.includes("rename:/workspace/README.md:/workspace/README-v2.md:overwrite"),
    );
  });

  test("has no Files text toolbar or deletion capability", async () => {
    const provider = new FakeFileProvider();
    await createBrowser(provider, { width: 200, height: 60 });
    await waitForReady();
    const frame = requiredSetup().captureCharFrame();
    expect(browser?.findDescendantById("files-toolbar")).toBeUndefined();
    expect(frame).not.toContain("New Folder Upload Download Rename Copy Move Delete");
    expect("delete" in provider).toBe(false);
  });
});

async function createBrowser(
  provider: FakeFileProvider,
  callbacks: {
    width?: number;
    height?: number;
    onUpdate?: (selectedPath: string) => void;
    onContextMenu?: (request: ContextMenuRequest) => void;
    onOpenPreview?: (path: string) => void;
  } = {},
): Promise<void> {
  setup = await createTestRenderer({
    width: callbacks.width ?? 100,
    height: callbacks.height ?? 20,
  });
  browser = new FileBrowserRenderable(setup.renderer, {
    id: "files",
    pane: {
      id: "files-pane",
      kind: "files",
      title: "Fixture files",
      target: provider.kind === "local" ? { kind: "local" } : { kind: "ssh", hostId: "fixture" },
      path: "/workspace",
    },
    provider,
    i18n: new I18n("en"),
    onPaneUpdate: (pane) => callbacks.onUpdate?.(pane.selectedPath ?? pane.path),
    onContextMenu: (request) => callbacks.onContextMenu?.(request),
    onOpenPreview: (_pane, entry) => callbacks.onOpenPreview?.(entry.path),
  });
  setup.renderer.root.add(browser);
  browser.focus();
}

async function waitForReady(): Promise<void> {
  await requiredSetup().waitForFrame(
    (frame) => frame.includes("README.md") && !frame.includes("Loading…"),
  );
}

function requiredSetup(): TestRendererSetup {
  if (!setup) throw new Error("Expected test renderer");
  return setup;
}

function requiredDescendant(id: string) {
  const descendant = browser?.findDescendantById(id);
  if (!descendant) throw new Error(`Expected ${id}`);
  return descendant;
}

async function waitForInput(title?: string): Promise<InputRenderable> {
  await requiredSetup().waitFor(() => {
    const input = browser?.findDescendantById("files-modal-input");
    if (!input) return false;
    return title ? requiredSetup().captureCharFrame().includes(title) : true;
  });
  const input = browser?.findDescendantById("files-modal-input");
  if (!input || !("submit" in input)) throw new Error("Expected modal input");
  return input as InputRenderable;
}

function key(name: string, shift = false): KeyEvent {
  return {
    name,
    sequence: name,
    raw: name,
    eventType: "press",
    ctrl: false,
    meta: false,
    shift,
    super: false,
    hyper: false,
    option: false,
    number: false,
  } as unknown as KeyEvent;
}

function entry(
  name: string,
  path: string,
  isDirectory: boolean,
  size = 0,
  mimeType?: string,
): FileEntry {
  return {
    name,
    path,
    isDirectory,
    isSymbolicLink: false,
    size,
    mimeType,
    modifiedAt: new Date("2026-01-02T03:04:00Z"),
    mode: isDirectory ? 0o755 : 0o644,
    hashes: {},
  };
}

function hexInts(hex: string): [number, number, number, number] {
  const value = hex.replace(/^#/, "");
  return [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16),
    255,
  ];
}

function spanColor(text: string): [number, number, number, number] | undefined {
  for (const line of requiredSetup().captureSpans().lines) {
    const span = line.spans.find((candidate) => candidate.text.includes(text));
    if (span) return span.fg.toInts();
  }
  return undefined;
}
