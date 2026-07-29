import {
  access,
  copyFile,
  cp,
  lstat,
  mkdir,
  open,
  readdir,
  rename as renamePath,
  rm,
  stat,
} from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { lookup } from "mime-types";
import { TermLoomError } from "../core/errors.js";
import {
  type ConflictPolicy,
  type DirectoryPage,
  type DirectoryQuery,
  type FileEntry,
  type FileOperationResult,
  type FileProvider,
  paginateEntries,
} from "./file-provider.js";

export class LocalFileProvider implements FileProvider {
  public readonly kind = "local" as const;

  public async list(path: string, options: DirectoryQuery = {}): Promise<DirectoryPage> {
    const directory = resolve(path);
    const values = await readdir(directory, { withFileTypes: true });
    const entries = await Promise.all(
      values.map(async (value) => this.entry(join(directory, value.name))),
    );
    return paginateEntries(directory, entries, options);
  }

  public async stat(path: string): Promise<FileEntry> {
    return this.entry(resolve(path));
  }

  public async createDirectory(path: string): Promise<void> {
    await mkdir(resolve(path));
  }

  public async createFile(path: string): Promise<void> {
    const handle = await open(resolve(path), "wx", 0o600);
    await handle.close();
  }

  public async rename(
    source: string,
    destination: string,
    policy: ConflictPolicy = "error",
  ): Promise<FileOperationResult> {
    return this.move(source, destination, policy);
  }

  public async copy(
    source: string,
    destination: string,
    policy: ConflictPolicy = "error",
  ): Promise<FileOperationResult> {
    const sourcePath = resolve(source);
    const resolved = await this.resolveDestination(resolve(destination), policy);
    if (resolved === null) return { status: "skipped", destination: resolve(destination) };
    const metadata = await lstat(sourcePath);
    if (policy === "overwrite" && (await exists(resolved))) {
      await rm(resolved, { recursive: true, force: true });
    }
    if (metadata.isDirectory()) {
      await cp(sourcePath, resolved, { recursive: true, force: false, errorOnExist: true });
    } else {
      await copyFile(sourcePath, resolved);
    }
    return { status: "completed", destination: resolved };
  }

  public async move(
    source: string,
    destination: string,
    policy: ConflictPolicy = "error",
  ): Promise<FileOperationResult> {
    const sourcePath = resolve(source);
    const destinationPath = resolve(destination);
    const resolved = await this.resolveDestination(destinationPath, policy);
    if (resolved === null) return { status: "skipped", destination: destinationPath };
    if (policy === "overwrite" && (await exists(resolved))) {
      await rm(resolved, { recursive: true, force: true });
    }
    await renamePath(sourcePath, resolved);
    return { status: "completed", destination: resolved };
  }

  private async entry(path: string): Promise<FileEntry> {
    const linkMetadata = await lstat(path);
    const isSymbolicLink = linkMetadata.isSymbolicLink();
    let metadata = linkMetadata;
    if (isSymbolicLink) {
      try {
        metadata = await stat(path);
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

  private async resolveDestination(path: string, policy: ConflictPolicy): Promise<string | null> {
    if (!(await exists(path)) || policy === "overwrite") return path;
    if (policy === "skip") return null;
    if (policy === "error") throw conflict(path);
    const extension = extname(path);
    const stem = extension ? basename(path, extension) : basename(path);
    for (let index = 1; index <= 10_000; index += 1) {
      const candidate = join(dirname(path), `${stem} (${index})${extension}`);
      if (!(await exists(candidate))) return candidate;
    }
    throw new TermLoomError({
      code: "TRANSFER_CONFLICT",
      message: `Unable to find a free destination name for ${path}`,
    });
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function conflict(path: string): TermLoomError {
  return new TermLoomError({
    code: "TRANSFER_CONFLICT",
    message: `Destination already exists: ${path}`,
    hint: "Choose overwrite, skip, or rename explicitly.",
    details: { path },
  });
}
