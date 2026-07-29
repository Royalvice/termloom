import type { TransferHandle, TransferQueue } from "../sftp/transfer-queue.js";

export type ConflictPolicy = "error" | "overwrite" | "skip" | "rename";

export interface FileEntry {
  name: string;
  path: string;
  size: number;
  isDirectory: boolean;
  isSymbolicLink: boolean;
  mimeType?: string;
  modifiedAt?: Date;
  mode?: number;
  uid?: number;
  gid?: number;
  hashes: Readonly<Record<string, string>>;
}

export interface DirectoryPage {
  path: string;
  entries: readonly FileEntry[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface DirectoryQuery {
  page?: number;
  pageSize?: number;
  query?: string;
}

export interface FileOperationResult {
  status: "completed" | "skipped";
  destination: string;
}

export interface FileProvider {
  readonly kind: "local" | "sftp";
  readonly queue?: TransferQueue;
  list(path: string, options?: DirectoryQuery): Promise<DirectoryPage>;
  stat(path: string): Promise<FileEntry>;
  createDirectory(path: string): Promise<void>;
  createFile(path: string): Promise<void>;
  rename(
    source: string,
    destination: string,
    policy?: ConflictPolicy,
  ): Promise<FileOperationResult>;
  copy(source: string, destination: string, policy?: ConflictPolicy): Promise<FileOperationResult>;
  move(source: string, destination: string, policy?: ConflictPolicy): Promise<FileOperationResult>;
  upload?(localPath: string, remotePath: string, policy?: ConflictPolicy): TransferHandle;
  download?(remotePath: string, localPath: string, policy?: ConflictPolicy): TransferHandle;
}

export function compareFileEntries(left: FileEntry, right: FileEntry): number {
  if (left.isDirectory !== right.isDirectory) return left.isDirectory ? -1 : 1;
  return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" });
}

export function paginateEntries(
  path: string,
  entries: readonly FileEntry[],
  options: DirectoryQuery = {},
): DirectoryPage {
  const query = options.query?.trim().toLocaleLowerCase();
  const filtered = entries
    .filter((entry) => !query || entry.name.toLocaleLowerCase().includes(query))
    .sort(compareFileEntries);
  const pageSize = clampInteger(options.pageSize ?? 100, 1, 1_000);
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const page = clampInteger(options.page ?? 1, 1, totalPages);
  const offset = (page - 1) * pageSize;
  return {
    path,
    entries: filtered.slice(offset, offset + pageSize),
    page,
    pageSize,
    total: filtered.length,
    totalPages,
  };
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, Math.floor(value)));
}
