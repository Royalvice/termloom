import { afterEach, describe, expect, test } from "bun:test";
import type { InputRenderable, KeyEvent, ScrollBoxRenderable } from "@opentui/core";
import {
  createMockMouse,
  createTestRenderer,
  MouseButtons,
  type TestRendererSetup,
} from "@opentui/core/testing";
import { TermLoomError } from "../../../src/core/errors.js";
import { I18n } from "../../../src/i18n/i18n.js";
import type {
  ConflictPolicy,
  DirectoryPage,
  FileOperationResult,
  RemoteFileEntry,
} from "../../../src/sftp/rclone-sftp.js";
import { TransferQueue, type TransferHandle } from "../../../src/sftp/transfer-queue.js";
import {
  FileBrowserRenderable,
  type FileBrowserService,
} from "../../../src/ui/file-browser-renderable.js";

let setup: TestRendererSetup | undefined;
let browser: FileBrowserRenderable | undefined;

afterEach(() => {
  browser?.destroyRecursively();
  setup?.renderer.destroy();
  browser = undefined;
  setup = undefined;
});

class FakeFileService implements FileBrowserService {
  public readonly queue = new TransferQueue(1);
  public readonly operations: string[] = [];
  public readonly listRequests: string[] = [];
  public totalPages = 1;
  public listGate: Promise<void> | undefined;
  public entries: RemoteFileEntry[] = [
    entry("directory", "/workspace/directory", true),
    entry("README.md", "/workspace/README.md", false, 1024, "text/markdown"),
  ];

  public async list(
    _hostId: string,
    path: string,
    options: { page?: number; pageSize?: number; query?: string } = {},
  ): Promise<DirectoryPage> {
    this.listRequests.push(`${path}:${options.page ?? 1}:${options.query ?? ""}`);
    const filtered = options.query
      ? this.entries.filter((value) => value.name.includes(options.query ?? ""))
      : this.entries;
    const result = {
      path,
      entries: [...filtered],
      page: options.page ?? 1,
      pageSize: options.pageSize ?? 100,
      total: filtered.length,
      totalPages: this.totalPages,
    };
    const gate = this.listGate;
    this.listGate = undefined;
    if (gate) await gate;
    return result;
  }

  public async mkdir(_hostId: string, path: string): Promise<void> {
    this.operations.push(`mkdir:${path}`);
  }

  public async touch(_hostId: string, path: string): Promise<void> {
    this.operations.push(`touch:${path}`);
  }

  public async rename(
    _hostId: string,
    source: string,
    destination: string,
    policy: ConflictPolicy = "error",
  ): Promise<FileOperationResult> {
    if (policy === "error") {
      throw new TermLoomError({ code: "TRANSFER_CONFLICT", message: "conflict" });
    }
    this.operations.push(`rename:${source}:${destination}:${policy}`);
    return { status: "completed", destination };
  }

  public async copy(
    _hostId: string,
    source: string,
    destination: string,
    policy: ConflictPolicy = "error",
  ): Promise<FileOperationResult> {
    this.operations.push(`copy:${source}:${destination}:${policy}`);
    return { status: "completed", destination };
  }

  public async move(
    _hostId: string,
    source: string,
    destination: string,
    policy: ConflictPolicy = "error",
  ): Promise<FileOperationResult> {
    this.operations.push(`move:${source}:${destination}:${policy}`);
    return { status: "completed", destination };
  }

  public async delete(_hostId: string, path: string): Promise<void> {
    this.operations.push(`delete:${path}`);
  }

  public upload(_hostId: string, localPath: string, remotePath: string): TransferHandle {
    this.operations.push(`upload:${localPath}:${remotePath}`);
    return this.queue.enqueue(
      { direction: "upload", source: localPath, destination: remotePath },
      ({ signal, report }) =>
        new Promise((resolve, reject) => {
          report({ bytes: 512, totalBytes: 1024, speedBytesPerSecond: 128 });
          signal.addEventListener(
            "abort",
            () =>
              reject(
                new TermLoomError({
                  code: "PROCESS_CANCELLED",
                  message: "cancelled",
                }),
              ),
            { once: true },
          );
          void resolve;
        }),
    );
  }

