import { expect, test } from "bun:test";
import { join } from "node:path";
import { createTestRenderer } from "@opentui/core/testing";
import { defaultConfig } from "../../src/config/schema.js";
import { I18n } from "../../src/i18n/i18n.js";
import { SshClient } from "../../src/ssh/client.js";
import { HostConnectionCoordinator } from "../../src/ssh/connection-coordinator.js";
import { HostCatalog } from "../../src/ssh/host-catalog.js";
import { OpenSshResolver } from "../../src/ssh/resolver.js";
import { TmuxService } from "../../src/tmux/tmux-service.js";
import { DefaultPaneViewFactory } from "../../src/ui/pane-factory.js";
import { WorkspaceApp } from "../../src/ui/workspace-app.js";
import { WorkspaceController } from "../../src/workspace/controller.js";
import { createDefaultWorkspace, createHostWorkspaceTab } from "../../src/workspace/schema.js";
import { WorkspaceStore } from "../../src/workspace/store.js";
import { SshdFixture } from "../helpers/sshd-fixture.js";

test("restores a persisted remote tmux pane and attaches again after application restart", async () => {
  const fixture = await SshdFixture.create();
  let client: SshClient | undefined;
  let tmux: TmuxService | undefined;
  try {
    const clientConfig = await fixture.createClientConfig({ strictHostKeyChecking: "yes" });
    const config = defaultConfig();
    config.hosts = [
      {
        id: "fixture",
        alias: fixture.alias,
        defaultPath: ".",
        defaultTmuxSession: "restore",
      },
    ];
    config.ssh.connectTimeoutSeconds = 5;
    client = await SshClient.create(config, {
      resolver: new OpenSshResolver({
        binary: fixture.sshBinary,
        configFile: clientConfig,
        timeoutMs: 5_000,
      }),
      controlDirectory: fixture.controlDirectory,
    });
    await client.resolveHost("fixture");
    const master = client.spawnMaster("fixture");
    await waitUntil(() => master.closed);
    const catalog = await HostCatalog.create(config, {
      rootConfigPath: join(fixture.root, "missing-ssh-config"),
    });
    const connections = new HostConnectionCoordinator(client, catalog);
    tmux = new TmuxService(client, {
      socketName: `termloom-restore-${process.pid}-${crypto.randomUUID()}`,
      connections,
    });
    await tmux.create("fixture", "restore");

    const stateFile = join(fixture.root, "workspaces.json");
    const store = new WorkspaceStore(stateFile);
    const snapshot = createDefaultWorkspace();
    const remote = createHostWorkspaceTab({
      tabId: "tab-remote",
      hostId: "fixture",
      title: "Remote",
      defaultPath: ".",
    });
    remote.tab.activeSurface = "terminal";
    remote.tab.surfaces.terminal = {
      root: { type: "pane", paneId: "pane-remote" },
      activePaneId: "pane-remote",
      focusedPaneId: "pane-remote",
    };
    snapshot.tabs[0] = remote.tab;
    snapshot.activeTabId = "tab-remote";
    const filesPane = remote.panes[0];
    if (!filesPane) throw new Error("Expected remote Files pane");
    snapshot.panes = {
      [filesPane.id]: filesPane,
      "pane-remote": {
        id: "pane-remote",
        kind: "terminal",
        title: "fixture / restore",
        hostId: "fixture",
        tmuxSession: "restore",
        cwd: ".",
      },
    };
    await store.save(snapshot);

    for (let boot = 0; boot < 2; boot += 1) {
      const loaded = await store.load();
      expect(loaded.activeTabId).toBe("tab-remote");
      expect(loaded.panes["pane-remote"]).toMatchObject({
        hostId: "fixture",
        tmuxSession: "restore",
      });
      const setup = await createTestRenderer({ width: 100, height: 30 });
      const controller = new WorkspaceController(loaded, store);
      const app = new WorkspaceApp(
        setup.renderer,
        config,
        new I18n("en"),
        controller,
        new DefaultPaneViewFactory(setup.renderer, new I18n("en"), {
          ssh: client,
          tmux,
          reconnect: config.reconnect,
          connections,
        }),
        {
          catalog,
          connections,
          sessions: tmux,
        },
      );
      try {
        await waitUntil(async () => {
          await setup.renderOnce();
          return setup.captureCharFrame().includes("restore");
        });
        expect(setup.captureCharFrame()).toContain("restore");
      } finally {
        app.destroy();
        setup.renderer.destroy();
      }
      expect(await tmux.exists("fixture", "restore")).toBe(true);
    }
  } finally {
    if (tmux) await tmux.kill("fixture", "restore").catch(() => undefined);
    if (client) await client.stopMaster("fixture").catch(() => undefined);
    await fixture.dispose();
  }
}, 15_000);

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(20);
  }
  throw new Error("Timed out waiting for remote workspace fixture");
}
