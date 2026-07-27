export type TermLoomErrorCode =
  | "CONFIG_INVALID"
  | "STATE_INVALID"
  | "FILE_IO"
  | "COMMAND_UNKNOWN"
  | "COMMAND_FAILED"
  | "WORKSPACE_INVALID"
  | "DEPENDENCY_MISSING"
  | "CAPABILITY_UNSUPPORTED"
  | "PROCESS_FAILED"
  | "PROCESS_TIMEOUT"
  | "PROCESS_CANCELLED"
  | "SSH_CONFIG_INVALID"
  | "SSH_HOST_UNKNOWN"
  | "TRANSFER_CONFLICT"
  | "HTTP_PERMISSION_REQUIRED"
  | "RESOURCE_INVALID"
  | "RESOURCE_TOO_LARGE";

export interface TermLoomErrorOptions {
  code: TermLoomErrorCode;
  message: string;
  hint?: string;
  cause?: unknown;
  details?: Readonly<Record<string, unknown>>;
}

export class TermLoomError extends Error {
  public readonly code: TermLoomErrorCode;
  public readonly hint: string | undefined;
  public readonly details: Readonly<Record<string, unknown>>;

  public constructor(options: TermLoomErrorOptions) {
    super(options.message, { cause: options.cause });
    this.name = "TermLoomError";
    this.code = options.code;
    this.hint = options.hint;
    this.details = options.details ?? {};
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
