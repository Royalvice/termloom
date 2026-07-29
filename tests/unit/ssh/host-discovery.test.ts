import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../../../src/config/schema.js";
import {
  buildHostCatalog,
  HostCatalog,
  HostCatalogMonitor,
  stableHostId,
} from "../../../src/ssh/host-catalog.js";
import { discoverSshHosts, isLiteralAlias } from "../../../src/ssh/host-discovery.js";

let directory: string | undefined;
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("SSH host discovery", () => {
  test("returns an empty, non-error result when the root config is absent", async () => {
    directory = await mkdtemp(join(tmpdir(), "termloom-discovery-"));
    const result = await discoverSshHosts({
      rootConfigPath: join(directory, ".ssh", "config"),
      homeDirectory: directory,
    });
    expect(result).toMatchObject({ rootExists: false, files: [], hosts: [], errors: [] });
  });

  test("reports a root SSH config directory as an explicit read error", async () => {
    directory = await mkdtemp(join(tmpdir(), "termloom-discovery-"));
    const rootConfigPath = join(directory, ".ssh", "config");
    await mkdir(rootConfigPath, { recursive: true });

    const result = await discoverSshHosts({ rootConfigPath, homeDirectory: directory });

    expect(result).toMatchObject({ rootExists: true, files: [], hosts: [] });
    expect(result.errors).toEqual([
      {
        path: rootConfigPath,
        kind: "read",
        message: expect.stringContaining("not a regular file"),
      },
    ]);
  });

  test("expands nested relative, tilde, and glob Includes in deterministic order", async () => {
    directory = await mkdtemp(join(tmpdir(), "termloom-discovery-"));
    const sshDirectory = join(directory, ".ssh");
    await mkdir(join(sshDirectory, "conf.d", "nested"), { recursive: true });
    await writeFile(
      join(sshDirectory, "config"),
      `Host root-a root-b *.ignored !blocked\n  User demo\nInclude conf.d/*.conf\nInclude ~/.ssh/extra\n`,
    );
    await writeFile(
      join(sshDirectory, "conf.d", "10-first.conf"),
      `Host first ROOT-A\nInclude conf.d/nested/*.conf\n`,
    );
    await writeFile(join(sshDirectory, "conf.d", "20-second.conf"), "Host second\n");
    await writeFile(join(sshDirectory, "conf.d", "nested", "one.conf"), "Host nested\n");
    await writeFile(join(sshDirectory, "extra"), "Host extra\n");

    const result = await discoverSshHosts({
      rootConfigPath: join(sshDirectory, "config"),
      homeDirectory: directory,
    });

    expect(result.errors).toEqual([]);
    expect(result.hosts.map((host) => host.alias)).toEqual([
      "root-a",
      "root-b",
      "first",
      "nested",
      "second",
      "extra",
    ]);
    expect(result.files).toHaveLength(5);
  });

  test("deduplicates realpaths and protects against Include cycles", async () => {
    directory = await mkdtemp(join(tmpdir(), "termloom-discovery-"));
    const sshDirectory = join(directory, ".ssh");
    await mkdir(sshDirectory, { recursive: true });
    await writeFile(join(sshDirectory, "config"), "Host root\nInclude loop.conf alias.conf\n");
    await writeFile(join(sshDirectory, "loop.conf"), "Host loop\nInclude config\n");
    await symlink(join(sshDirectory, "loop.conf"), join(sshDirectory, "alias.conf"));

    const result = await discoverSshHosts({
      rootConfigPath: join(sshDirectory, "config"),
      homeDirectory: directory,
    });

    expect(result.errors).toEqual([]);
    expect(result.hosts.map((host) => host.alias)).toEqual(["root", "loop"]);
    expect(result.files).toHaveLength(2);
  });

  test("reports unmatched Includes without discarding usable Hosts", async () => {
    directory = await mkdtemp(join(tmpdir(), "termloom-discovery-"));
    const sshDirectory = join(directory, ".ssh");
    await mkdir(sshDirectory, { recursive: true });
    await writeFile(join(sshDirectory, "config"), "Host usable\nInclude missing/*.conf\n");

    const result = await discoverSshHosts({
      rootConfigPath: join(sshDirectory, "config"),
      homeDirectory: directory,
    });

    expect(result.hosts.map((host) => host.alias)).toEqual(["usable"]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ kind: "include" });
  });

  test("distinguishes literal aliases from wildcard and negated patterns", () => {
    expect(isLiteralAlias("edge-01")).toBe(true);
    expect(isLiteralAlias("*.example")).toBe(false);
    expect(isLiteralAlias("host?")).toBe(false);
    expect(isLiteralAlias("node[12]")).toBe(false);
    expect(isLiteralAlias("!blocked")).toBe(false);
    expect(isLiteralAlias("two words")).toBe(false);
  });
});

