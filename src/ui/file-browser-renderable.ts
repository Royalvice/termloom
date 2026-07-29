import { basename as localBasename, join as localJoin } from "node:path";
import { posix } from "node:path";
import {
  BoxRenderable,
  type CliRenderer,
  InputRenderable,
  InputRenderableEvents,
  type KeyEvent,
  MouseButton,
  type RenderContext,
  SelectRenderable,
  SelectRenderableEvents,
  ScrollBoxRenderable,
  TextAttributes,
  TextRenderable,
} from "@opentui/core";
import { TermLoomError, errorMessage } from "../core/errors.js";
import type { I18n } from "../i18n/i18n.js";
import type {
  ConflictPolicy,
  DirectoryPage,
  FileOperationResult,
  RemoteFileEntry,
} from "../sftp/rclone-sftp.js";
import type { TransferHandle, TransferQueue } from "../sftp/transfer-queue.js";
import type { PaneState } from "../workspace/schema.js";
import { attachMouseSelect } from "./mouse-select-adapter.js";
import { theme } from "./theme.js";

type FilesPaneState = Extract<PaneState, { kind: "files" }>;

export interface FileBrowserService {
  readonly queue: TransferQueue;
  list(
    hostId: string,
    path: string,
    options?: { page?: number; pageSize?: number; query?: string },
  ): Promise<DirectoryPage>;
  mkdir(hostId: string, path: string): Promise<void>;
  touch(hostId: string, path: string): Promise<void>;
  rename(
    hostId: string,
    source: string,
    destination: string,
    policy?: ConflictPolicy,
  ): Promise<FileOperationResult>;
  copy(
    hostId: string,
    source: string,
    destination: string,
    policy?: ConflictPolicy,
  ): Promise<FileOperationResult>;
  move(
    hostId: string,
    source: string,
    destination: string,
    policy?: ConflictPolicy,
  ): Promise<FileOperationResult>;
  delete(hostId: string, path: string): Promise<void>;
  upload(
    hostId: string,
    localPath: string,
    remotePath: string,
    policy?: ConflictPolicy,
  ): TransferHandle;
  download(
    hostId: string,
    remotePath: string,
    localPath: string,
    policy?: ConflictPolicy,
  ): TransferHandle;
}

export interface FileBrowserOptions {
  id: string;
  pane: FilesPaneState;
  service: FileBrowserService;
  i18n: I18n;
  onPaneUpdate?: (pane: FilesPaneState) => void;
  onOpenPreview?: (pane: FilesPaneState, entry: RemoteFileEntry) => void;
}

type PromptSubmit = (value: string) => Promise<void> | void;

export class FileBrowserRenderable extends BoxRenderable {
  private pane: FilesPaneState;
  private readonly service: FileBrowserService;
  private readonly i18n: I18n;
  private readonly onPaneUpdate: ((pane: FilesPaneState) => void) | undefined;
  private readonly onOpenPreview:
    | ((pane: FilesPaneState, entry: RemoteFileEntry) => void)
    | undefined;
  private readonly header: TextRenderable;
  private readonly pathInput: InputRenderable;
  private readonly pageIndicator: TextRenderable;
  private readonly list: SelectRenderable;
  private readonly footer: TextRenderable;
  private entries: readonly RemoteFileEntry[] = [];
  private page = 1;
  private pageSize = 100;
  private totalPages = 1;
  private query = "";
  private modal: BoxRenderable | undefined;
  private modalInput: InputRenderable | undefined;
  private modalMouseDispose: (() => void) | undefined;
  private refreshRequested = 0;
  private refreshCompleted = 0;
  private refreshPromise: Promise<void> | undefined;
  private disposed = false;
  private readonly unsubscribeTransfer: () => void;
  private readonly disposeMouse: () => void;

