import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    expect(defaults.ui.locale).toBe("auto");
    defaults.ui.locale = "zh-CN";
    defaults.hosts.push({ id: "demo", alias: "demo-host", defaultPath: "." });
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
});
