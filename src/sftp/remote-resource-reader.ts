import type { FileEntry } from "../files/file-provider.js";

export interface RemoteReadOptions {
  signal?: AbortSignal;
  offset?: number;
  length?: number;
}

export interface RemoteMaterializeOptions {
  signal?: AbortSignal;
  maxBytes: number;
  report?: (bytes: number, totalBytes?: number) => void;
}

/** Read-only remote access used by preview/cache code. It never writes to the remote host. */
export interface RemoteResourceReader {
  stat(hostId: string, path: string, options?: { signal?: AbortSignal }): Promise<FileEntry>;
  read(hostId: string, path: string, options?: RemoteReadOptions): Promise<Uint8Array>;
  materialize(
    hostId: string,
    path: string,
    localCachePath: string,
    options: RemoteMaterializeOptions,
  ): Promise<void>;
}