  public constructor(renderer: CliRenderer, options: FileBrowserOptions) {
    super(renderer, {
      id: options.id,
      width: "100%",
      height: "100%",
      flexDirection: "column",
      focusable: true,
      backgroundColor: theme.background,
      overflow: "hidden",
    });
    this.pane = options.pane;
    this.service = options.service;
    this.i18n = options.i18n;
    this.onPaneUpdate = options.onPaneUpdate;
    this.onOpenPreview = options.onOpenPreview;
    const pathRow = new BoxRenderable(renderer, {
      id: `${options.id}-path-row`,
      height: 1,
      width: "100%",
      flexDirection: "row",
      backgroundColor: theme.surfaceRaised,
    });
    this.header = new TextRenderable(renderer, {
      id: `${options.id}-header`,
      height: 1,
      content: ` ${this.pane.hostId}: `,
      fg: theme.accent,
      attributes: TextAttributes.BOLD,
    });
    pathRow.add(this.header);
    this.pathInput = new FilePathInputRenderable(
      renderer,
      {
        id: `${options.id}-path`,
        flexGrow: 1,
        value: this.pane.path,
        placeholder: "Remote path",
        backgroundColor: theme.surface,
        focusedBackgroundColor: theme.selection,
        textColor: theme.foreground,
        cursorColor: theme.accent,
      },
      () => this.list.focus(),
    );
    this.pathInput.on(InputRenderableEvents.ENTER, (value: string) => {
      void this.navigate(value.trim() || ".");
      this.list.focus();
    });
    pathRow.add(this.pathInput);
    pathRow.add(this.fileButton(renderer, "page-previous", " ‹ ", () => this.previousPage()));
    this.pageIndicator = new TextRenderable(renderer, {
      id: `${options.id}-page-indicator`,
      content: " 1/1 ",
      fg: theme.muted,
      bg: theme.surfaceRaised,
    });
    pathRow.add(this.pageIndicator);
    pathRow.add(this.fileButton(renderer, "page-next", " › ", () => this.nextPage()));
    this.list = new SelectRenderable(renderer, {
      id: `${options.id}-list`,
      flexGrow: 1,
      width: "100%",
      options: [],
      showDescription: true,
      showScrollIndicator: true,
      wrapSelection: false,
      backgroundColor: theme.background,
      textColor: theme.foreground,
      selectedBackgroundColor: theme.selection,
      selectedTextColor: theme.foreground,
      descriptionColor: theme.muted,
      selectedDescriptionColor: theme.foreground,
    });
    this.list.on(SelectRenderableEvents.SELECTION_CHANGED, () => this.persistSelection());
    this.disposeMouse = attachMouseSelect(this.list, {
      onClick: () => this.persistSelection(),
      onDoubleClick: () => void this.openSelected(),
      onContextMenu: () => this.openContextMenu(),
    });
    this.footer = new TextRenderable(renderer, {
      id: `${options.id}-footer`,
      height: 2,
      width: "100%",
      content: this.i18n.t("file.shortcuts"),
      fg: theme.muted,
      attributes: TextAttributes.DIM,
    });
    this.add(pathRow);
    this.add(this.createToolbar(renderer));
    this.add(this.list);
    this.add(this.footer);
    this.unsubscribeTransfer = this.service.queue.onChange((job) => {
      if (job.source !== this.pane.path && job.destination !== this.pane.path) {
        const total = job.progress.totalBytes ?? 0;
        this.footer.content = this.i18n.t("file.transferring", {
          status: job.status,
          bytes: job.progress.bytes,
          total,
        });
        this.requestRender();
      }
    });
    void this.refresh();
  }

  public override focus(): void {
    super.focus();
  }

  public refreshAppearance(): void {
    this.backgroundColor = theme.background;
    this.header.fg = theme.accent;
    this.pathInput.backgroundColor = theme.surface;
    this.pathInput.focusedBackgroundColor = theme.selection;
    this.pathInput.textColor = theme.foreground;
    this.pathInput.cursorColor = theme.accent;
    this.list.backgroundColor = theme.background;
    this.list.textColor = theme.foreground;
    this.list.selectedBackgroundColor = theme.selection;
    this.list.selectedTextColor = theme.foreground;
    this.list.descriptionColor = theme.muted;
    this.list.selectedDescriptionColor = theme.foreground;
    this.footer.fg = theme.muted;
    this.requestRender();
  }

