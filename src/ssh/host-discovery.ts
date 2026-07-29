import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import SSHConfig, {
  type Directive,
  type Line,
  LineType,
  type SSHConfig as ParsedConfig,
} from "ssh-config";
import { errorMessage } from "../core/errors.js";

export interface DiscoveredSshHost {
  alias: string;
  sourcePath: string;
}

export interface HostDiscoveryError {
  path: string;
  kind: "read" | "parse" | "include";
  message: string;
}

export interface HostDiscoveryResult {
  rootConfigPath: string;
  rootExists: boolean;
  files: readonly string[];
  hosts: readonly DiscoveredSshHost[];
  errors: readonly HostDiscoveryError[];
}

export interface HostDiscoveryOptions {
  rootConfigPath?: string;
  homeDirectory?: string;
}

interface DiscoveryContext {
  readonly rootConfigPath: string;
  readonly includeBaseDirectory: string;
  readonly homeDirectory: string;
  readonly files: string[];
  readonly hosts: DiscoveredSshHost[];
  readonly errors: HostDiscoveryError[];
  readonly visitedFiles: Set<string>;
  readonly aliases: Set<string>;
}

export async function discoverSshHosts(
  options: HostDiscoveryOptions = {},
): Promise<HostDiscoveryResult> {
  const homeDirectory = resolve(options.homeDirectory ?? homedir());
  const rootConfigPath = resolve(
    expandHome(options.rootConfigPath ?? join(homeDirectory, ".ssh", "config"), homeDirectory),
  );
  const context: DiscoveryContext = {
    rootConfigPath,
    includeBaseDirectory: dirname(rootConfigPath),
    homeDirectory,
    files: [],
    hosts: [],
    errors: [],
    visitedFiles: new Set(),
    aliases: new Set(),
  };

  let rootStat: Awaited<ReturnType<typeof stat>>;
  try {
    rootStat = await stat(rootConfigPath);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return {
        rootConfigPath,
        rootExists: false,
        files: [],
        hosts: [],
        errors: [],
      };
    }
    return {
      rootConfigPath,
      rootExists: true,
      files: [],
      hosts: [],
      errors: [
        {
          path: rootConfigPath,
          kind: "read",
          message: `Unable to inspect SSH config file: ${errorMessage(error)}`,
        },
      ],
    };
  }
  if (!rootStat.isFile()) {
    return {
      rootConfigPath,
      rootExists: true,
      files: [],
      hosts: [],
      errors: [
        {
          path: rootConfigPath,
          kind: "read",
          message: "SSH config path is not a regular file",
        },
      ],
    };
  }

  await visitFile(rootConfigPath, context, false);
  return {
    rootConfigPath,
    rootExists: true,
    files: context.files,
    hosts: context.hosts,
    errors: context.errors,
  };
}

async function visitFile(
  path: string,
  context: DiscoveryContext,
  included: boolean,
): Promise<void> {
  let canonicalPath: string;
  try {
    canonicalPath = await realpath(path);
  } catch (error) {
    context.errors.push({
      path,
      kind: included ? "include" : "read",
      message: `Unable to resolve SSH config file: ${errorMessage(error)}`,
    });
    return;
  }
  if (context.visitedFiles.has(canonicalPath)) return;
  context.visitedFiles.add(canonicalPath);
  context.files.push(canonicalPath);

  let content: string;
  try {
    content = await readFile(canonicalPath, "utf8");
  } catch (error) {
    context.errors.push({
      path: canonicalPath,
      kind: "read",
      message: `Unable to read SSH config file: ${errorMessage(error)}`,
    });
    return;
  }

  let parsed: ParsedConfig;
  try {
    parsed = SSHConfig.parse(content);
  } catch (error) {
    context.errors.push({
      path: canonicalPath,
      kind: "parse",
      message: `Unable to parse SSH config file: ${errorMessage(error)}`,
    });
    return;
  }
  await visitLines(parsed, canonicalPath, context);
}