  public download(
    _hostId: string,
    remotePath: string,
    localPath: string,
    policy: ConflictPolicy = "error",
  ): TransferHandle {
    this.operations.push(`download:${remotePath}:${localPath}:${policy}`);
    return this.queue.enqueue(
      { direction: "download", source: remotePath, destination: localPath },
      async ({ report }) => {
        report({ bytes: 1024, totalBytes: 1024, speedBytesPerSecond: 1024 });
        return { destination: localPath };
      },
    );
  }
}

describe("FileBrowserRenderable", () => {
  test("coalesces a refresh requested while a directory listing is still loading", async () => {
    const service = new FakeFileService();
    let releaseList: (() => void) | undefined;
    service.listGate = new Promise<void>((resolve) => {
      releaseList = resolve;
    });
    await createBrowser(service);
    if (!setup || !browser) throw new Error("Expected file browser");
    await setup.waitFor(() => service.listRequests.length === 1);

    service.entries.push(
      entry("created-during-refresh.txt", "/workspace/created-during-refresh.txt", false),
    );
    const queuedRefresh = browser.refresh();
    releaseList?.();
    await queuedRefresh;
    await setup.waitForFrame((frame) => frame.includes("created-during-refresh.txt"));

    expect(service.listRequests).toHaveLength(2);
  });

  test("settles an in-flight and queued refresh without touching destroyed renderables", async () => {
    const service = new FakeFileService();
    let releaseList: (() => void) | undefined;
    service.listGate = new Promise<void>((resolve) => {
      releaseList = resolve;
    });
    await createBrowser(service);
    if (!setup || !browser) throw new Error("Expected file browser");
    await setup.waitFor(() => service.listRequests.length === 1);

    const queuedRefresh = browser.refresh();
    browser.destroyRecursively();
    releaseList?.();
    await queuedRefresh;

    expect(service.listRequests).toHaveLength(1);
  });

  test("renders entries, persists selection, opens previews, and creates directories", async () => {
    const service = new FakeFileService();
    const updates: string[] = [];
    const previews: string[] = [];
    await createBrowser(service, {
      onUpdate: (path) => updates.push(path),
      onPreview: (path) => previews.push(path),
    });

    await setup?.waitForFrame((frame) => frame.includes("README.md"));
    browser?.handleKeyPress(key("down"));
    browser?.handleKeyPress(key("return"));
    expect(updates).toContain("/workspace/README.md");
    expect(previews).toEqual(["/workspace/README.md"]);

    browser?.handleKeyPress(key("n", true));
    const input = await waitForInput();
    input.value = "assets";
    input.submit();
    await setup?.waitFor(() => service.operations.includes("mkdir:/workspace/assets"));
  });

  test("asks for a conflict policy and cancels a running transfer from the pane", async () => {
    const service = new FakeFileService();
    await createBrowser(service);
    await setup?.waitForFrame((frame) => frame.includes("directory"));

    browser?.handleKeyPress(key("r", true));
    const rename = await waitForInput();
    rename.value = "/workspace/renamed";
    rename.submit();
    const conflict = await waitForInput("Conflict policy");
    conflict.value = "overwrite";
    conflict.submit();
    await setup?.waitFor(() =>
      service.operations.includes("rename:/workspace/directory:/workspace/renamed:overwrite"),
    );

    browser?.handleKeyPress(key("u"));
    const upload = await waitForInput();
    upload.value = "/tmp/upload.bin";
    upload.submit();
    await setup?.waitFor(() => service.queue.list().some((job) => job.status === "running"));
    browser?.handleKeyPress(key("x"));
    await setup?.waitFor(() => service.queue.list().some((job) => job.status === "cancelled"));
    await setup?.renderOnce();
    expect(setup?.captureCharFrame()).toContain("was cancelled");
  });

  test("uses mouse selection, double-click preview, and the right-click action menu", async () => {
    const service = new FakeFileService();
    const updates: string[] = [];
    const previews: string[] = [];
    await createBrowser(service, {
      width: 120,
      onUpdate: (path) => updates.push(path),
      onPreview: (path) => previews.push(path),
    });
    if (!setup || !browser) throw new Error("Expected file browser");
    await setup.waitForFrame((frame) => frame.includes("README.md"));
    const mouse = createMockMouse(setup.renderer);
    const list = requiredDescendant("files-list");

    await mouse.click(list.screenX + 2, list.screenY + 2);
    expect(updates).toContain("/workspace/README.md");
    await mouse.doubleClick(list.screenX + 2, list.screenY + 2);
    expect(previews).toContain("/workspace/README.md");

    await mouse.click(list.screenX + 2, list.screenY + 2, MouseButtons.RIGHT);
    const renameMenu = await waitForDescendant("files-context-list");
    await mouse.doubleClick(renameMenu.screenX + 2, renameMenu.screenY + 1);
    const rename = await waitForInput();
    rename.value = "/workspace/README-renamed.md";
    rename.submit();
    const conflict = await waitForInput("Conflict policy");
    conflict.value = "overwrite";
    conflict.submit();
    await setup.waitFor(() =>
      service.operations.includes(
        "rename:/workspace/README.md:/workspace/README-renamed.md:overwrite",
      ),
    );

    await mouse.click(list.screenX + 2, list.screenY + 2, MouseButtons.RIGHT);
    const deleteMenu = await waitForDescendant("files-context-list");
    await mouse.doubleClick(deleteMenu.screenX + 2, deleteMenu.screenY + 5);
    const confirmation = await waitForInput();
    confirmation.value = "DELETE";
    confirmation.submit();
    await setup.waitFor(() => service.operations.includes("delete:/workspace/README.md"));
  });

  test("exposes every file toolbar action to the mouse", async () => {
    const service = new FakeFileService();
    await createBrowser(service, { width: 180 });
    if (!setup || !browser) throw new Error("Expected file browser");
    await setup.waitForFrame((frame) => frame.includes("README.md"));
    const mouse = createMockMouse(setup.renderer);

    const initialLists = service.listRequests.length;
    await clickButton(mouse, "files-refresh");
    await setup.waitFor(() => service.listRequests.length > initialLists);

    await clickButton(mouse, "files-search");
    const search = await waitForInput();
    search.value = "README";
    search.submit();
    await setup.waitFor(() => service.listRequests.some((request) => request.endsWith(":README")));

    await clickButton(mouse, "files-new-file");
    const newFile = await waitForInput();
    newFile.value = "notes.md";
    newFile.submit();
    await setup.waitFor(() => service.operations.includes("touch:/workspace/notes.md"));

    await clickButton(mouse, "files-new-folder");
    const newFolder = await waitForInput();
    newFolder.value = "assets";
    newFolder.submit();
    await setup.waitFor(() => service.operations.includes("mkdir:/workspace/assets"));

    await clickButton(mouse, "files-copy");
    const copy = await waitForInput();
    copy.value = "/workspace/README-copy.md";
    copy.submit();
    await setup.waitFor(() =>
      service.operations.includes("copy:/workspace/README.md:/workspace/README-copy.md:error"),
    );

    await clickButton(mouse, "files-move");
    const move = await waitForInput();
    move.value = "/workspace/README-moved.md";
    move.submit();
    await setup.waitFor(() =>
      service.operations.includes("move:/workspace/README.md:/workspace/README-moved.md:error"),
    );

    await clickButton(mouse, "files-rename");
    const rename = await waitForInput();
    rename.value = "/workspace/README-v2.md";
    rename.submit();
    const conflict = await waitForInput("Conflict policy");
    conflict.value = "rename";
    conflict.submit();
    await setup.waitFor(() =>
      service.operations.includes("rename:/workspace/README.md:/workspace/README-v2.md:rename"),
    );

    await clickButton(mouse, "files-download");
    const download = await waitForInput();
    download.value = "/tmp/README.md";
    download.submit();
    await setup.waitFor(() =>
      service.operations.includes("download:/workspace/README.md:/tmp/README.md:error"),
    );

    await clickButton(mouse, "files-upload");
    const upload = await waitForInput();
    upload.value = "/tmp/upload.bin";
    upload.submit();
    await setup.waitFor(() => service.queue.list().some((job) => job.status === "running"));
    await clickButton(mouse, "files-cancel-transfer");
    await setup.waitFor(() => service.queue.list().some((job) => job.status === "cancelled"));

    await clickButton(mouse, "files-delete");
    const confirmation = await waitForInput();
    confirmation.value = "DELETE";
    confirmation.submit();
    await setup.waitFor(() => service.operations.includes("delete:/workspace/README.md"));
  });

  test("supports mouse path navigation, pagination, and narrow toolbar scrolling", async () => {
    const service = new FakeFileService();
    service.totalPages = 3;
    const updates: string[] = [];
    await createBrowser(service, { width: 42, onUpdate: (path) => updates.push(path) });
    if (!setup || !browser) throw new Error("Expected file browser");
    await setup.waitForFrame((frame) => frame.includes("README.md"));
    const mouse = createMockMouse(setup.renderer);

    const path = requiredDescendant("files-path") as InputRenderable;
    await mouse.click(path.screenX + 2, path.screenY);
    path.value = "/var/log";
    path.submit();
    await setup.waitFor(() =>
      service.listRequests.some((request) => request.startsWith("/var/log:1:")),
    );
    expect(updates).toContain("/var/log");

    await clickButton(mouse, "files-page-next");
    await setup.waitFor(() =>
      service.listRequests.some((request) => request.startsWith("/var/log:2:")),
    );
    await clickButton(mouse, "files-page-previous");
    await setup.waitFor(
      () => service.listRequests.filter((request) => request.startsWith("/var/log:1:")).length >= 2,
    );

    const toolbar = requiredDescendant("files-toolbar") as ScrollBoxRenderable;
    const before = toolbar.scrollLeft;
    await mouse.scroll(toolbar.screenX + 2, toolbar.screenY, "right");
    await setup.renderOnce();
    expect(toolbar.scrollLeft).toBeGreaterThan(before);
  });
});

