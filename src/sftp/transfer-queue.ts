import { EventEmitter } from "node:events";
import { TermLoomError, errorMessage } from "../core/errors.js";

export type DownloadSourceKind = "file" | "directory";
export type DownloadStatus = "queued" | "running" | "completed" | "cancelled" | "failed";

export interface DownloadProgress {
  bytes: number;
  totalBytes?: number;
  speedBytesPerSecond?: number;
  etaSeconds?: number;
}

export interface RemoteDownloadRequest {
  hostId: string;
  remotePath: string;
  sourceKind: DownloadSourceKind;
  localDestination: string;
  ownerPaneId: string;
}

export interface DownloadResult {
  resolvedDestination: string;
  skippedSymbolicLinks: number;
}

export interface DownloadJob extends RemoteDownloadRequest {
  id: string;
  status: DownloadStatus;
  resolvedDestination: string;
  progress: DownloadProgress;
  skippedSymbolicLinks: number;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
}

export interface DownloadWorkerContext {
  signal: AbortSignal;
  report(progress: DownloadProgress): void;
  setResolvedDestination(path: string): void;
  setSkippedSymbolicLinks(count: number): void;
}

export interface DownloadHandle {
  id: string;
  completion: Promise<DownloadResult>;
  cancel(): boolean;
}

export interface DownloadJobFilter {
  hostId?: string;
  ownerPaneId?: string;
}

export interface TransferQueueOptions {
  concurrency?: number;
  historyLimit?: number;
  historyTtlMs?: number;
  progressIntervalMs?: number;
  now?: () => number;
}

interface QueueItem {
  job: DownloadJob;
  worker: (context: DownloadWorkerContext) => Promise<DownloadResult>;
  controller: AbortController;
  resolve: (result: DownloadResult) => void;
  reject: (error: unknown) => void;
  progressTimer?: ReturnType<typeof setTimeout>;
  lastProgressEmission: number;
}

const DEFAULT_HISTORY_LIMIT = 100;
const DEFAULT_HISTORY_TTL_MS = 30 * 60 * 1_000;
const DEFAULT_PROGRESS_INTERVAL_MS = 100;

/** A bounded, ownership-aware queue for explicit remote-to-local downloads only. */
export class TransferQueue extends EventEmitter {
  private readonly jobs = new Map<string, QueueItem>();
  private readonly pending: QueueItem[] = [];
  private readonly concurrency: number;
  private readonly historyLimit: number;
  private readonly historyTtlMs: number;
  private readonly progressIntervalMs: number;
  private readonly now: () => number;
  private active = 0;
  private pumpScheduled = false;

  public constructor(options: TransferQueueOptions | number = {}) {
    super();
    const normalized =
      typeof options === "number"
        ? ({ concurrency: options } satisfies TransferQueueOptions)
        : options;
    this.concurrency = normalized.concurrency ?? 2;
    this.historyLimit = normalized.historyLimit ?? DEFAULT_HISTORY_LIMIT;
    this.historyTtlMs = normalized.historyTtlMs ?? DEFAULT_HISTORY_TTL_MS;
    this.progressIntervalMs = normalized.progressIntervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS;
    this.now = normalized.now ?? Date.now;
    if (!Number.isInteger(this.concurrency) || this.concurrency < 1) {
      throw new Error("Download queue concurrency must be a positive integer");
    }
    if (!Number.isInteger(this.historyLimit) || this.historyLimit < 0) {
      throw new Error("Download history limit must be a non-negative integer");
    }
    if (!Number.isFinite(this.historyTtlMs) || this.historyTtlMs < 0) {
      throw new Error("Download history TTL must be non-negative");
    }
    if (!Number.isFinite(this.progressIntervalMs) || this.progressIntervalMs < 0) {
      throw new Error("Download progress interval must be non-negative");
    }
  }