async function visitLines(
  lines: readonly Line[],
  sourcePath: string,
  context: DiscoveryContext,
): Promise<void> {
  for (const line of lines) {
    if (line.type !== LineType.DIRECTIVE) continue;
    const parameter = line.param.toLowerCase();
    if (parameter === "host") {
      for (const alias of directiveValues(line)) addLiteralAlias(alias, sourcePath, context);
    } else if (parameter === "include") {
      for (const pattern of directiveValues(line)) {
        await visitInclude(pattern, sourcePath, context);
      }
    }
    if ("config" in line) await visitLines(line.config, sourcePath, context);
  }
}

async function visitInclude(
  rawPattern: string,
  sourcePath: string,
  context: DiscoveryContext,
): Promise<void> {
  let pattern: string;
  try {
    pattern = resolveIncludePattern(rawPattern, context);
  } catch (error) {
    context.errors.push({
      path: sourcePath,
      kind: "include",
      message: errorMessage(error),
    });
    return;
  }

  let matches: string[];
  try {
    matches = await scanAbsoluteGlob(pattern);
  } catch (error) {
    context.errors.push({
      path: sourcePath,
      kind: "include",
      message: `Unable to expand SSH Include ${rawPattern}: ${errorMessage(error)}`,
    });
    return;
  }
  if (matches.length === 0) {
    context.errors.push({
      path: sourcePath,
      kind: "include",
      message: `SSH Include did not match a readable file: ${rawPattern}`,
    });
    return;
  }
  for (const match of matches) await visitFile(match, context, true);
}

function directiveValues(directive: Directive): string[] {
  if (Array.isArray(directive.value)) return directive.value.map((value) => value.val);
  if (directive.quoted) return [directive.value];
  return directive.value.split(/\s+/).filter(Boolean);
}

function addLiteralAlias(alias: string, sourcePath: string, context: DiscoveryContext): void {
  const normalized = alias.trim();
  if (!isLiteralAlias(normalized)) return;
  const key = normalized.toLocaleLowerCase("en-US");
  if (context.aliases.has(key)) return;
  context.aliases.add(key);
  context.hosts.push({ alias: normalized, sourcePath });
}

export function isLiteralAlias(alias: string): boolean {
  return (
    alias.length > 0 &&
    !alias.startsWith("!") &&
    !alias.startsWith("-") &&
    !/[\s\0\r\n*?[\]]/.test(alias)
  );
}

function resolveIncludePattern(rawPattern: string, context: DiscoveryContext): string {
  if (rawPattern.length === 0 || /[\0\r\n]/.test(rawPattern)) {
    throw new Error("SSH Include contains an empty or unsafe path");
  }
  const expanded = expandHome(rawPattern, context.homeDirectory);
  return normalize(
    isAbsolute(expanded) ? expanded : resolve(context.includeBaseDirectory, expanded),
  );
}

function expandHome(path: string, homeDirectory: string): string {
  if (path === "~") return homeDirectory;
  if (path.startsWith("~/")) return join(homeDirectory, path.slice(2));
  if (path.startsWith("~")) throw new Error(`Unsupported SSH Include home expression: ${path}`);
  return path;
}

async function scanAbsoluteGlob(absolutePattern: string): Promise<string[]> {
  const firstMagic = absolutePattern.search(/[*?[]/);
  if (firstMagic === -1) return (await isFile(absolutePattern)) ? [absolutePattern] : [];
  const separator = absolutePattern.lastIndexOf("/", firstMagic);
  const cwd = separator <= 0 ? "/" : absolutePattern.slice(0, separator);
  const pattern = absolutePattern.slice(separator + 1);
  const matches: string[] = [];
  for await (const path of new Bun.Glob(pattern).scan({
    cwd,
    absolute: true,
    dot: true,
    onlyFiles: true,
    followSymlinks: true,
  })) {
    matches.push(path);
  }
  matches.sort();
  return matches;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return false;
    throw error;
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