  public override handleKeyPress(key: KeyEvent): boolean {
    if (this.modalInput) {
      if (key.name === "escape") {
        this.closePrompt();
        return true;
      }
      return false;
    }
    if (key.ctrl || key.meta || key.super || key.eventType === "release") return false;
    if (key.name === "up" || key.name === "k") {
      this.list.moveUp();
      this.persistSelection();
      return true;
    }
    if (key.name === "down" || key.name === "j") {
      this.list.moveDown();
      this.persistSelection();
      return true;
    }
    if (key.name === "return") {
      void this.openSelected();
      return true;
    }
    if (key.name === "escape") {
      void this.navigate(posix.dirname(this.pane.path));
      return true;
    }
    if (key.name === "r" && key.shift) {
      this.promptForSelected(
        "file.rename",
        (entry) => entry.path,
        (entry, value) =>
          this.withConflict((policy) =>
            this.service.rename(this.pane.hostId, entry.path, value, policy),
          ),
      );
      return true;
    }
    if (key.name === "r") {
      void this.refresh();
      return true;
    }
    if (key.name === "n" && key.shift) {
      this.showPrompt("file.newDirectory", "", async (value) => {
        await this.runOperation(() =>
          this.service.mkdir(this.pane.hostId, posix.join(this.pane.path, value)),
        );
      });
      return true;
    }
    if (key.name === "n") {
      this.showPrompt("file.newFile", "", async (value) => {
        await this.runOperation(() =>
          this.service.touch(this.pane.hostId, posix.join(this.pane.path, value)),
        );
      });
      return true;
    }
    if (key.name === "/") {
      this.showPrompt("file.search", this.query, async (value) => {
        this.query = value;
        this.page = 1;
        await this.refresh();
      });
      return true;
    }
    if (key.name === "c") {
      this.promptForSelected(
        "file.copy",
        (entry) => `${entry.path}.copy`,
        (entry, value) =>
          this.withConflict((policy) =>
            this.service.copy(this.pane.hostId, entry.path, value, policy),
          ),
      );
      return true;
    }
    if (key.name === "m") {
      this.promptForSelected(
        "file.move",
        (entry) => entry.path,
        (entry, value) =>
          this.withConflict((policy) =>
            this.service.move(this.pane.hostId, entry.path, value, policy),
          ),
      );
      return true;
    }
    if (key.name === "d" && key.shift) {
      this.promptDownload();
      return true;
    }
    if (key.name === "d") {
      this.confirmDelete();
      return true;
    }
    if (key.name === "u") {
      this.showPrompt("file.upload", "", async (value) => {
        const destination = posix.join(this.pane.path, localBasename(value));
        await this.runTransferWithConflict((policy) =>
          this.service.upload(this.pane.hostId, value, destination, policy),
        );
      });
      return true;
    }
    if (key.name === "x") {
      const active = this.service.queue
        .list()
        .findLast((job) => job.status === "queued" || job.status === "running");
      if (active) this.service.queue.cancel(active.id);
      else {
        this.footer.content = this.i18n.t("file.noTransfer");
        this.footer.fg = theme.warning;
        this.requestRender();
      }
      return true;
    }
    if (key.name === "[") {
      this.previousPage();
      return true;
    }
    if (key.name === "]") {
      this.nextPage();
      return true;
    }
    return false;
  }

  public async refresh(): Promise<void> {
    if (this.disposed) return;
    const target = ++this.refreshRequested;
    while (this.refreshCompleted < target) {
      if (this.disposed) {
        this.refreshCompleted = target;
        return;
      }
      this.refreshPromise ??= this.refreshOnce();
      await this.refreshPromise;
    }
  }