describe("Host catalog", () => {
  test("merges discovered Hosts with stable IDs and existing metadata", () => {
    const config = defaultConfig();
    config.hosts.push({
      id: "preserved-id",
      alias: "EDGE",
      label: "Production edge",
      defaultPath: "/srv/app",
      defaultTmuxSession: "work",
      hidden: true,
      source: "discovered",
    });
    config.hosts.push({
      id: "manual-id",
      alias: "dynamic-name",
      defaultPath: ".",
      source: "manual",
    });
    config.hosts.push({
      id: "missing-id",
      alias: "removed-from-config",
      defaultPath: ".",
      source: "discovered",
    });

    const catalog = buildHostCatalog(config, {
      rootConfigPath: "/fixture/.ssh/config",
      rootExists: true,
      files: ["/fixture/.ssh/config"],
      errors: [],
      hosts: [
        { alias: "edge", sourcePath: "/fixture/.ssh/config" },
        { alias: "fresh", sourcePath: "/fixture/.ssh/config" },
      ],
    });

    expect(catalog.profiles).toEqual([
      {
        id: "preserved-id",
        alias: "edge",
        label: "Production edge",
        defaultPath: "/srv/app",
        defaultTmuxSession: "work",
        source: "ssh-config",
        sourcePath: "/fixture/.ssh/config",
        hidden: true,
        resolutionStatus: "idle",
        connectionStatus: "idle",
      },
      {
        id: stableHostId("fresh"),
        alias: "fresh",
        label: "fresh",
        defaultPath: ".",
        source: "ssh-config",
        sourcePath: "/fixture/.ssh/config",
        hidden: false,
        resolutionStatus: "idle",
        connectionStatus: "idle",
      },
      {
        id: "manual-id",
        alias: "dynamic-name",
        label: "dynamic-name",
        defaultPath: ".",
        source: "manual",
        hidden: false,
        resolutionStatus: "idle",
        connectionStatus: "idle",
      },
      {
        id: "missing-id",
        alias: "removed-from-config",
        label: "removed-from-config",
        defaultPath: ".",
        source: "missing",
        hidden: false,
        resolutionStatus: "idle",
        connectionStatus: "idle",
      },
    ]);
  });

  test("stable IDs are case-insensitive and alias-specific", () => {
    expect(stableHostId("EDGE")).toBe(stableHostId("edge"));
    expect(stableHostId("edge")).not.toBe(stableHostId("other"));
  });

  test("preserves runtime state for the same alias and resets it after an ID is remapped", async () => {
    directory = await mkdtemp(join(tmpdir(), "termloom-discovery-"));
    const sshDirectory = join(directory, ".ssh");
    await mkdir(sshDirectory, { recursive: true });
    const root = join(sshDirectory, "config");
    await writeFile(root, "Host alpha\n");
    const config = defaultConfig();
    config.hosts.push({
      id: "preserved-id",
      alias: "alpha",
      defaultPath: ".",
      source: "discovered",
    });
    const catalog = await HostCatalog.create(config, {
      rootConfigPath: root,
      homeDirectory: directory,
    });
    catalog.updateRuntimeState("preserved-id", {
      resolutionStatus: "resolved",
      connectionStatus: "connected",
    });

    const unchanged = await catalog.refresh(config);
    expect(unchanged.profiles[0]).toMatchObject({
      alias: "alpha",
      resolutionStatus: "resolved",
      connectionStatus: "connected",
    });

    await writeFile(root, "Host beta\n");
    const remappedConfig = structuredClone(config);
    const metadata = remappedConfig.hosts[0];
    if (!metadata) throw new Error("Expected Host metadata");
    metadata.alias = "beta";
    const remapped = await catalog.refresh(remappedConfig);

    expect(remapped.profiles[0]).toMatchObject({
      id: "preserved-id",
      alias: "beta",
      resolutionStatus: "idle",
      connectionStatus: "idle",
    });
    expect(remapped.profiles[0]?.error).toBeUndefined();
  });

  test("watches the root and Include directories and refreshes after a debounce", async () => {
    directory = await mkdtemp(join(tmpdir(), "termloom-discovery-"));
    const sshDirectory = join(directory, ".ssh");
    await mkdir(join(sshDirectory, "conf.d"), { recursive: true });
    const root = join(sshDirectory, "config");
    await writeFile(root, "Include conf.d/*.conf\nHost initial\n");
    await writeFile(join(sshDirectory, "conf.d", "one.conf"), "Host included\n");
    const config = defaultConfig();
    const catalog = await HostCatalog.create(config, {
      rootConfigPath: root,
      homeDirectory: directory,
    });
    let latest = catalog.snapshot();
    const monitor = new HostCatalogMonitor(catalog, {
      debounceMs: 10,
      config: () => config,
      onRefresh: (snapshot) => {
        latest = snapshot;
      },
    });
    try {
      await Bun.sleep(25);
      await writeFile(join(sshDirectory, "conf.d", "two.conf"), "Host added\n");
      await waitUntil(() => latest.profiles.some((profile) => profile.alias === "added"));
      expect(latest.profiles.map((profile) => profile.alias)).toEqual([
        "included",
        "added",
        "initial",
      ]);
    } finally {
      monitor.dispose();
    }
  });
});

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error("Timed out waiting for Host catalog refresh");
}
