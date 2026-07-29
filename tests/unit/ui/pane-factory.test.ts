import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockMouse, createTestRenderer } from "@opentui/core/testing";
import { defaultConfig } from "../../../src/config/schema.js";
import { I18n } from "../../../src/i18n/i18n.js";
import { FileProviderRouter } from "../../../src/files/file-provider-router.js";
import { LocalFileProvider } from "../../../src/files/local-file-provider.js";
import { SshClient } from "../../../src/ssh/client.js";
import type { HostConnectionCoordinator } from "../../../src/ssh/connection-coordinator.js";
import { type EffectiveSshConfig, OpenSshResolver } from "../../../src/ssh/resolver.js";
import { DefaultPaneViewFactory } from "../../../src/ui/pane-factory.js";
import { MissingHostRenderable } from "../../../src/ui/missing-host-renderable.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  for (const root of temporaryRoots.splice(0).reverse()) {
    await rm(root, { recursive: true, force: true });
  }
});

class CountingResolver extends OpenSshResolver {
  public calls = 0;

  public override async resolve(): Promise<EffectiveSshConfig> {
    this.calls += 1;
    throw new Error("Missing Host panes must not resolve SSH");
  }
}

describe("DefaultPaneViewFactory", () => {
  test("renders a missing-alias recovery pane without resolving or connecting", async () => {
    const root = await mkdtemp(join(tmpdir(), "termloom-pane-factory-"));
    temporaryRoots.push(root);
    const config = defaultConfig();
    config.hosts = [
      {
        id: "restored-host",
        alias: "retired-alias",
        label: "Retired host",
        defaultPath: ".",
        source: "manual",
      },
    ];
    const resolver = new CountingResolver();
    const ssh = await SshClient.create(config, {
      resolver,
      controlDirectory: join(root, "control"),
    });
    ssh.syncHosts([
      {
        id: "restored-host",
        alias: "retired-alias",
        label: "Retired host",
        defaultPath: ".",
        source: "missing",
      },
    ]);
    let connectionCalls = 0;
    const connections = {
      ensureConnected: async () => {
        connectionCalls += 1;
      },
    } as unknown as HostConnectionCoordinator;
    const setup = await createTestRenderer({ width: 70, height: 20 });
    let remapCalls = 0;
    try {
      const factory = new DefaultPaneViewFactory(
        setup.renderer,
        new I18n("en"),
        {
          ssh,
          tmux: {} as never,
          reconnect: config.reconnect,
          files: new FileProviderRouter(new LocalFileProvider()),
          connections,
          hostProfile: () => ({ alias: "retired-alias", source: "missing" }),
        },
        { onFocusHosts: () => (remapCalls += 1) },
      );
      const view = factory.create({
        id: "files-restored",
        kind: "files",
        title: "Files",
        target: { kind: "ssh", hostId: "restored-host" },
        path: ".",
      });
      expect(view).toBeInstanceOf(MissingHostRenderable);
      setup.renderer.root.add(view);
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("SSH alias missing");
      expect(resolver.calls).toBe(0);
      expect(connectionCalls).toBe(0);

      const remap = view.findDescendantById("content-files-restored-remap");
      if (!remap) throw new Error("Expected remap action");
      await createMockMouse(setup.renderer).click(remap.screenX + 2, remap.screenY);
      expect(remapCalls).toBe(1);
      expect(resolver.calls).toBe(0);
      expect(connectionCalls).toBe(0);
      view.destroyRecursively();
    } finally {
      setup.renderer.destroy();
    }
  });
});