  private async refreshOnce(): Promise<void> {
    const generation = this.refreshRequested;
    this.header.content = ` ${this.pane.hostId}: ${this.i18n.t("file.loading")} `;
    this.requestRender();
    try {
      const result = await this.service.list(this.pane.hostId, this.pane.path, {
        page: this.page,
        pageSize: this.pageSize,
        query: this.query,
      });
      if (this.disposed) return;
      this.page = result.page;
      this.pageSize = result.pageSize;
      this.totalPages = result.totalPages;
      this.entries = result.entries;
      this.list.options = result.entries.length
        ? result.entries.map((entry) => ({
            name: `${entry.isDirectory ? "▣" : "·"} ${entry.name}`,
            description: entry.isDirectory
              ? "directory"
              : `${formatBytes(entry.size)}${entry.mimeType ? `  ${entry.mimeType}` : ""}`,
            value: entry.path,
          }))
        : [{ name: this.i18n.t("file.empty"), description: "", value: undefined }];
      const selectedIndex = this.pane.selectedPath
        ? result.entries.findIndex((entry) => entry.path === this.pane.selectedPath)
        : 0;
      this.list.setSelectedIndex(Math.max(0, selectedIndex));
      this.header.content = ` ${this.pane.hostId}: `;
      this.pathInput.value = this.pane.path;
      this.pageIndicator.content = ` ${this.page}/${this.totalPages} `;
      this.footer.content = this.i18n.t("file.shortcuts");
    } catch (error) {
      if (!this.disposed) this.showError(error);
    } finally {
      this.refreshCompleted = Math.max(this.refreshCompleted, generation);
      this.refreshPromise = undefined;
      if (!this.disposed) this.requestRender();
    }
  }

  protected override destroySelf(): void {
    this.disposed = true;
    this.refreshCompleted = this.refreshRequested;
    this.disposeMouse();
    this.unsubscribeTransfer();
    this.closePrompt();
    super.destroySelf();
  }

  private selected(): RemoteFileEntry | undefined {
    return this.entries[this.list.getSelectedIndex()];
  }

  private persistSelection(): void {
    const selected = this.selected();
    if (!selected) return;
    this.pane = { ...this.pane, selectedPath: selected.path };
    this.onPaneUpdate?.(this.pane);
  }

  private async openSelected(): Promise<void> {
    const selected = this.selected();
    if (!selected) return;
    if (selected.isDirectory) await this.navigate(selected.path);
    else this.onOpenPreview?.(this.pane, selected);
  }

  private async navigate(path: string): Promise<void> {
    if (path === this.pane.path) return;
    this.page = 1;
    this.query = "";
    this.pane = {
      ...this.pane,
      path,
      selectedPath: undefined,
      title: `${this.pane.hostId}:${path}`,
    };
    this.onPaneUpdate?.(this.pane);
    await this.refresh();
  }

  private createToolbar(renderer: CliRenderer): ScrollBoxRenderable {
    const toolbar = new ScrollBoxRenderable(renderer, {
      id: `${this.id}-toolbar`,
      width: "100%",
      height: 1,
      scrollX: true,
      scrollY: false,
      viewportCulling: true,
      rootOptions: { backgroundColor: theme.surfaceRaised },
      contentOptions: {
        flexDirection: "row",
        height: 1,
        backgroundColor: theme.surfaceRaised,
      },
    });
    toolbar.add(this.fileButton(renderer, "refresh", " Refresh ", () => void this.refresh()));
    toolbar.add(this.fileButton(renderer, "search", " Search ", () => this.promptSearch()));
    toolbar.add(this.fileButton(renderer, "new-file", " New File ", () => this.promptNewFile()));
    toolbar.add(
      this.fileButton(renderer, "new-folder", " New Folder ", () => this.promptNewFolder()),
    );
    toolbar.add(this.fileButton(renderer, "upload", " Upload ", () => this.promptUpload()));
    toolbar.add(this.fileButton(renderer, "download", " Download ", () => this.promptDownload()));
    toolbar.add(this.fileButton(renderer, "rename", " Rename ", () => this.promptRename()));
    toolbar.add(this.fileButton(renderer, "copy", " Copy ", () => this.promptCopy()));
    toolbar.add(this.fileButton(renderer, "move", " Move ", () => this.promptMove()));
    toolbar.add(this.fileButton(renderer, "delete", " Delete ", () => this.confirmDelete()));
    toolbar.add(
      this.fileButton(renderer, "cancel-transfer", " Cancel Transfer ", () =>
        this.cancelLatestTransfer(),
      ),
    );
    return toolbar;
  }

