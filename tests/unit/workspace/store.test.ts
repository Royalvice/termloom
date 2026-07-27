import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDefaultWorkspace } from "../../../src/workspace/schema.js";
import { WorkspaceStore } from "../../../src/workspace/store.js";

let directory: string | undefined;
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

test("WorkspaceStore round-trips a versioned workspace", async () => {
  directory = await mkdtemp(join(tmpdir(), "termloom-state-"));
  const path = join(directory, "workspaces.json");
  const store = new WorkspaceStore(path);
  const state = createDefaultWorkspace(31);
  await store.save(state);
  expect(await store.load()).toEqual(state);
});

test("WorkspaceStore reports corruption without overwriting it", async () => {
  directory = await mkdtemp(join(tmpdir(), "termloom-state-"));
  const path = join(directory, "workspaces.json");
  await writeFile(path, "{broken", "utf8");
  await expect(new WorkspaceStore(path).load()).rejects.toMatchObject({
    code: "STATE_INVALID",
  });
  expect(await readFile(path, "utf8")).toBe("{broken");
});
