import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDefaultWorkspace,
  type WorkspaceSnapshotV1,
  type WorkspaceSnapshotV2,
} from "../../../src/workspace/schema.js";
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

test("WorkspaceStore migrates the pristine v1 Local shell to Local Files at HOME", async () => {
  directory = await mkdtemp(join(tmpdir(), "termloom-state-"));
  const path = join(directory, "workspaces.json");
  const original = `${JSON.stringify(pristineV1(), null, 2)}\n`;
  await writeFile(path, original, { encoding: "utf8", mode: 0o600 });

  const migrated = await new WorkspaceStore(path, "/fixture/home").load();

  expect(migrated.schemaVersion).toBe(3);
  expect(migrated.tabs[0]).toMatchObject({
    title: "Local",
    target: { kind: "local" },
    activeSurface: "files",
  });
  const filesPaneId = migrated.tabs[0]?.surfaces.files.activePaneId;
  expect(filesPaneId ? migrated.panes[filesPaneId] : undefined).toMatchObject({
    kind: "files",
    target: { kind: "local" },
    path: "/fixture/home",
  });
  expect(migrated.panes["pane-local-1"]).toBeUndefined();
  expect(await readFile(`${path}.v1.bak`, "utf8")).toBe(original);
  expect((await stat(`${path}.v1.bak`)).mode & 0o777).toBe(0o600);
});

test("WorkspaceStore losslessly preserves custom v1 layouts in the matching surface", async () => {
  directory = await mkdtemp(join(tmpdir(), "termloom-state-"));
  const path = join(directory, "workspaces.json");
  const snapshot = pristineV1();
  snapshot.tabs = [
    {
      id: "tab-remote",
      title: "Remote work",
      root: {
        type: "split",
        id: "split-remote",
        direction: "horizontal",
        ratio: 0.4,
        first: { type: "pane", paneId: "terminal-remote" },
        second: { type: "pane", paneId: "files-remote" },
      },
      activePaneId: "terminal-remote",
    },
  ];
  snapshot.activeTabId = "tab-remote";
  snapshot.panes = {
    "terminal-remote": {
      id: "terminal-remote",
      kind: "terminal",
      title: "work",
      hostId: "stable-host",
      tmuxSession: "work",
    },
    "files-remote": {
      id: "files-remote",
      kind: "files",
      title: "Files",
      hostId: "stable-host",
      path: "/srv/project",
      selectedPath: "/srv/project/README.md",
    },
  };
  const original = `${JSON.stringify(snapshot, null, 2)}\n`;
  await writeFile(path, original, "utf8");

  const migrated = await new WorkspaceStore(path, "/fixture/home").load();

  const tab = migrated.tabs[0];
  expect(tab).toMatchObject({
    target: { kind: "ssh", hostId: "stable-host" },
    activeSurface: "terminal",
  });
  expect(tab?.surfaces.terminal.root).toEqual(snapshot.tabs[0]?.root);
  expect(tab?.surfaces.terminal.activePaneId).toBe("terminal-remote");
  expect(migrated.panes["terminal-remote"]).toMatchObject({
    kind: "terminal",
    target: { kind: "ssh", hostId: "stable-host" },
    tmuxSession: "work",
  });
  expect(migrated.panes["files-remote"]).toMatchObject({
    kind: "files",
    target: { kind: "ssh", hostId: "stable-host" },
    path: "/srv/project",
    selectedPath: "/srv/project/README.md",
  });
  expect(tab?.surfaces.files.activePaneId).not.toBe("terminal-remote");
});

test("WorkspaceStore migrates v2 targets and changes an idle session picker to a launcher", async () => {
  directory = await mkdtemp(join(tmpdir(), "termloom-state-"));
  const path = join(directory, "workspaces.json");
  const snapshot = remoteV2();
  const original = `${JSON.stringify(snapshot, null, 2)}\n`;
  await writeFile(path, original, { encoding: "utf8", mode: 0o600 });

  const migrated = await new WorkspaceStore(path, "/fixture/home").load();

  expect(migrated.schemaVersion).toBe(3);
  expect(migrated.tabs[0]?.target).toEqual({ kind: "ssh", hostId: "stable-host" });
  expect(migrated.panes["remote-files"]).toMatchObject({
    kind: "files",
    target: { kind: "ssh", hostId: "stable-host" },
    path: "/srv/project",
  });
  expect(migrated.panes["remote-picker"]).toEqual({
    id: "remote-picker",
    kind: "terminal-launcher",
    title: "Terminal",
    target: { kind: "ssh", hostId: "stable-host" },
  });
  expect(await readFile(`${path}.v2.bak`, "utf8")).toBe(original);
  expect((await stat(`${path}.v2.bak`)).mode & 0o777).toBe(0o600);
});

test("WorkspaceStore leaves an invalid v1 snapshot and existing backup untouched", async () => {
  directory = await mkdtemp(join(tmpdir(), "termloom-state-"));
  const path = join(directory, "workspaces.json");
  const original = `${JSON.stringify({ ...pristineV1(), unknown: true }, null, 2)}\n`;
  await writeFile(path, original, "utf8");
  await writeFile(`${path}.v1.bak`, "existing backup", "utf8");

  await expect(new WorkspaceStore(path).load()).rejects.toMatchObject({ code: "STATE_INVALID" });
  expect(await readFile(path, "utf8")).toBe(original);
  expect(await readFile(`${path}.v1.bak`, "utf8")).toBe("existing backup");
});

function pristineV1(): WorkspaceSnapshotV1 {
  return {
    schemaVersion: 1 as const,
    activeTabId: "tab-1",
    tabs: [
      {
        id: "tab-1",
        title: "Local",
        root: { type: "pane" as const, paneId: "pane-local-1" },
        activePaneId: "pane-local-1",
      },
    ],
    panes: {
      "pane-local-1": { id: "pane-local-1", kind: "terminal" as const, title: "Local shell" },
    },
    sidebar: { visible: true, width: 28, section: "hosts" as const },
    updatedAt: "2026-07-28T00:00:00.000Z",
  };
}

function remoteV2(): WorkspaceSnapshotV2 {
  return {
    schemaVersion: 2,
    activeTabId: "remote-tab",
    tabs: [
      {
        id: "remote-tab",
        title: "Remote",
        hostId: "stable-host",
        activeSurface: "files",
        surfaces: {
          files: {
            root: { type: "pane", paneId: "remote-files" },
            activePaneId: "remote-files",
            focusedPaneId: "remote-files",
          },
          terminal: {
            root: { type: "pane", paneId: "remote-picker" },
            activePaneId: "remote-picker",
            focusedPaneId: "remote-picker",
          },
        },
      },
    ],
    panes: {
      "remote-files": {
        id: "remote-files",
        kind: "files",
        title: "Files",
        hostId: "stable-host",
        path: "/srv/project",
      },
      "remote-picker": {
        id: "remote-picker",
        kind: "session-picker",
        title: "Sessions",
        hostId: "stable-host",
      },
    },
    sidebar: { visible: true, width: 28, section: "hosts" },
    updatedAt: "2026-07-29T00:00:00.000Z",
  };
}