  private fileButton(
    renderer: CliRenderer,
    name: string,
    label: string,
    run: () => void,
  ): TextRenderable {
    return new TextRenderable(renderer, {
      id: `${this.id}-${name}`,
      content: label,
      fg: name === "delete" ? theme.error : theme.accent,
      bg: theme.surfaceRaised,
      onMouseOver: () => renderer.setMousePointer("pointer"),
      onMouseOut: () => renderer.setMousePointer("default"),
      onMouseDown: (event) => {
        if (event.button !== MouseButton.LEFT) return;
        run();
        event.preventDefault();
        event.stopPropagation();
      },
    });
  }

  private promptSearch(): void {
    this.showPrompt("file.search", this.query, async (value) => {
      this.query = value;
      this.page = 1;
      await this.refresh();
    });
  }

  private promptNewFile(): void {
    this.showPrompt("file.newFile", "", async (value) => {
      await this.runOperation(() =>
        this.service.touch(this.pane.hostId, posix.join(this.pane.path, value)),
      );
    });
  }

  private promptNewFolder(): void {
    this.showPrompt("file.newDirectory", "", async (value) => {
      await this.runOperation(() =>
        this.service.mkdir(this.pane.hostId, posix.join(this.pane.path, value)),
      );
    });
  }

  private promptUpload(): void {
    this.showPrompt("file.upload", "", async (value) => {
      const destination = posix.join(this.pane.path, localBasename(value));
      await this.runTransferWithConflict((policy) =>
        this.service.upload(this.pane.hostId, value, destination, policy),
      );
    });
  }

  private promptRename(): void {
    this.promptForSelected(
      "file.rename",
      (entry) => entry.path,
      (entry, value) =>
        this.withConflict((policy) =>
          this.service.rename(this.pane.hostId, entry.path, value, policy),
        ),
    );
  }

  private promptCopy(): void {
    this.promptForSelected(
      "file.copy",
      (entry) => `${entry.path}.copy`,
      (entry, value) =>
        this.withConflict((policy) =>
          this.service.copy(this.pane.hostId, entry.path, value, policy),
        ),
    );
  }

  private promptMove(): void {
    this.promptForSelected(
      "file.move",
      (entry) => entry.path,
      (entry, value) =>
        this.withConflict((policy) =>
          this.service.move(this.pane.hostId, entry.path, value, policy),
        ),
    );
  }

  private cancelLatestTransfer(): void {
    const active = this.service.queue
      .list()
      .findLast((job) => job.status === "queued" || job.status === "running");
    if (active) this.service.queue.cancel(active.id);
    else {
      this.footer.content = this.i18n.t("file.noTransfer");
      this.footer.fg = theme.warning;
      this.requestRender();
    }
  }

  private previousPage(): void {
    if (this.page <= 1) return;
    this.page -= 1;
    void this.refresh();
  }

  private nextPage(): void {
    if (this.page >= this.totalPages) return;
    this.page += 1;
    void this.refresh();
  }

