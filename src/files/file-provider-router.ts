import { TermLoomError } from "../core/errors.js";
import type { WorkspaceTarget } from "../workspace/schema.js";
import type { FileProvider } from "./file-provider.js";

export interface SftpProviderFactory {
  forHost(hostId: string): FileProvider;
}

export class FileProviderRouter {
  public constructor(
    private readonly local: FileProvider,
    private readonly sftp?: SftpProviderFactory,
    private readonly remoteError?: unknown,
  ) {}

  public forTarget(target: WorkspaceTarget): FileProvider {
    if (target.kind === "local") return this.local;
    if (this.sftp) return this.sftp.forHost(target.hostId);
    throw new TermLoomError({
      code: "DEPENDENCY_MISSING",
      message: "Remote files are unavailable because rclone was not found",
      hint: "Install rclone and run termloom doctor again. Local files remain available.",
      details: {
        dependency: "rclone",
        remoteError: this.remoteError instanceof Error ? this.remoteError.message : undefined,
      },
    });
  }
}
