import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileProvider } from "../../../src/files/file-provider.js";
import { LocalFileProvider } from "../../../src/files/local-file-provider.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("LocalFileProvider", () => {
  test("lists hidden files, directories, symlinks, metadata, and natural order", async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, "folder"));
    await writeFile(join(root, ".hidden"), "hidden");
    await writeFile(join(root, "file10.md"), "ten");
    await writeFile(join(root, "file2.md"), "two");
    await writeFile(join(root, "run.sh"), "#!/bin/sh\n");
    await chmod(join(root, "run.sh"), 0o700);
    await symlink(join(root, "file2.md"), join(root, "link.md"));

    const page = await new LocalFileProvider().list(root);

    expect(page.entries.map((entry) => entry.name)).toEqual([
      "folder",
      ".hidden",
      "file2.md",
      "file10.md",
      "link.md",
      "run.sh",
    ]);
    expect(page.entries.find((entry) => entry.name === "folder")?.isDirectory).toBe(true);
    expect(page.entries.find((entry) => entry.name === "link.md")?.isSymbolicLink).toBe(true);
    expect(page.entries.find((entry) => entry.name === "run.sh")?.mode).toBe(0o700);
    expect(page.entries.find((entry) => entry.name === "file2.md")?.mimeType).toBe("text/markdown");
    expect(page.entries.every((entry) => entry.uid !== undefined && entry.gid !== undefined)).toBe(
      true,
    );
  });

  test("paginates and searches without changing the source directory", async () => {
    const root = await temporaryDirectory();
    const provider = new LocalFileProvider();
    await mkdir(join(root, "folder"));
    await writeFile(join(root, "folder", "moved.md"), "one");
    await writeFile(join(root, "folder", "moved2.md"), "two");
    const before = (await Bun.file(join(root, "folder", "moved.md")).arrayBuffer()).byteLength;
    const searched = await provider.list(join(root, "folder"), { query: "moved", pageSize: 1 });
    expect(searched.total).toBe(2);
    expect(searched.totalPages).toBe(2);
    expect(searched.entries).toHaveLength(1);
    expect((await Bun.file(join(root, "folder", "moved.md")).arrayBuffer()).byteLength).toBe(
      before,
    );
  });

  test("does not expose any file mutation capability", () => {
    const provider: FileProvider = new LocalFileProvider();
    for (const method of [
      "createFile",
      "createDirectory",
      "rename",
      "copy",
      "move",
      "upload",
      "download",
      "delete",
    ]) {
      expect(method in provider).toBe(false);
    }
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "termloom-local-files-"));
  temporaryDirectories.push(directory);
  return directory;
}