  private openContextMenu(): void {
    const selected = this.selected();
    if (!selected) return;
    const actions = [
      {
        label: selected.isDirectory ? "Open folder" : "Open preview",
        run: () => void this.openSelected(),
      },
      { label: "Rename…", run: () => this.promptRename() },
      { label: "Copy…", run: () => this.promptCopy() },
      { label: "Move…", run: () => this.promptMove() },
      ...(selected.isDirectory ? [] : [{ label: "Download…", run: () => this.promptDownload() }]),
      { label: "Delete…", run: () => this.confirmDelete() },
    ];
    this.closePrompt();
    const modal = new BoxRenderable(this.ctx, {
      id: `${this.id}-context`,
      position: "absolute",
      left: "18%",
      top: "22%",
      width: "64%",
      height: Math.min(16, actions.length * 2 + 2),
      zIndex: 120,
      border: true,
      borderStyle: "double",
      borderColor: theme.accent,
      title: ` ${selected.name} `,
      backgroundColor: theme.surfaceRaised,
    });
    const list = new FileActionSelectRenderable(
      this.ctx,
      {
        id: `${this.id}-context-list`,
        width: "100%",
        height: "100%",
        options: actions.map((action) => ({ name: action.label, description: "" })),
        showDescription: false,
        selectedBackgroundColor: theme.selection,
        selectedTextColor: theme.foreground,
        backgroundColor: theme.surfaceRaised,
      },
      () => this.closePrompt(),
    );
    let executed = false;
    const runSelected = () => {
      if (executed) return;
      const action = actions[list.getSelectedIndex()];
      if (!action) return;
      executed = true;
      this.closePrompt();
      action.run();
    };
    list.on(SelectRenderableEvents.ITEM_SELECTED, runSelected);
    this.modalMouseDispose = attachMouseSelect(list, {
      onClick: (index) => {
        list.setSelectedIndex(index);
        runSelected();
      },
    });
    modal.add(list);
    this.add(modal);
    this.modal = modal;
    list.focus();
    this.requestRender();
  }

  private promptForSelected(
    title: "file.rename" | "file.copy" | "file.move",
    initial: (entry: RemoteFileEntry) => string,
    operation: (entry: RemoteFileEntry, value: string) => Promise<void>,
  ): void {
    const selected = this.selected();
    if (!selected) return;
    this.showPrompt(title, initial(selected), async (value) => {
      await this.runOperation(() => operation(selected, value));
    });
  }

  private confirmDelete(): void {
    const selected = this.selected();
    if (!selected) return;
    this.showPrompt("file.deleteConfirm", "", async (value) => {
      if (value !== "DELETE") return;
      await this.runOperation(() => this.service.delete(this.pane.hostId, selected.path));
    });
  }

  private promptDownload(): void {
    const selected = this.selected();
    if (!selected || selected.isDirectory) return;
    this.showPrompt("file.download", localJoin(process.cwd(), selected.name), async (value) => {
      await this.runTransferWithConflict((policy) =>
        this.service.download(this.pane.hostId, selected.path, value, policy),
      );
    });
  }

  private async withConflict(
    operation: (policy: ConflictPolicy) => Promise<FileOperationResult>,
  ): Promise<void> {
    try {
      await operation("error");
    } catch (error) {
      if (!(error instanceof TermLoomError) || error.code !== "TRANSFER_CONFLICT") throw error;
      this.showPrompt("file.conflict", "rename", async (value) => {
        const policy = parseConflictPolicy(value);
        await this.runOperation(() => operation(policy));
      });
    }
  }

  private async runTransferWithConflict(
    start: (policy: ConflictPolicy) => TransferHandle,
  ): Promise<void> {
    try {
      await start("error").completion;
      await this.refresh();
    } catch (error) {
      if (!(error instanceof TermLoomError) || error.code !== "TRANSFER_CONFLICT") {
        this.showError(error);
        return;
      }
      this.showPrompt("file.conflict", "rename", async (value) => {
        const policy = parseConflictPolicy(value);
        await start(policy).completion;
        await this.refresh();
      });
    }
  }

