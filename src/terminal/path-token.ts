export interface TerminalPathToken {
  /** The normalized absolute POSIX path used for FileProvider.stat(). */
  path: string;
  /** The terminal token before file:// and line/column normalization. */
  raw: string;
}

const BOUNDARY = new Set([
  " ",
  "\t",
  "\r",
  "\n",
  "(",
  ")",
  "[",
  "]",
  "{",
  "}",
  "<",
  ">",
  ",",
  ";",
  '"',
  "'",
  "`",
]);
const LINE_AND_COLUMN_SUFFIX = /:(\d+)(?::\d+)?$/;

/**
 * Extract a trustworthy absolute file path from the token under a terminal
 * cell. Relative paths deliberately return undefined: terminal output alone
 * does not establish a safe, unambiguous working directory.
 */
export function terminalPathTokenAt(
  line: string,
  characterIndex: number,
): TerminalPathToken | undefined {
  if (!Number.isInteger(characterIndex) || characterIndex < 0 || characterIndex >= line.length) {
    return undefined;
  }
  const raw = tokenAt(line, characterIndex);
  if (!raw) return undefined;
  const path = normalizeAbsolutePath(raw);
  return path ? { raw, path } : undefined;
}

function tokenAt(line: string, index: number): string | undefined {
  const quoted = quotedTokenAt(line, index);
  if (quoted) return quoted;
  if (isBoundary(line[index] ?? "")) return undefined;

  let start = index;
  while (start > 0 && !isBoundary(line[start - 1] ?? "")) start -= 1;
  let end = index + 1;
  while (end < line.length && !isBoundary(line[end] ?? "")) end += 1;
  const token = line.slice(start, end);
  return token.length > 0 ? token : undefined;
}

function quotedTokenAt(line: string, index: number): string | undefined {
  for (const quote of ['"', "'", "`"] as const) {
    const start = line.lastIndexOf(quote, index);
    if (start < 0 || start >= index) continue;
    const end = line.indexOf(quote, index);
    if (end < 0 || end <= index) continue;
    const token = line.slice(start + 1, end);
    if (token.length > 0) return token;
  }
  return undefined;
}

function normalizeAbsolutePath(raw: string): string | undefined {
  if (raw.includes("\0")) return undefined;
  let candidate = raw.replace(LINE_AND_COLUMN_SUFFIX, "");
  if (candidate.startsWith("file:")) {
    try {
      const url = new URL(candidate);
      if (url.protocol !== "file:" || (url.hostname !== "" && url.hostname !== "localhost")) {
        return undefined;
      }
      candidate = decodeURIComponent(url.pathname).replace(LINE_AND_COLUMN_SUFFIX, "");
    } catch {
      return undefined;
    }
  }
  return candidate.startsWith("/") && !candidate.includes("\0") ? candidate : undefined;
}

function isBoundary(value: string): boolean {
  return BOUNDARY.has(value);
}