async function createBrowser(
  service: FakeFileService,
  callbacks: {
    width?: number;
    height?: number;
    onUpdate?: (selectedPath: string) => void;
    onPreview?: (path: string) => void;
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
      hostId: "fixture",
      path: "/workspace",
    },
    service,
    i18n: new I18n("en"),
    onPaneUpdate: (pane) => callbacks.onUpdate?.(pane.selectedPath ?? pane.path),
    onOpenPreview: (_pane, selected) => callbacks.onPreview?.(selected.path),
  });
  setup.renderer.root.add(browser);
  browser.focus();
}

function requiredDescendant(id: string) {
  const descendant = browser?.findDescendantById(id);
  if (!descendant) throw new Error(`Expected ${id}`);
  return descendant;
}

async function waitForDescendant(id: string) {
  await setup?.waitFor(() => Boolean(browser?.findDescendantById(id)));
  return requiredDescendant(id);
}

async function clickButton(mouse: ReturnType<typeof createMockMouse>, id: string): Promise<void> {
  const button = requiredDescendant(id);
  await mouse.click(button.screenX + 1, button.screenY);
}

async function waitForInput(title?: string): Promise<InputRenderable> {
  await setup?.waitFor(() => {
    const input = browser?.findDescendantById("files-modal-input");
    if (!input) return false;
    if (!title) return true;
    return setup?.captureCharFrame().includes(title) ?? false;
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
): RemoteFileEntry {
  return { name, path, isDirectory, size, mimeType, hashes: {} };
}
