export interface TerminalPathToken {
  /** The normalized absolute POSIX path used for FileProvider.stat(). */
  path: string;
  /** The terminal token before file:// and line/column normalization. */
  raw: string;
  /**
   * Safe fallbacks for ambiguous terminal prose. For example, shells print
   * `/path:` before an error message. The delimiter-free path is tried first,
   * then the literal colon spelling only if it is a real POSIX name.
   */
  alternatePaths?: readonly string[];
}

export interface TerminalPathTokenMatch {
  token: TerminalPathToken;
  /** UTF-16 offsets in the terminal row, used only for render-time hover styling. */
  start: number;
  end: number;
}

interface RawTokenMatch {
  raw: string;
  start: number;
  end: number;
  quote?: "single" | "double" | "backtick";
}

interface NormalizedPath {
  path: string;
  alternatePaths?: readonly string[];
  terminalDelimiterLength?: number;
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
  return terminalPathTokenMatchAt(line, characterIndex)?.token;
}

/**
 * Like terminalPathTokenAt(), but preserves the terminal-row range for a
 * renderable to draw a non-destructive hover underline over the matched token.
 */
export function terminalPathTokenMatchAt(
  line: string,
  characterIndex: number,
): TerminalPathTokenMatch | undefined {
  if (!Number.isInteger(characterIndex) || characterIndex < 0 || characterIndex >= line.length) {
    return undefined;
  }
  const raw = tokenAt(line, characterIndex);
  if (!raw) return undefined;
  const normalized = normalizeAbsolutePath(raw.raw, raw.quote);
  if (!normalized) return undefined;
  return {
    token: {
      raw: raw.raw,
      path: normalized.path,
      ...(normalized.alternatePaths ? { alternatePaths: normalized.alternatePaths } : {}),
    },
    start: raw.start,
    end: raw.end - (normalized.terminalDelimiterLength ?? 0),
  };
}

/**
 * Find every trustworthy absolute path on one terminal row.
 *
 * This deliberately shares the exact normalization and fail-closed rules used
 * for activation. Rendering a link affordance must never imply that a token is
 * clickable when Ctrl+Click would reject it.
 */
export function terminalPathTokenMatches(line: string): readonly TerminalPathTokenMatch[] {
  const matches: TerminalPathTokenMatch[] = [];
  for (let index = 0; index < line.length; ) {
    const value = line[index] ?? "";
    const canStartPath = value === "/" || (value === "f" && line.startsWith("file:", index));
    if (!canStartPath) {
      index += 1;
      continue;
    }

    const match = terminalPathTokenMatchAt(line, index);
    if (!match) {
      index += 1;
      continue;
    }
    const previous = matches.at(-1);
    if (!previous || previous.start !== match.start || previous.end !== match.end) {
      matches.push(match);
    }
    // Move past the match to prevent paths such as /workspace/src/file.ts from
    // being reparsed once for every slash. `end` is always after `index` here.
    index = Math.max(index + 1, match.end);
  }
  return matches;
}

function tokenAt(line: string, index: number): RawTokenMatch | undefined {
  const quoted = quotedTokenAt(line, index);
  if (quoted) return quoted;
  if (isTokenBoundaryAt(line, index)) return undefined;

  let start = index;
  while (start > 0 && !isTokenBoundaryAt(line, start - 1)) start -= 1;
  let end = index + 1;
  while (end < line.length && !isTokenBoundaryAt(line, end)) end += 1;
  const raw = line.slice(start, end);
  return raw.length > 0 ? { raw, start, end } : undefined;
}

function quotedTokenAt(line: string, index: number): RawTokenMatch | undefined {
  for (const [quote, kind] of [
    ['"', "double"],
    ["'", "single"],
    ["`", "backtick"],
  ] as const) {
    const quoteStart = line.lastIndexOf(quote, index);
    if (quoteStart < 0 || quoteStart >= index) continue;
    const quoteEnd = line.indexOf(quote, index);
    if (quoteEnd < 0 || quoteEnd <= index) continue;
    const raw = line.slice(quoteStart + 1, quoteEnd);
    if (raw.length > 0) return { raw, start: quoteStart + 1, end: quoteEnd, quote: kind };
  }
  return undefined;
}

function normalizeAbsolutePath(
  raw: string,
  quote: RawTokenMatch["quote"],
): NormalizedPath | undefined {
  if (raw.includes("\0")) return undefined;
  let candidate = raw.replace(LINE_AND_COLUMN_SUFFIX, "");
  const literalTrailingColon = candidate.endsWith(":");
  if (literalTrailingColon) candidate = candidate.slice(0, -1);

  const paths = decodeCandidatePaths(candidate, quote);
  const path = paths[0];
  if (!path) return undefined;
  const alternates = paths.slice(1);
  if (literalTrailingColon) {
    for (const literalPath of decodeCandidatePaths(
      raw.replace(LINE_AND_COLUMN_SUFFIX, ""),
      quote,
    )) {
      if (literalPath !== path && !alternates.includes(literalPath)) alternates.push(literalPath);
    }
  }
  return {
    path,
    ...(literalTrailingColon ? { terminalDelimiterLength: 1 } : {}),
    ...(alternates.length > 0 ? { alternatePaths: alternates } : {}),
  };
}

function decodeCandidatePaths(candidate: string, quote: RawTokenMatch["quote"]): string[] {
  const spellings = quote ? [candidate] : shellUnescapedSpellings(candidate);
  const paths: string[] = [];
  for (const spelling of spellings) {
    const path = decodeAbsolutePath(spelling);
    if (path && !paths.includes(path)) paths.push(path);
  }
  return paths;
}

/**
 * A path typed as an unquoted shell word may visibly contain backslash escapes
 * (`ref2v\_krea`, `folder\ name`). Prefer the spelling the shell executes, but
 * retain the literal spelling as a verified fallback for real backslash names.
 */
function shellUnescapedSpellings(candidate: string): string[] {
  if (!candidate.includes("\\")) return [candidate];
  let decoded = "";
  for (let index = 0; index < candidate.length; index += 1) {
    const value = candidate[index] ?? "";
    if (value !== "\\") {
      decoded += value;
      continue;
    }
    const escaped = candidate[index + 1];
    if (escaped === undefined || escaped === "\r" || escaped === "\n" || escaped === "\0") {
      return [candidate];
    }
    decoded += escaped;
    index += 1;
  }
  return decoded === candidate ? [candidate] : [decoded, candidate];
}

function decodeAbsolutePath(candidate: string): string | undefined {
  let path = candidate;
  if (path.startsWith("file:")) {
    try {
      const url = new URL(path);
      if (url.protocol !== "file:" || (url.hostname !== "" && url.hostname !== "localhost")) {
        return undefined;
      }
      path = decodeURIComponent(url.pathname);
    } catch {
      return undefined;
    }
  }
  return path.startsWith("/") && !path.includes("\0") ? path : undefined;
}

function isBoundary(value: string): boolean {
  return BOUNDARY.has(value);
}

function isTokenBoundaryAt(line: string, index: number): boolean {
  if (!isBoundary(line[index] ?? "")) return false;
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && line[cursor] === "\\"; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 0;
}
