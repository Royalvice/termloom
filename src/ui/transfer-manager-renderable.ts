import {
  BoxRenderable,
  type KeyEvent,
  MouseButton,
  type RenderContext,
  SelectRenderable,
  SelectRenderableEvents,
  TextAttributes,
  TextRenderable,
} from "@opentui/core";
import type { I18n } from "../i18n/i18n.js";
import type { DownloadJob, TransferQueue } from "../sftp/transfer-queue.js";
import { attachMouseSelect } from "./mouse-select-adapter.js";
import { theme } from "./theme.js";

export interface TransferManagerOptions {
  id: string;
  queue: TransferQueue;
  i18n: I18n;
  onClose(): void;
}

export class TransferManagerRenderable extends BoxRenderable {
  private readonly queue: TransferQueue;
  private readonly i18n: I18n;
  private readonly onCloseValue: () => void;
  private readonly list: SelectRenderable;
  private readonly detail: TextRenderable;
  private jobs: readonly DownloadJob[] = [];
  private readonly unsubscribe: () => void;
  private readonly disposeMouse: () => void;

  public constructor(ctx: RenderContext, options: TransferManagerOptions) {
    super(ctx, {
      id: options.id,
      position: "absolute",
      left: "8%",
      top: "10%",
      width: "84%",
      height: "80%",
      zIndex: 500,
      flexDirection: "column",
      border: true,
      borderStyle: "double",
      borderColor: theme.accentSecondary,
      title: options.i18n.t("transfer.title"),
      titleColor: theme.accentSecondary,
      padding: 1,
      focusable: true,
      backgroundColor: theme.surfaceRaised,
      overflow: "hidden",
    });
    this.queue = options.queue;
    this.i18n = options.i18n;
    this.onCloseValue = options.onClose;
    this.add(
      new TextRenderable(ctx, {
        id: `${options.id}-header`,
        width: "100%",
        height: 2,
        content: options.i18n.t("transfer.shortcuts"),
        fg: theme.foreground,
        attributes: TextAttributes.BOLD,
      }),
    );
    this.list = new SelectRenderable(ctx, {
      id: `${options.id}-list`,
      width: "100%",
      flexGrow: 1,
      options: [],
      showDescription: true,
      showScrollIndicator: true,
      wrapSelection: true,
      backgroundColor: theme.surfaceRaised,
      textColor: theme.foreground,
      selectedBackgroundColor: theme.selection,
      selectedTextColor: theme.foreground,
      descriptionColor: theme.muted,
      selectedDescriptionColor: theme.foreground,
    });
    this.detail = new TextRenderable(ctx, {
      id: `${options.id}-detail`,
      width: "100%",
      height: 3,
      content: "",
      fg: theme.muted,
    });
    this.list.on(SelectRenderableEvents.SELECTION_CHANGED, () => this.updateDetail());
    this.disposeMouse = attachMouseSelect(this.list, {
      onClick: () => this.updateDetail(),
    });
    this.add(this.list);
    this.add(this.detail);
    const actions = new BoxRenderable(ctx, {
      id: `${options.id}-actions`,
      width: "100%",
      height: 1,
      flexDirection: "row",
      justifyContent: "flex-end",
    });
    actions.add(
      this.button(ctx, "cancel", " Cancel Transfer ", () => this.cancelSelected(), theme.warning),
    );
    actions.add(this.button(ctx, "close", " × Close ", this.onCloseValue, theme.error));
    this.add(actions);
    this.unsubscribe = this.queue.onChange(() => this.refresh());
    this.refresh();
  }

  public override handleKeyPress(key: KeyEvent): boolean {
    if (key.eventType === "release") return false;
    if (key.name === "escape" || (key.name === "q" && !key.ctrl && !key.meta)) {
      this.onCloseValue();
      return true;
    }
    if (key.name === "up" || key.name === "k") {
      this.list.moveUp();
      this.updateDetail();
      return true;
    }
    if (key.name === "down" || key.name === "j") {
      this.list.moveDown();
      this.updateDetail();
      return true;
    }
    if (key.name === "x") {
      this.cancelSelected();
      return true;
    }
    return false;
  }

  public inspectJobs(): readonly DownloadJob[] {
    return this.jobs.map((job) => structuredClone(job));
  }

  protected override destroySelf(): void {
    this.disposeMouse();
    this.unsubscribe();
    super.destroySelf();
  }

  private refresh(): void {
    const selectedId = this.jobs[this.list.getSelectedIndex()]?.id;
    this.jobs = [...this.queue.list()].sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt),
    );
    this.list.options = this.jobs.length
      ? this.jobs.map((job) => ({
          name: `${statusMarker(job.status)} ${job.sourceKind} ${shortPath(job.remotePath)}`,
          description: `${job.status} · ${formatProgress(job)} · → ${shortPath(job.resolvedDestination)}`,
          value: job.id,
        }))
      : [{ name: this.i18n.t("file.noTransfer"), description: "", value: undefined }];
    const selectedIndex = selectedId
      ? this.jobs.findIndex((candidate) => candidate.id === selectedId)
      : 0;
    this.list.setSelectedIndex(Math.max(0, selectedIndex));
    this.updateDetail();
    this.requestRender();
  }

  private updateDetail(): void {
    const job = this.jobs[this.list.getSelectedIndex()];
    this.detail.content = job
      ? `${job.hostId}:${job.remotePath}\n→ ${job.resolvedDestination}${job.error ? `\n${job.error}` : ""}`
      : this.i18n.t("file.noTransfer");
    this.detail.fg = job?.status === "failed" ? theme.error : theme.muted;
    this.requestRender();
  }

  private cancelSelected(): void {
    const job = this.jobs[this.list.getSelectedIndex()];
    if (job && (job.status === "queued" || job.status === "running")) this.queue.cancel(job.id);
  }

  private button(
    ctx: RenderContext,
    name: string,
    label: string,
    run: () => void,
    color: string,
  ): TextRenderable {
    return new TextRenderable(ctx, {
      id: `${this.id}-${name}`,
      content: label,
      fg: color,
      bg: theme.surface,
      onMouseOver: () => this.ctx.setMousePointer("pointer"),
      onMouseOut: () => this.ctx.setMousePointer("default"),
      onMouseDown: (event) => {
        if (event.button !== MouseButton.LEFT) return;
        run();
        event.preventDefault();
        event.stopPropagation();
      },
    });
  }
}

function statusMarker(status: DownloadJob["status"]): string {
  if (status === "running") return "▶";
  if (status === "queued") return "…";
  if (status === "completed") return "✓";
  if (status === "failed") return "!";
  return "×";
}

function formatProgress(job: DownloadJob): string {
  const total = job.progress.totalBytes;
  if (!total) return formatBytes(job.progress.bytes);
  const percent = Math.min(100, Math.floor((job.progress.bytes / total) * 100));
  return `${percent}% ${formatBytes(job.progress.bytes)}/${formatBytes(total)}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KiB`;
  if (bytes < 1_073_741_824) return `${(bytes / 1_048_576).toFixed(1)} MiB`;
  return `${(bytes / 1_073_741_824).toFixed(1)} GiB`;
}

function shortPath(path: string): string {
  return path.length <= 44 ? path : `…${path.slice(-43)}`;
}
