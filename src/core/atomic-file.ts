import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { TermLoomError } from "./errors.js";

export async function readOptionalUtf8(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return null;
    throw new TermLoomError({
      code: "FILE_IO",
      message: `Unable to read ${path}`,
      cause: error,
      details: { path },
    });
  }
}

export async function atomicWriteUtf8(path: string, content: string, mode = 0o600): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = join(
    directory,
    `.${basename(path)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, "wx", mode);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);
    await chmod(path, mode);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw new TermLoomError({
      code: "FILE_IO",
      message: `Unable to atomically write ${path}`,
      cause: error,
      details: { path },
    });
  }
}

export function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
