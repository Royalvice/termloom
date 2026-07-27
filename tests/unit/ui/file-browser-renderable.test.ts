import { afterEach, describe, expect, test } from "bun:test";
import type { InputRenderable, KeyEvent } from "@opentui/core";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
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
  public entries: RemoteFileEntry[] = [
    entry("directory", "/workspace/directory", true),
    entry("README.md", "/workspace/README.md", false, 1024, "text/markdown"),
  ];

  public async list(
    _hostId: string,
    path: string,
    options: { page?: number; pageSize?: number; query?: string } = {},
  ): Promise<DirectoryPage> {
    const filtered = options.query
      ? this.entries.filter((value) => value.name.includes(options.query ?? ""))
      : this.entries;
    return {
      path,
      entries: filtered,
      page: options.page ?? 1,
      pageSize: options.pageSize ?? 100,
      total: filtered.length,
      totalPages: 1,
    };
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

  public download(): TransferHandle {
    throw new Error("Not used by this UI fixture");
  }
}

describe("FileBrowserRenderable", () => {
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
});

async function createBrowser(
  service: FakeFileService,
  callbacks: {
    onUpdate?: (selectedPath: string) => void;
    onPreview?: (path: string) => void;
  } = {},
): Promise<void> {
  setup = await createTestRenderer({ width: 100, height: 20 });
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
