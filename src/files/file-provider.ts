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
  signal?: AbortSignal;
  refresh?: boolean;
}

export interface FileStatOptions {
  signal?: AbortSignal;
}

export interface FileProvider {
  readonly kind: "local" | "sftp";
  list(path: string, options?: DirectoryQuery): Promise<DirectoryPage>;
  stat(path: string, options?: FileStatOptions): Promise<FileEntry>;
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
  const { page, pageSize, totalPages, offset } = directoryPageWindow(filtered.length, options);
  return {
    path,
    entries: filtered.slice(offset, offset + pageSize),
    page,
    pageSize,
    total: filtered.length,
    totalPages,
  };
}

export function directoryPageWindow(
  total: number,
  options: Pick<DirectoryQuery, "page" | "pageSize"> = {},
): { page: number; pageSize: number; totalPages: number; offset: number } {
  const pageSize = clampInteger(options.pageSize ?? 100, 1, 1_000);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = clampInteger(options.page ?? 1, 1, totalPages);
  return { page, pageSize, totalPages, offset: (page - 1) * pageSize };
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, Math.floor(value)));
}