  private async runOperation(operation: () => Promise<unknown>): Promise<void> {
    try {
      await operation();
      await this.refresh();
    } catch (error) {
      this.showError(error);
    }
  }

  private showPrompt(
    titleKey: Parameters<I18n["t"]>[0],
    initial: string,
    submit: PromptSubmit,
  ): void {
    this.closePrompt();
    const modal = new BoxRenderable(this.ctx, {
      id: `${this.id}-modal`,
      position: "absolute",
      left: "10%",
      top: "35%",
      width: "80%",
      height: 5,
      zIndex: 100,
      border: true,
      borderStyle: "double",
      borderColor: theme.accent,
      title: this.i18n.t(titleKey),
      padding: 1,
      backgroundColor: theme.surfaceRaised,
    });
    const input = new FilePromptInputRenderable(
      this.ctx,
      {
        id: `${this.id}-modal-input`,
        width: "100%",
        value: initial,
        placeholder: this.i18n.t(titleKey),
        backgroundColor: theme.surface,
        focusedBackgroundColor: theme.selection,
        textColor: theme.foreground,
        cursorColor: theme.accent,
      },
      () => this.closePrompt(),
    );
    input.on(InputRenderableEvents.ENTER, (value: string) => {
      this.closePrompt();
      void Promise.resolve(submit(value.trim())).catch((error) => this.showError(error));
    });
    modal.add(input);
    this.add(modal);
    this.modal = modal;
    this.modalInput = input;
    input.focus();
    this.requestRender();
  }

  private closePrompt(): void {
    if (!this.modal) return;
    this.remove(this.modal);
    this.modal.destroyRecursively();
    this.modal = undefined;
    this.modalInput = undefined;
    this.modalMouseDispose?.();
    this.modalMouseDispose = undefined;
    if (!this.isDestroyed) super.focus();
    this.requestRender();
  }

  private showError(error: unknown): void {
    this.footer.content = this.i18n.t("file.error", { message: errorMessage(error) });
    this.footer.fg = theme.error;
    this.requestRender();
  }
}

class FilePathInputRenderable extends InputRenderable {
  public constructor(
    ctx: RenderContext,
    options: ConstructorParameters<typeof InputRenderable>[1],
    private readonly cancel: () => void,
  ) {
    super(ctx, options);
  }

  public override handleKeyPress(key: KeyEvent): boolean {
    if (key.eventType !== "release" && key.name === "escape") {
      this.cancel();
      return true;
    }
    return super.handleKeyPress(key);
  }
}

class FilePromptInputRenderable extends InputRenderable {
  public constructor(
    ctx: RenderContext,
    options: ConstructorParameters<typeof InputRenderable>[1],
    private readonly cancel: () => void,
  ) {
    super(ctx, options);
  }

  public override handleKeyPress(key: KeyEvent): boolean {
    if (key.eventType !== "release" && key.name === "escape") {
      this.cancel();
      return true;
    }
    return super.handleKeyPress(key);
  }
}

class FileActionSelectRenderable extends SelectRenderable {
  public constructor(
    ctx: RenderContext,
    options: ConstructorParameters<typeof SelectRenderable>[1],
    private readonly cancel: () => void,
  ) {
    super(ctx, options);
  }

  public override handleKeyPress(key: KeyEvent): boolean {
    if (key.eventType !== "release" && key.name === "escape") {
      this.cancel();
      return true;
    }
    return super.handleKeyPress(key);
  }
}

function parseConflictPolicy(value: string): ConflictPolicy {
  if (value === "overwrite" || value === "skip" || value === "rename") return value;
  throw new TermLoomError({
    code: "TRANSFER_CONFLICT",
    message: `Invalid conflict policy: ${value}`,
  });
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KiB`;
  if (bytes < 1_073_741_824) return `${(bytes / 1_048_576).toFixed(1)} MiB`;
  return `${(bytes / 1_073_741_824).toFixed(1)} GiB`;
}