  public enqueue(
    request: RemoteDownloadRequest,
    worker: (context: DownloadWorkerContext) => Promise<DownloadResult>,
  ): DownloadHandle {
    validateRequest(request);
    this.pruneHistory();
    const id = `download-${crypto.randomUUID()}`;
    let resolveCompletion: (result: DownloadResult) => void = () => undefined;
    let rejectCompletion: (error: unknown) => void = () => undefined;
    const completion = new Promise<DownloadResult>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    // A caller may intentionally observe downloads through queue state only. Attach a rejection
    // handler immediately so cancellation/failure never becomes an unhandled rejection.
    void completion.catch(() => undefined);
    const created = this.now();
    const item: QueueItem = {
      job: {
        ...request,
        id,
        status: "queued",
        resolvedDestination: request.localDestination,
        progress: { bytes: 0 },
        skippedSymbolicLinks: 0,
        createdAt: new Date(created).toISOString(),
      },
      worker,
      controller: new AbortController(),
      resolve: resolveCompletion,
      reject: rejectCompletion,
      lastProgressEmission: Number.NEGATIVE_INFINITY,
    };
    this.jobs.set(id, item);
    this.pending.push(item);
    this.changed(item, true);
    this.schedulePump();
    return { id, completion, cancel: () => this.cancel(id) };
  }

  public list(filter: DownloadJobFilter = {}): readonly DownloadJob[] {
    this.pruneHistory();
    return [...this.jobs.values()]
      .map((item) => item.job)
      .filter((job) => matchesFilter(job, filter))
      .map(cloneJob);
  }

  public get(id: string): DownloadJob | undefined {
    this.pruneHistory();
    const job = this.jobs.get(id)?.job;
    return job ? cloneJob(job) : undefined;
  }

  public cancel(id: string, filter: DownloadJobFilter = {}): boolean {
    const item = this.jobs.get(id);
    if (!item || !matchesFilter(item.job, filter) || terminalStatus(item.job.status)) return false;
    if (item.job.status === "queued") {
      const index = this.pending.indexOf(item);
      if (index >= 0) this.pending.splice(index, 1);
      item.job.status = "cancelled";
      item.job.finishedAt = new Date(this.now()).toISOString();
      item.job.error = "Download cancelled";
      const error = cancelledError(id);
      item.reject(error);
      this.changed(item, true);
      this.pruneHistory();
      return true;
    }
    item.controller.abort();
    return true;
  }

  public onChange(listener: (job: DownloadJob) => void): () => void {
    this.on("change", listener);
    return () => this.off("change", listener);
  }

  private schedulePump(): void {
    if (this.pumpScheduled) return;
    this.pumpScheduled = true;
    queueMicrotask(() => {
      this.pumpScheduled = false;
      this.pump();
    });
  }

  private pump(): void {
    while (this.active < this.concurrency) {
      const item = this.pending.shift();
      if (!item) return;
      this.active += 1;
      void this.run(item).finally(() => {
        this.active -= 1;
        this.schedulePump();
      });
    }
  }

  private async run(item: QueueItem): Promise<void> {
    item.job.status = "running";
    item.job.startedAt = new Date(this.now()).toISOString();
    this.changed(item, true);
    try {
      const result = await item.worker({
        signal: item.controller.signal,
        report: (progress) => {
          item.job.progress = normalizeProgress(progress);
          this.changed(item, false);
        },
        setResolvedDestination: (path) => {
          item.job.resolvedDestination = path;
        },
        setSkippedSymbolicLinks: (count) => {
          item.job.skippedSymbolicLinks = Math.max(0, Math.floor(count));
        },
      });
      if (item.controller.signal.aborted) throw cancelledError(item.job.id);
      item.job.status = "completed";
      item.job.resolvedDestination = result.resolvedDestination;
      item.job.skippedSymbolicLinks = result.skippedSymbolicLinks;
      item.job.finishedAt = new Date(this.now()).toISOString();
      item.resolve(result);
      this.changed(item, true);
    } catch (error) {
      item.job.finishedAt = new Date(this.now()).toISOString();
      if (item.controller.signal.aborted || isCancelled(error)) {
        item.job.status = "cancelled";
        const cancellation = isCancelled(error) ? error : cancelledError(item.job.id);
        item.job.error = errorMessage(cancellation);
        item.reject(cancellation);
      } else {
        item.job.status = "failed";
        item.job.error = errorMessage(error);
        item.reject(error);
      }
      this.changed(item, true);
    } finally {
      this.clearProgressTimer(item);
      this.pruneHistory();
    }
  }

