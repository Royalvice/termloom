import { errorMessage, TermLoomError } from "../core/errors.js";

export interface ProcessResult {
  command: string;
  args: readonly string[];
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface RunProcessOptions {
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  stdin?: string | Uint8Array;
  timeoutMs?: number;
  signal?: AbortSignal;
  allowNonZero?: boolean;
}

export async function runProcess(
  command: string,
  args: readonly string[],
  options: RunProcessOptions = {},
): Promise<ProcessResult> {
  if (options.signal?.aborted) throw cancelled(command, args);
  const startedAt = performance.now();
  let timedOut = false;
  let aborted = false;
  let forceKillTimeout: ReturnType<typeof setTimeout> | undefined;
  let subprocess: Bun.PipedSubprocess;
  try {
    subprocess = Bun.spawn([command, ...args], {
      cwd: options.cwd,
      env: options.env ? { ...cleanEnvironment(process.env), ...options.env } : undefined,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      detached: process.platform !== "win32",
    });
  } catch (error) {
    throw new TermLoomError({
      code: "PROCESS_FAILED",
      message: `Unable to start ${command}: ${errorMessage(error)}`,
      cause: error,
      details: commandDetails(command, args),
    });
  }

  const terminate = () => {
    terminateSubprocess(subprocess, "SIGTERM");
    forceKillTimeout ??= setTimeout(() => terminateSubprocess(subprocess, "SIGKILL"), 500);
  };
  const abort = () => {
    aborted = true;
    terminate();
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  const timeout =
    options.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          terminate();
        }, options.timeoutMs);

  if (options.stdin !== undefined) {
    subprocess.stdin.write(options.stdin);
  }
  subprocess.stdin.end();

  const stdoutPromise = new Response(subprocess.stdout).text();
  const stderrPromise = new Response(subprocess.stderr).text();
  const [exitCode, stdout, stderr] = await Promise.all([
    subprocess.exited,
    stdoutPromise,
    stderrPromise,
  ]).finally(() => {
    if (timeout !== undefined) clearTimeout(timeout);
    if (forceKillTimeout !== undefined) clearTimeout(forceKillTimeout);
    options.signal?.removeEventListener("abort", abort);
  });
  const result: ProcessResult = {
    command,
    args: [...args],
    exitCode,
    stdout,
    stderr,
    durationMs: performance.now() - startedAt,
  };
  if (timedOut) {
    const diagnostic = redactText(stderr.trim()).slice(-4_096);
    throw new TermLoomError({
      code: "PROCESS_TIMEOUT",
      message: `${command} timed out after ${options.timeoutMs} ms${diagnostic ? `: ${diagnostic}` : ""}`,
      details: { ...commandDetails(command, args), timeoutMs: options.timeoutMs },
    });
  }
  if (aborted) throw cancelled(command, args);
  if (exitCode !== 0 && !options.allowNonZero) {
    throw new TermLoomError({
      code: "PROCESS_FAILED",
      message: `${command} exited with status ${exitCode}: ${redactText(stderr.trim())}`,
      details: { ...commandDetails(command, args), exitCode },
    });
  }
  return result;
}

function terminateSubprocess(subprocess: Bun.PipedSubprocess, signal: NodeJS.Signals): void {
  if (process.platform !== "win32") {
    try {
      process.kill(-subprocess.pid, signal);
      return;
    } catch {
      // Fall through if the process group no longer exists or could not be signalled.
    }
  }
  if (subprocess.exitCode !== null) return;
  try {
    subprocess.kill(signal);
  } catch {
    // The child already exited.
  }
}

export function redactText(value: string): string {
  return value
    .replace(
      /-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----[\s\S]*?-----END \1-----/gu,
      "-----BEGIN $1-----\n<redacted>\n-----END $1-----",
    )
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:)[^@\s/]+@/gi, "$1<redacted>@")
    .replace(
      /(\b(?:password|passphrase|token|authorization|secret|api[_-]?key|access[_-]?token)\b\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}]+)/giu,
      "$1<redacted>",
    )
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi, "$1 <redacted>");
}

function commandDetails(
  command: string,
  args: readonly string[],
): Readonly<Record<string, unknown>> {
  return { command, args: args.map(redactText) };
}

function cancelled(command: string, args: readonly string[]): TermLoomError {
  return new TermLoomError({
    code: "PROCESS_CANCELLED",
    message: `${command} was cancelled`,
    details: commandDetails(command, args),
  });
}

function cleanEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}
