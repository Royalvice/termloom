import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PtyBackend } from "../../src/terminal/pty-backend.js";
import { WorkspaceSnapshotSchema } from "../../src/workspace/schema.js";

test("boots the real OpenTUI workspace, persists a split, and tears down cleanly", async () => {
  const directory = await mkdtemp(join(tmpdir(), "termloom-runtime-"));
  const configHome = join(directory, "config");
  const stateHome = join(directory, "state");
  const cacheHome = join(directory, "cache");
  const stateFile = join(stateHome, "termloom", "workspaces.json");
  const bun = Bun.which("bun");
  if (!bun) throw new Error("Missing runtime integration dependency: bun");

  const backend = PtyBackend.spawn(bun, ["run", "src/index.ts"], {
    cwd: process.cwd(),
    cols: 100,
    rows: 30,
    env: {
      HOME: directory,
      XDG_CONFIG_HOME: configHome,
      XDG_STATE_HOME: stateHome,
      XDG_CACHE_HOME: cacheHome,
      LANG: "en_US.UTF-8",
    },
  });
  let output = "";
  const dataSubscription = backend.onData((data) => {
    output += data;
  });

  try {
    await waitUntil(() => output.includes("TermLoom"), "TermLoom frame");
    backend.write("\u0000");
    await Bun.sleep(30);
    backend.write("s");
    await waitUntil(async () => {
      try {
        const snapshot = WorkspaceSnapshotSchema.parse(
          JSON.parse(await readFile(stateFile, "utf8")),
        );
        return Object.keys(snapshot.panes).length === 2 && snapshot.tabs[0]?.root.type === "split";
      } catch {
        return false;
      }
    }, "persisted split state");

    backend.write("\u0011");
    await waitUntil(() => backend.closed, "TermLoom process exit");

    const persisted = WorkspaceSnapshotSchema.parse(JSON.parse(await readFile(stateFile, "utf8")));
    expect(Object.keys(persisted.panes)).toHaveLength(2);
    expect(persisted.tabs[0]?.root.type).toBe("split");
    expect(output).toContain("\u001b[?1049h");
    expect(output).toContain("\u001b[?1049l");
  } finally {
    dataSubscription.dispose();
    backend.kill();
    await rm(directory, { recursive: true, force: true });
  }
}, 10_000);

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  description: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(20);
  }
  throw new Error(`Timed out waiting for ${description}`);
}