  private changed(item: QueueItem, immediate: boolean): void {
    if (immediate || this.progressIntervalMs === 0) {
      this.clearProgressTimer(item);
      item.lastProgressEmission = this.now();
      this.emit("change", cloneJob(item.job));
      return;
    }
    const elapsed = this.now() - item.lastProgressEmission;
    if (elapsed >= this.progressIntervalMs) {
      item.lastProgressEmission = this.now();
      this.emit("change", cloneJob(item.job));
      return;
    }
    if (item.progressTimer) return;
    item.progressTimer = setTimeout(
      () => {
        item.progressTimer = undefined;
        if (!this.jobs.has(item.job.id) || terminalStatus(item.job.status)) return;
        item.lastProgressEmission = this.now();
        this.emit("change", cloneJob(item.job));
      },
      Math.max(0, this.progressIntervalMs - elapsed),
    );
  }

  private clearProgressTimer(item: QueueItem): void {
    if (!item.progressTimer) return;
    clearTimeout(item.progressTimer);
    item.progressTimer = undefined;
  }

  private pruneHistory(): void {
    const cutoff = this.now() - this.historyTtlMs;
    const terminal: QueueItem[] = [];
    for (const [id, item] of this.jobs) {
      if (!terminalStatus(item.job.status)) continue;
      const finished = item.job.finishedAt ? Date.parse(item.job.finishedAt) : 0;
      if (finished < cutoff) {
        this.clearProgressTimer(item);
        this.jobs.delete(id);
      } else {
        terminal.push(item);
      }
    }
    terminal.sort((left, right) =>
      (right.job.finishedAt ?? right.job.createdAt).localeCompare(
        left.job.finishedAt ?? left.job.createdAt,
      ),
    );
    for (const item of terminal.slice(this.historyLimit)) {
      this.clearProgressTimer(item);
      this.jobs.delete(item.job.id);
    }
  }
}

function validateRequest(request: RemoteDownloadRequest): void {
  if (!request.hostId || !request.ownerPaneId || !request.remotePath) {
    throw new Error("Download request requires hostId, ownerPaneId, and remotePath");
  }
  if (request.sourceKind !== "file" && request.sourceKind !== "directory") {
    throw new Error("Download source kind must be file or directory");
  }
  if (!request.localDestination) throw new Error("Download destination must not be empty");
}

function normalizeProgress(progress: DownloadProgress): DownloadProgress {
  return {
    bytes: Math.max(0, finite(progress.bytes) ?? 0),
    totalBytes: optionalNonNegative(progress.totalBytes),
    speedBytesPerSecond: optionalNonNegative(progress.speedBytesPerSecond),
    etaSeconds: optionalNonNegative(progress.etaSeconds),
  };
}

function optionalNonNegative(value: number | undefined): number | undefined {
  const normalized = finite(value);
  return normalized === undefined ? undefined : Math.max(0, normalized);
}

function finite(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function matchesFilter(job: DownloadJob, filter: DownloadJobFilter): boolean {
  return (
    (!filter.hostId || job.hostId === filter.hostId) &&
    (!filter.ownerPaneId || job.ownerPaneId === filter.ownerPaneId)
  );
}

function cloneJob(job: DownloadJob): DownloadJob {
  return { ...job, progress: { ...job.progress } };
}

function terminalStatus(status: DownloadStatus): boolean {
  return status === "completed" || status === "cancelled" || status === "failed";
}

function cancelledError(id: string): TermLoomError {
  return new TermLoomError({
    code: "PROCESS_CANCELLED",
    message: `Download ${id} was cancelled`,
    details: { downloadId: id },
  });
}

function isCancelled(error: unknown): boolean {
  return error instanceof TermLoomError && error.code === "PROCESS_CANCELLED";
}
