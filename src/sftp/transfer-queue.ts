import { EventEmitter } from "node:events";
import { TermLoomError, errorMessage } from "../core/errors.js";

export type TransferDirection = "upload" | "download";
export type TransferStatus =
  | "queued"
  | "running"
  | "completed"
  | "skipped"
  | "cancelled"
  | "failed";

export interface TransferProgress {
  bytes: number;
  totalBytes?: number;
  speedBytesPerSecond?: number;
  etaSeconds?: number;
}

export interface TransferRequest {
  direction: TransferDirection;
  source: string;
  destination: string;
}

export interface TransferResult {
  destination: string;
  skipped?: boolean;
}

export interface TransferJob extends TransferRequest {
  id: string;
  status: TransferStatus;
  progress: TransferProgress;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
}

export interface TransferWorkerContext {
  signal: AbortSignal;
  report(progress: TransferProgress): void;
}

export interface TransferHandle {
  id: string;
  completion: Promise<TransferResult>;
  cancel(): boolean;
}

interface QueueItem {
  job: TransferJob;
  worker: (context: TransferWorkerContext) => Promise<TransferResult>;
  controller: AbortController;
  resolve: (result: TransferResult) => void;
  reject: (error: unknown) => void;
}

export class TransferQueue extends EventEmitter {
  private readonly jobs = new Map<string, QueueItem>();
  private readonly pending: QueueItem[] = [];
  private active = 0;
  private pumpScheduled = false;

  public constructor(private readonly concurrency = 2) {
    super();
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new Error("Transfer queue concurrency must be a positive integer");
    }
  }

  public enqueue(
    request: TransferRequest,
    worker: (context: TransferWorkerContext) => Promise<TransferResult>,
  ): TransferHandle {
    const id = `transfer-${crypto.randomUUID()}`;
    let resolveCompletion: (result: TransferResult) => void = () => undefined;
    let rejectCompletion: (error: unknown) => void = () => undefined;
    const completion = new Promise<TransferResult>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    const item: QueueItem = {
      job: {
        ...request,
        id,
        status: "queued",
        progress: { bytes: 0 },
        createdAt: new Date().toISOString(),
      },
      worker,
      controller: new AbortController(),
      resolve: resolveCompletion,
      reject: rejectCompletion,
    };
    this.jobs.set(id, item);
    this.pending.push(item);
    this.changed(item);
    this.schedulePump();
    return { id, completion, cancel: () => this.cancel(id) };
  }

  public list(): readonly TransferJob[] {
    return [...this.jobs.values()].map((item) => structuredClone(item.job));
  }

  public get(id: string): TransferJob | undefined {
    const job = this.jobs.get(id)?.job;
    return job ? structuredClone(job) : undefined;
  }

  public cancel(id: string): boolean {
    const item = this.jobs.get(id);
    if (!item || terminalStatus(item.job.status)) return false;
    if (item.job.status === "queued") {
      const index = this.pending.indexOf(item);
      if (index >= 0) this.pending.splice(index, 1);
      item.job.status = "cancelled";
      item.job.finishedAt = new Date().toISOString();
      const error = cancelledError(id);
      item.reject(error);
      this.changed(item);
      return true;
    }
    item.controller.abort();
    return true;
  }

  public onChange(listener: (job: TransferJob) => void): () => void {
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
    item.job.startedAt = new Date().toISOString();
    this.changed(item);
    try {
      const result = await item.worker({
        signal: item.controller.signal,
        report: (progress) => {
          item.job.progress = { ...progress };
          this.changed(item);
        },
      });
      if (item.controller.signal.aborted) throw cancelledError(item.job.id);
      item.job.status = result.skipped ? "skipped" : "completed";
      item.job.finishedAt = new Date().toISOString();
      item.resolve(result);
      this.changed(item);
    } catch (error) {
      item.job.finishedAt = new Date().toISOString();
      if (item.controller.signal.aborted || isCancelled(error)) {
        item.job.status = "cancelled";
        item.job.error = "Transfer cancelled";
        const cancellation = cancelledError(item.job.id);
        item.reject(cancellation);
      } else {
        item.job.status = "failed";
        item.job.error = errorMessage(error);
        item.reject(error);
      }
      this.changed(item);
    }
  }

  private changed(item: QueueItem): void {
    this.emit("change", structuredClone(item.job));
  }
}

function terminalStatus(status: TransferStatus): boolean {
  return ["completed", "skipped", "cancelled", "failed"].includes(status);
}

function cancelledError(id: string): TermLoomError {
  return new TermLoomError({
    code: "PROCESS_CANCELLED",
    message: `Transfer ${id} was cancelled`,
    details: { transferId: id },
  });
}

function isCancelled(error: unknown): boolean {
  return error instanceof TermLoomError && error.code === "PROCESS_CANCELLED";
}
