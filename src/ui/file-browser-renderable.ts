import {
  basename as localBasename,
  dirname as localDirname,
  join as localJoin,
  resolve as localResolve,
} from "node:path";
import { posix } from "node:path";
import {
  BoxRenderable,
  type CliRenderer,
  InputRenderable,
  InputRenderableEvents,
  type KeyEvent,
  MouseButton,
  type RenderContext,
  TextAttributes,
  TextRenderable,
} from "@opentui/core";
import { TermLoomError, errorMessage } from "../core/errors.js";
import type {
  ConflictPolicy,
  FileEntry,
  FileOperationResult,
  FileProvider,
} from "../files/file-provider.js";
import type { I18n } from "../i18n/i18n.js";
import type { TransferHandle } from "../sftp/transfer-queue.js";
import type { PaneState } from "../workspace/schema.js";
import type { ContextMenuAction, ContextMenuRequest } from "./dismissible-overlay-controller.js";
import { FileListRenderable, formatBytes } from "./file-list-renderable.js";
import { RichDocumentRenderable, type RichDocumentServices } from "./rich-document-renderable.js";
import { theme } from "./theme.js";

type FilesPaneState = Extract<PaneState, { kind: "files" }>;
type PreviewPaneState = Extract<PaneState, { kind: "preview" }>;
type PromptSubmit = (value: string) => Promise<void> | void;

export interface FileBrowserCommand {
  id: string;
  title: string;
  shortcut?: string;
  run: () => void;
}

export interface FileBrowserOptions {
  id: string;
  pane: FilesPaneState;
  provider: FileProvider;
  i18n: I18n;
  preview?: RichDocumentServices;
  onPaneUpdate?: (pane: FilesPaneState) => void;
  onOpenPreview?: (pane: FilesPaneState, entry: FileEntry) => void;
  onContextMenu?: (request: ContextMenuRequest, restoreFocus: () => void) => void;
}

export class FileBrowserRenderable extends BoxRenderable {
  private readonly renderer: CliRenderer;
  private pane: FilesPaneState;
  private readonly provider: FileProvider;
  private readonly i18n: I18n;
  private readonly previewServices: RichDocumentServices | undefined;
  private readonly onPaneUpdate: ((pane: FilesPaneState) => void) | undefined;
  private readonly onOpenPreview: ((pane: FilesPaneState, entry: FileEntry) => void) | undefined;
  private readonly onContextMenu:
    | ((request: ContextMenuRequest, restoreFocus: () => void) => void)
    | undefined;
  private readonly endpointLabel: string;
  private readonly header: TextRenderable;
  private readonly pathInput: InputRenderable;
  private readonly pageIndicator: TextRenderable;
  private readonly contentRow: BoxRenderable;
  private readonly parentColumn: BoxRenderable;
  private readonly currentColumn: BoxRenderable;
  private readonly previewColumn: BoxRenderable;
  private readonly parentList: FileListRenderable;
  private readonly currentList: FileListRenderable;
  private readonly previewHost: BoxRenderable;
  private readonly status: TextRenderable;
  private page = 1;
  private pageSize = 250;
  private totalPages = 1;
  private query = "";
  private modal: BoxRenderable | undefined;
  private modalInput: InputRenderable | undefined;
  private refreshRequested = 0;
  private refreshCompleted = 0;
  private refreshPromise: Promise<void> | undefined;
  private previewGeneration = 0;
  private previewTimer: ReturnType<typeof setTimeout> | undefined;
  private previewContent: BoxRenderable | TextRenderable | RichDocumentRenderable | undefined;
  private narrowPreview = false;
  private layoutMode: "three" | "two" | "single" = "three";
  private disposed = false;
  private readonly unsubscribeTransfer: () => void;

