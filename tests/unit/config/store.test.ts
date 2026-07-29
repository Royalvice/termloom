import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore } from "../../../src/config/store.js";

let directory: string | undefined;
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("ConfigStore", () => {
  test("uses defaults when absent and round-trips TOML atomically", async () => {
    directory = await mkdtemp(join(tmpdir(), "termloom-config-"));
    const path = join(directory, "nested", "config.toml");
    const store = new ConfigStore(path);
    const defaults = await store.load();
    expect(defaults.schemaVersion).toBe(2);
    expect(defaults.ui.locale).toBe("auto");
    expect(defaults.ui.leader).toBe("ctrl+g");
    expect(defaults.ui.quickSwitch).toBe("f2");
    defaults.ui.locale = "zh-CN";
    defaults.hosts.push({
      id: "demo",
      alias: "demo-host",
      defaultPath: ".",
      hidden: false,
      source: "manual",
    });
    await store.save(defaults);
    expect((await readFile(path, "utf8")).includes("password")).toBe(false);
    expect(await store.load()).toEqual(defaults);
  });

  test("does not silently reset corrupted TOML", async () => {
    directory = await mkdtemp(join(tmpdir(), "termloom-config-"));
    const path = join(directory, "config.toml");
    await writeFile(path, "not = [valid", "utf8");
    const store = new ConfigStore(path);
    await expect(store.load()).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(await readFile(path, "utf8")).toBe("not = [valid");
  });

  test("migrates v1 atomically, preserves a private backup, and replaces the old default leader", async () => {
    directory = await mkdtemp(join(tmpdir(), "termloom-config-"));
    const path = join(directory, "config.toml");
    const original = `schemaVersion = 1\n\n[ui]\nlocale = "zh-CN"\ntheme = "dark"\nsidebarWidth = 32\nleader = "ctrl+space"\n`;
    await writeFile(path, original, { encoding: "utf8", mode: 0o600 });

    const migrated = await new ConfigStore(path).load();

    expect(migrated).toMatchObject({
      schemaVersion: 2,
      ui: { locale: "zh-CN", theme: "dark", sidebarWidth: 32, leader: "ctrl+g", quickSwitch: "f2" },
    });
    expect(await readFile(`${path}.v1.bak`, "utf8")).toBe(original);
    expect((await stat(`${path}.v1.bak`)).mode & 0o777).toBe(0o600);
    expect(await new ConfigStore(path).load()).toEqual(migrated);
  });

  test("keeps a custom v1 leader and all host metadata", async () => {
    directory = await mkdtemp(join(tmpdir(), "termloom-config-"));
    const path = join(directory, "config.toml");
    await writeFile(
      path,
      `schemaVersion = 1\n\n[ui]\nleader = "ctrl+a"\n\n[[hosts]]\nid = "stable-id"\nalias = "edge"\nlabel = "Edge"\ndefaultPath = "/srv/work"\ndefaultTmuxSession = "main"\n`,
      "utf8",
    );

    const migrated = await new ConfigStore(path).load();

    expect(migrated.ui.leader).toBe("ctrl+a");
    expect(migrated.hosts).toEqual([
      {
        id: "stable-id",
        alias: "edge",
        label: "Edge",
        defaultPath: "/srv/work",
        defaultTmuxSession: "main",
        hidden: false,
        source: "manual",
      },
    ]);
  });

  test("does not modify an invalid v1 file or create a migration backup", async () => {
    directory = await mkdtemp(join(tmpdir(), "termloom-config-"));
    const path = join(directory, "config.toml");
    const original = `schemaVersion = 1\nunknown = true\n`;
    await writeFile(path, original, "utf8");

    await expect(new ConfigStore(path).load()).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(await readFile(path, "utf8")).toBe(original);
    await expect(readFile(`${path}.v1.bak`, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
