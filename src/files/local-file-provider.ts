import { lstat, readdir, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { lookup } from "mime-types";
import {
  type DirectoryPage,
  type DirectoryQuery,
  type FileEntry,
  type FileProvider,
  type FileStatOptions,
  directoryPageWindow,
} from "./file-provider.js";

export class LocalFileProvider implements FileProvider {
  public readonly kind = "local" as const;

  public async list(path: string, options: DirectoryQuery = {}): Promise<DirectoryPage> {
    const directory = resolve(path);
    options.signal?.throwIfAborted();
    const values = await readdir(directory, { withFileTypes: true });
    options.signal?.throwIfAborted();
    const query = options.query?.trim().toLocaleLowerCase();
    const filtered = values
      .filter((value) => !query || value.name.toLocaleLowerCase().includes(query))
      .sort((left, right) => {
        if (left.isDirectory() !== right.isDirectory()) return left.isDirectory() ? -1 : 1;
        return left.name.localeCompare(right.name, undefined, {
          numeric: true,
          sensitivity: "base",
        });
      });
    const window = directoryPageWindow(filtered.length, options);
    const entries = await Promise.all(
      filtered
        .slice(window.offset, window.offset + window.pageSize)
        .map(async (value) => this.entry(join(directory, value.name), options.signal)),
    );
    options.signal?.throwIfAborted();
    return {
      path: directory,
      entries,
      page: window.page,
      pageSize: window.pageSize,
      total: filtered.length,
      totalPages: window.totalPages,
    };
  }

  public async stat(path: string, options: FileStatOptions = {}): Promise<FileEntry> {
    return this.entry(resolve(path), options.signal);
  }

  private async entry(path: string, signal?: AbortSignal): Promise<FileEntry> {
    signal?.throwIfAborted();
    const linkMetadata = await lstat(path);
    signal?.throwIfAborted();
    const isSymbolicLink = linkMetadata.isSymbolicLink();
    let metadata = linkMetadata;
    if (isSymbolicLink) {
      try {
        metadata = await stat(path);
        signal?.throwIfAborted();
      } catch {
        // A broken symlink remains a visible link with its own lstat metadata.
      }
    }
    const mime = lookup(path);
    return {
      name: basename(path),
      path,
      size: metadata.size,
      isDirectory: metadata.isDirectory(),
      isSymbolicLink,
      mimeType: mime || undefined,
      modifiedAt: metadata.mtime,
      mode: metadata.mode & 0o7777,
      uid: metadata.uid,
      gid: metadata.gid,
      hashes: {},
    };
  }
}