  public constructor(renderer: CliRenderer, options: FileBrowserOptions) {
    super(renderer, {
      id: options.id,
      width: "100%",
      height: "100%",
      flexDirection: "column",
      focusable: true,
      backgroundColor: theme.background,
      overflow: "hidden",
      onMouseDown: (event) => {
        if (event.button !== MouseButton.RIGHT) return;
        this.openContextMenu({ x: event.x, y: event.y }, undefined);
        consumeMouse(event);
      },
    });
    this.renderer = renderer;
    this.pane = options.pane;
    this.provider = options.provider;
    this.i18n = options.i18n;
    this.previewServices = options.preview;
    this.onPaneUpdate = options.onPaneUpdate;
    this.onOpenPreview = options.onOpenPreview;
    this.onContextMenu = options.onContextMenu;
    this.endpointLabel =
      options.pane.target.kind === "local" ? "Local" : options.pane.target.hostId;

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
      content: ` ${this.endpointLabel} `,
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
        placeholder: this.provider.kind === "local" ? "Local path" : "Remote path",
        backgroundColor: theme.surface,
        focusedBackgroundColor: theme.selection,
        textColor: theme.foreground,
        cursorColor: theme.accent,
      },
      () => this.currentList.focus(),
    );
    this.pathInput.on(InputRenderableEvents.ENTER, (value: string) => {
      void this.navigate(value.trim() || (this.provider.kind === "local" ? this.pane.path : "."));
      this.currentList.focus();
    });
    pathRow.add(this.pathInput);
    pathRow.add(this.iconButton(renderer, "page-previous", " ‹ ", () => this.previousPage()));
    this.pageIndicator = new TextRenderable(renderer, {
      id: `${options.id}-page-indicator`,
      content: " 1/1 ",
      fg: theme.muted,
      bg: theme.surfaceRaised,
    });
    pathRow.add(this.pageIndicator);
    pathRow.add(this.iconButton(renderer, "page-next", " › ", () => this.nextPage()));
    this.add(pathRow);

    this.contentRow = new BoxRenderable(renderer, {
      id: `${options.id}-columns`,
      width: "100%",
      flexGrow: 1,
      minHeight: 1,
      flexDirection: "row",
      backgroundColor: theme.background,
      overflow: "hidden",
    });
    this.parentColumn = this.column(renderer, "parent", "Parent");
    this.currentColumn = this.column(renderer, "current", "Name");
    this.previewColumn = this.column(renderer, "preview", "Preview");
    this.parentList = new FileListRenderable(renderer, {
      id: `${options.id}-parent-list`,
      onActivate: (entry) => {
        if (entry.isDirectory) void this.navigate(entry.path);
      },
      onContextMenu: (event, entry) => this.openContextMenu(event, entry),
    });
    this.currentList = new FileListRenderable(renderer, {
      id: `${options.id}-current-list`,
      emptyLabel: this.i18n.t("file.empty"),
      onSelection: (entry) => this.selectEntry(entry),
      onActivate: (entry) => void this.activateEntry(entry),
      onContextMenu: (event, entry) => this.openContextMenu(event, entry),
    });
    this.previewHost = new BoxRenderable(renderer, {
      id: `${options.id}-preview-host`,
      width: "100%",
      height: "100%",
      flexDirection: "column",
      backgroundColor: theme.background,
      overflow: "hidden",
    });
    this.parentColumn.add(this.parentList);
    this.currentColumn.add(this.currentList);
    this.previewColumn.add(this.previewHost);
    this.contentRow.add(this.parentColumn);
    this.contentRow.add(this.divider(renderer, "parent-divider"));
    this.contentRow.add(this.currentColumn);
    this.contentRow.add(this.divider(renderer, "preview-divider"));
    this.contentRow.add(this.previewColumn);
    this.add(this.contentRow);

    this.status = new TextRenderable(renderer, {
      id: `${options.id}-status`,
      height: 1,
      width: "100%",
      content: this.pane.path,
      fg: theme.muted,
      bg: theme.surfaceRaised,
      attributes: TextAttributes.DIM,
    });
    this.add(this.status);

    this.unsubscribeTransfer =
      this.provider.queue?.onChange((job) => {
        const total = job.progress.totalBytes ?? 0;
        this.status.content = `${job.status} · ${formatBytes(job.progress.bytes)} / ${formatBytes(total)}`;
        this.status.fg = job.status === "failed" ? theme.error : theme.warning;
        this.requestRender();
      }) ?? (() => undefined);
    void this.refresh();
  }

  public contextCommands(): FileBrowserCommand[] {
    const selected = this.currentList.selected;
    const actions = [
      ...this.contextActions(undefined),
      ...(selected ? this.contextActions(selected) : []),
    ];
    return actions.map((action) => ({
      id: `file-${action.id}`,
      title: action.label,
      shortcut: action.shortcut,
      run: action.run,
    }));
  }

  public refreshAppearance(): void {
    this.backgroundColor = theme.background;
    this.header.fg = theme.accent;
    this.pathInput.backgroundColor = theme.surface;
    this.pathInput.focusedBackgroundColor = theme.selection;
    this.pathInput.textColor = theme.foreground;
    this.pathInput.cursorColor = theme.accent;
    this.contentRow.backgroundColor = theme.background;
    this.parentColumn.backgroundColor = theme.background;
    this.currentColumn.backgroundColor = theme.background;
    this.previewColumn.backgroundColor = theme.background;
    this.previewHost.backgroundColor = theme.background;
    this.parentList.refreshAppearance();
    this.currentList.refreshAppearance();
    this.status.bg = theme.surfaceRaised;
    this.status.fg = theme.muted;
    this.requestRender();
  }

  public override handleKeyPress(key: KeyEvent): boolean {
    if (this.modalInput) {
      if (key.eventType !== "release" && key.name === "escape") {
        this.closePrompt();
        return true;
      }
      return false;
    }
    if (key.ctrl || key.meta || key.super || key.eventType === "release") return false;
    if (this.layoutMode === "single" && this.narrowPreview) {
      if (key.name === "escape" || key.name === "backspace") {
        this.narrowPreview = false;
        this.applyResponsiveLayout(this.width);
        this.currentList.focus();
        return true;
      }
      return false;
    }
    if (key.name === "up" || key.name === "k") {
      this.currentList.move(-1);
      return true;
    }
    if (key.name === "down" || key.name === "j") {
      this.currentList.move(1);
      return true;
    }
    if (key.name === "return") {
      this.currentList.activate();
      return true;
    }
    if (key.name === "escape" || key.name === "backspace") {
      void this.navigate(this.parentPath(this.pane.path));
      return true;
    }
    if (key.name === "r" && key.shift) {
      this.promptRename();
      return true;
    }
    if (key.name === "r") {
      void this.refresh();
      return true;
    }
    if (key.name === "n" && key.shift) {
      this.promptNewFolder();
      return true;
    }
    if (key.name === "n") {
      this.promptNewFile();
      return true;
    }
    if (key.name === "/") {
      this.promptSearch();
      return true;
    }
    if (key.name === "c") {
      this.promptCopy();
      return true;
    }
    if (key.name === "m") {
      this.promptMove();
      return true;
    }
    if (key.name === "u" && this.provider.upload) {
      this.promptUpload();
      return true;
    }
    if (key.name === "d" && key.shift && this.provider.download) {
      this.promptDownload();
      return true;
    }
    if (key.name === "x") {
      this.cancelLatestTransfer();
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

  protected override onResize(width: number, height: number): void {
    super.onResize(width, height);
    this.applyResponsiveLayout(width);
  }

  protected override destroySelf(): void {
    this.disposed = true;
    this.refreshCompleted = this.refreshRequested;
    this.previewGeneration += 1;
    if (this.previewTimer) clearTimeout(this.previewTimer);
    this.unsubscribeTransfer();
    this.closePrompt();
    this.destroyPreview();
    super.destroySelf();
  }

  private async refreshOnce(): Promise<void> {
    const generation = this.refreshRequested;
    this.header.content = ` ${this.endpointLabel} · ${this.i18n.t("file.loading")} `;
    this.requestRender();
    try {
      const parent = this.parentPath(this.pane.path);
      const [currentResult, parentResult] = await Promise.all([
        this.provider.list(this.pane.path, {
          page: this.page,
          pageSize: this.pageSize,
          query: this.query,
        }),
        parent === this.pane.path
          ? Promise.resolve(undefined)
          : this.provider.list(parent, { page: 1, pageSize: 250 }),
      ]);
      if (this.disposed || generation < this.refreshRequested) return;
      this.page = currentResult.page;
      this.pageSize = currentResult.pageSize;
      this.totalPages = currentResult.totalPages;
      this.parentList.setEntries(parentResult?.entries ?? [], this.pane.path);
      this.currentList.setEntries(currentResult.entries, this.pane.selectedPath);
      this.header.content = ` ${this.endpointLabel} `;
      this.pathInput.value = this.pane.path;
      this.pageIndicator.content = ` ${this.page}/${this.totalPages} `;
      this.updateStatus(this.currentList.selected);
    } catch (error) {
      if (!this.disposed) this.showError(error);
    } finally {
      this.refreshCompleted = Math.max(this.refreshCompleted, generation);
      this.refreshPromise = undefined;
      if (!this.disposed) this.requestRender();
    }
  }

  private selectEntry(entry: FileEntry | undefined): void {
    if (!entry) {
      this.updateStatus(undefined);
      return;
    }
    this.pane = {
      ...this.pane,
      selectedPath: entry.path,
      previewPath: entry.path,
    };
    this.onPaneUpdate?.(this.pane);
    this.updateStatus(entry);
    this.schedulePreview(entry);
  }

  private async activateEntry(entry: FileEntry): Promise<void> {
    if (entry.isDirectory) {
      await this.navigate(entry.path);
      return;
    }
    if (this.layoutMode === "single") {
      this.narrowPreview = true;
      this.applyResponsiveLayout(this.width);
      this.schedulePreview(entry, 0);
      return;
    }
    this.schedulePreview(entry, 0);
  }

  private async navigate(path: string): Promise<void> {
    const normalized = this.normalizePath(path);
    if (normalized === this.pane.path && !this.query) return;
    this.page = 1;
    this.query = "";
    this.narrowPreview = false;
    this.pane = {
      ...this.pane,
      path: normalized,
      selectedPath: undefined,
      previewPath: undefined,
      title: `${this.endpointLabel}:${normalized}`,
    };
    this.onPaneUpdate?.(this.pane);
    await this.refresh();
  }

  private schedulePreview(entry: FileEntry, delay = 150): void {
    const generation = ++this.previewGeneration;
    if (this.previewTimer) clearTimeout(this.previewTimer);
    this.previewTimer = setTimeout(() => {
      this.previewTimer = undefined;
      void this.renderPreview(entry, generation);
    }, delay);
  }

  private async renderPreview(entry: FileEntry, generation: number): Promise<void> {
    this.destroyPreview();
    if (entry.isDirectory) {
      const loading = this.previewText(`${entry.name}\n\nLoading folder…`, theme.muted);
      this.setPreviewContent(loading);
      try {
        const page = await this.provider.list(entry.path, { page: 1, pageSize: 40 });
        if (generation !== this.previewGeneration || this.disposed) return;
        const summary = [
          entry.name,
          "",
          `${page.total} item${page.total === 1 ? "" : "s"}`,
          "",
          ...page.entries
            .slice(0, 30)
            .map((child) => `${child.isDirectory ? "d" : "·"}  ${child.name}`),
          ...(page.total > 30 ? [`… ${page.total - 30} more`] : []),
        ].join("\n");
        this.setPreviewContent(this.previewText(summary, theme.foreground));
      } catch (error) {
        if (generation === this.previewGeneration && !this.disposed) {
          this.setPreviewContent(this.previewText(errorMessage(error), theme.error));
        }
      }
      return;
    }
    if (!this.previewServices) {
      this.setPreviewContent(
        this.previewText(
          `${entry.name}\n\n${entry.mimeType ?? "Unknown type"}\n${formatBytes(entry.size)}`,
          theme.foreground,
        ),
      );
      return;
    }
    const previewPane: PreviewPaneState = {
      id: `${this.pane.id}-embedded-preview`,
      kind: "preview",
      title: entry.name,
      target: this.pane.target,
      path: entry.path,
      scrollOffset: this.pane.previewScrollOffset ?? 0,
    };
    const preview = new RichDocumentRenderable(this.renderer, {
      id: `${this.id}-rich-preview-${generation}`,
      pane: previewPane,
      i18n: this.i18n,
      onPaneUpdate: (updated) => {
        if (generation !== this.previewGeneration) return;
        this.pane = { ...this.pane, previewScrollOffset: updated.scrollOffset };
        this.onPaneUpdate?.(this.pane);
      },
      ...this.previewServices,
    });
    if (generation !== this.previewGeneration || this.disposed) {
      preview.destroyRecursively();
      return;
    }
    this.setPreviewContent(preview);
  }

  private openContextMenu(event: { x: number; y: number }, entry: FileEntry | undefined): void {
    const actions = this.contextActions(entry);
    if (!this.onContextMenu || actions.length === 0) return;
    this.onContextMenu(
      { x: event.x, y: event.y, title: entry?.name ?? this.pane.path, actions },
      () => this.currentList.focus(),
    );
  }

  private contextActions(entry: FileEntry | undefined): ContextMenuAction[] {
    if (!entry) {
      return [
        { id: "refresh", label: "Refresh", shortcut: "R", run: () => void this.refresh() },
        { id: "search", label: "Search…", shortcut: "/", run: () => this.promptSearch() },
        { id: "new-file", label: "New File…", shortcut: "N", run: () => this.promptNewFile() },
        {
          id: "new-folder",
          label: "New Folder…",
          shortcut: "Shift+N",
          run: () => this.promptNewFolder(),
        },
        ...(this.provider.upload
          ? [{ id: "upload", label: "Upload…", shortcut: "U", run: () => this.promptUpload() }]
          : []),
      ];
    }
    return [
      {
        id: "open",
        label: entry.isDirectory ? "Open Folder" : "Open Preview",
        shortcut: "Enter",
        run: () => void this.activateEntry(entry),
      },
      ...(!entry.isDirectory
        ? [
            {
              id: "open-split",
              label: "Open in Split",
              run: () => this.onOpenPreview?.(this.pane, entry),
            },
          ]
        : []),
      { id: "rename", label: "Rename…", shortcut: "Shift+R", run: () => this.promptRename() },
      { id: "copy", label: "Copy…", shortcut: "C", run: () => this.promptCopy() },
      { id: "move", label: "Move…", shortcut: "M", run: () => this.promptMove() },
      ...(!entry.isDirectory && this.provider.download
        ? [
            {
              id: "download",
              label: "Download…",
              shortcut: "Shift+D",
              run: () => this.promptDownload(),
            },
          ]
        : []),
    ];
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
      await this.runOperation(() => this.provider.createFile(this.joinPath(this.pane.path, value)));
    });
  }

  private promptNewFolder(): void {
    this.showPrompt("file.newDirectory", "", async (value) => {
      await this.runOperation(() =>
        this.provider.createDirectory(this.joinPath(this.pane.path, value)),
      );
    });
  }

  private promptUpload(): void {
    const upload = this.provider.upload?.bind(this.provider);
    if (!upload) return;
    this.showPrompt("file.upload", "", async (value) => {
      const destination = this.joinPath(this.pane.path, localBasename(value));
      await this.runTransferWithConflict((policy) => upload(value, destination, policy));
    });
  }

  private promptRename(): void {
    this.promptForSelected(
      "file.rename",
      (entry) => entry.path,
      (entry, value) =>
        this.withConflict((policy) => this.provider.rename(entry.path, value, policy)),
    );
  }

  private promptCopy(): void {
    this.promptForSelected(
      "file.copy",
      (entry) => `${entry.path}.copy`,
      (entry, value) =>
        this.withConflict((policy) => this.provider.copy(entry.path, value, policy)),
    );
  }

  private promptMove(): void {
    this.promptForSelected(
      "file.move",
      (entry) => entry.path,
      (entry, value) =>
        this.withConflict((policy) => this.provider.move(entry.path, value, policy)),
    );
  }

  private promptDownload(): void {
    const selected = this.currentList.selected;
    const download = this.provider.download?.bind(this.provider);
    if (!selected || selected.isDirectory || !download) return;
    this.showPrompt("file.download", localJoin(process.cwd(), selected.name), async (value) => {
      await this.runTransferWithConflict((policy) => download(selected.path, value, policy));
    });
  }

  private promptForSelected(
    title: "file.rename" | "file.copy" | "file.move",
    initial: (entry: FileEntry) => string,
    operation: (entry: FileEntry, value: string) => Promise<void>,
  ): void {
    const selected = this.currentList.selected;
    if (!selected) return;
    this.showPrompt(title, initial(selected), async (value) => {
      await this.runOperation(() => operation(selected, value));
    });
  }

  private cancelLatestTransfer(): void {
    const queue = this.provider.queue;
    const active = queue
      ?.list()
      .findLast((job) => job.status === "queued" || job.status === "running");
    if (active && queue) queue.cancel(active.id);
    else {
      this.status.content = this.i18n.t("file.noTransfer");
      this.status.fg = theme.warning;
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
    const modal = this.modal;
    if (!modal) return;
    this.modal = undefined;
    this.modalInput = undefined;
    if (modal.parent === this) this.remove(modal);
    modal.destroyRecursively();
    if (!this.isDestroyed) this.currentList.focus();
    this.requestRender();
  }

  private applyResponsiveLayout(width: number): void {
    const mode = width >= 84 ? "three" : width >= 48 ? "two" : "single";
    this.layoutMode = mode;
    const parentDivider = this.contentRow.findDescendantById(`${this.id}-parent-divider`);
    const previewDivider = this.contentRow.findDescendantById(`${this.id}-preview-divider`);
    if (mode === "three") {
      this.parentColumn.visible = true;
      this.currentColumn.visible = true;
      this.previewColumn.visible = true;
      this.parentColumn.width = "23%";
      this.currentColumn.width = "43%";
      this.previewColumn.flexGrow = 1;
      if (parentDivider) parentDivider.visible = true;
      if (previewDivider) previewDivider.visible = true;
    } else if (mode === "two") {
      this.parentColumn.visible = false;
      this.currentColumn.visible = true;
      this.previewColumn.visible = true;
      this.currentColumn.width = "52%";
      this.previewColumn.flexGrow = 1;
      if (parentDivider) parentDivider.visible = false;
      if (previewDivider) previewDivider.visible = true;
    } else {
      this.parentColumn.visible = false;
      this.currentColumn.visible = !this.narrowPreview;
      this.previewColumn.visible = this.narrowPreview;
      this.currentColumn.width = "100%";
      this.previewColumn.width = "100%";
      if (parentDivider) parentDivider.visible = false;
      if (previewDivider) previewDivider.visible = false;
    }
    this.requestRender();
  }

  private updateStatus(entry: FileEntry | undefined): void {
    if (!entry) {
      this.status.content = ` ${this.pane.path}`;
      this.status.fg = theme.muted;
      return;
    }
    const mode = entry.mode === undefined ? "" : ` · ${modeString(entry.mode, entry.isDirectory)}`;
    const modified = entry.modifiedAt ? ` · ${entry.modifiedAt.toLocaleString()}` : "";
    const size = entry.isDirectory ? "folder" : formatBytes(entry.size);
    this.status.content = ` ${entry.path} · ${size}${modified}${mode}`;
    this.status.fg = theme.muted;
    this.requestRender();
  }

  private column(renderer: CliRenderer, name: string, title: string): BoxRenderable {
    const column = new BoxRenderable(renderer, {
      id: `${this.id}-${name}-column`,
      height: "100%",
      flexDirection: "column",
      backgroundColor: theme.background,
      overflow: "hidden",
    });
    column.add(
      new TextRenderable(renderer, {
        id: `${this.id}-${name}-title`,
        height: 1,
        width: "100%",
        content: ` ${title}`,
        fg: theme.muted,
        bg: theme.surface,
        attributes: TextAttributes.BOLD,
      }),
    );
    return column;
  }

  private divider(renderer: CliRenderer, name: string): TextRenderable {
    return new TextRenderable(renderer, {
      id: `${this.id}-${name}`,
      width: 1,
      height: "100%",
      content: "│",
      fg: theme.border,
      bg: theme.background,
    });
  }

  private iconButton(
    renderer: CliRenderer,
    name: string,
    label: string,
    run: () => void,
  ): TextRenderable {
    return new TextRenderable(renderer, {
      id: `${this.id}-${name}`,
      content: label,
      fg: theme.accent,
      bg: theme.surfaceRaised,
      onMouseOver: () => renderer.setMousePointer("pointer"),
      onMouseOut: () => renderer.setMousePointer("default"),
      onMouseDown: (event) => {
        if (event.button !== MouseButton.LEFT) return;
        run();
        consumeMouse(event);
      },
    });
  }

  private previewText(content: string, color: string): TextRenderable {
    return new TextRenderable(this.ctx, {
      id: `${this.id}-preview-text-${crypto.randomUUID()}`,
      width: "100%",
      height: "100%",
      content,
      fg: color,
      selectable: true,
    });
  }

  private setPreviewContent(
    content: BoxRenderable | TextRenderable | RichDocumentRenderable,
  ): void {
    this.destroyPreview();
    this.previewContent = content;
    this.previewHost.add(content);
    this.requestRender();
  }

  private destroyPreview(): void {
    const preview = this.previewContent;
    if (!preview) return;
    this.previewContent = undefined;
    if (preview.parent === this.previewHost) this.previewHost.remove(preview);
    preview.destroyRecursively();
  }

  private joinPath(base: string, name: string): string {
    return this.provider.kind === "local" ? localJoin(base, name) : posix.join(base, name);
  }

  private parentPath(path: string): string {
    return this.provider.kind === "local" ? localDirname(path) : posix.dirname(path);
  }

  private normalizePath(path: string): string {
    return this.provider.kind === "local" ? localResolve(path) : posix.normalize(path);
  }

  private showError(error: unknown): void {
    this.status.content = this.i18n.t("file.error", { message: errorMessage(error) });
    this.status.fg = theme.error;
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

function parseConflictPolicy(value: string): ConflictPolicy {
  if (value === "overwrite" || value === "skip" || value === "rename") return value;
  throw new TermLoomError({
    code: "TRANSFER_CONFLICT",
    message: `Invalid conflict policy: ${value}`,
  });
}

function modeString(mode: number, directory: boolean): string {
  const bits = [0o400, 0o200, 0o100, 0o040, 0o020, 0o010, 0o004, 0o002, 0o001];
  const symbols = ["r", "w", "x", "r", "w", "x", "r", "w", "x"];
  return `${directory ? "d" : "-"}${bits
    .map((bit, index) => ((mode & bit) !== 0 ? symbols[index] : "-"))
    .join("")}`;
}

function consumeMouse(event: { preventDefault(): void; stopPropagation(): void }): void {
  event.preventDefault();
  event.stopPropagation();
}
