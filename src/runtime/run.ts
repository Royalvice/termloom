import { join } from "node:path";
import { createCliRenderer } from "@opentui/core";
import { resolvePathsFromProcess } from "../config/paths.js";
import { ConfigStore } from "../config/store.js";
import { formatDoctorReport, runDoctor } from "../doctor/doctor.js";
import { DomainPermissionGate } from "../document/domain-permission.js";
import { ResourceCache } from "../document/resource-cache.js";
import { ResourceLoader } from "../document/resource-loader.js";
import { FileProviderRouter } from "../files/file-provider-router.js";
import { LocalFileProvider } from "../files/local-file-provider.js";
import { I18n, resolveLocale } from "../i18n/i18n.js";
import { selectMediaAdapter, waitForTerminalCapabilities } from "../media/capabilities.js";
import { MediaDecoder } from "../media/decoder.js";
import { FormulaRenderer } from "../media/formula-renderer.js";
import { SvgRasterizer } from "../media/svg-rasterizer.js";
import { RcloneSftpService } from "../sftp/rclone-sftp.js";
import { SshClient } from "../ssh/client.js";
import { HostConnectionCoordinator } from "../ssh/connection-coordinator.js";
import { HostCatalog, HostCatalogMonitor } from "../ssh/host-catalog.js";
import { TmuxService } from "../tmux/tmux-service.js";
import { DefaultPaneViewFactory } from "../ui/pane-factory.js";
import type { RichDocumentServices } from "../ui/rich-document-renderable.js";
import { WorkspaceApp } from "../ui/workspace-app.js";
import { WorkspaceController } from "../workspace/controller.js";
import { WorkspaceStore } from "../workspace/store.js";

export async function runTermLoom(args: readonly string[]): Promise<number> {
  if (args[0] === "doctor") {
    const doctorArgs = new Set(args.slice(1));
    const unknown = [...doctorArgs].filter(
      (argument) => !["--json", "--no-terminal-probe", "--help", "-h"].includes(argument),
    );
    if (unknown.length > 0) throw new Error(`Unknown doctor option: ${unknown.join(", ")}`);
    if (doctorArgs.has("--help") || doctorArgs.has("-h")) {
      console.log(
        [
          "Usage: termloom doctor [options]",
          "",
          "Options:",
          "  --json                 Print the versioned JSON report",
          "  --no-terminal-probe    Use environment identity without live OpenTUI probing",
          "  -h, --help             Show doctor help",
        ].join("\n"),
      );
      return 0;
    }
    const report = await runDoctor({ probeTerminal: !doctorArgs.has("--no-terminal-probe") });
    console.log(
      doctorArgs.has("--json") ? JSON.stringify(report, null, 2) : formatDoctorReport(report),
    );
    return report.ok ? 0 : 1;
  }
  if (args.includes("--version") || args.includes("-V")) {
    console.log("TermLoom 0.2.0");
    return 0;
  }

  if (args.includes("--help") || args.includes("-h")) {
    console.log(
      [
        "TermLoom 0.2.0",
        "",
        "Usage: termloom [options]",
        "       termloom doctor [--json] [--no-terminal-probe]",
        "",
        "Options:",
        "  -h, --help       Show this help",
        "  -V, --version    Show the version",
      ].join("\n"),
    );
    return 0;
  }
  if (args.length > 0) throw new Error(`Unknown option or command: ${args.join(" ")}`);

  const paths = resolvePathsFromProcess();
  const configStore = new ConfigStore(paths.configFile);
  let config = await configStore.load();
  const workspaceStore = new WorkspaceStore(paths.stateFile);
  const workspace = await workspaceStore.load(config.ui.sidebarWidth);
  const i18n = new I18n(resolveLocale(config.ui.locale));
  const catalog = await HostCatalog.create(config);
  const ssh = await SshClient.create(config, { controlDirectory: paths.controlDirectory });
  ssh.syncHosts(catalog.snapshot().profiles);
  const connections = new HostConnectionCoordinator(ssh, catalog);
  const tmux = new TmuxService(ssh, { connections });
  const controller = new WorkspaceController(workspace, workspaceStore);

  let resolveDestroyed: (() => void) | undefined;
  const destroyed = new Promise<void>((resolve) => {
    resolveDestroyed = resolve;
  });

  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    useKittyKeyboard: null,
    useMouse: true,
    enableMouseMovement: true,
    onDestroy: () => resolveDestroyed?.(),
  });
  let monitor: HostCatalogMonitor | undefined;
  let app: WorkspaceApp | undefined;
  try {
    const terminalCapabilities = await waitForTerminalCapabilities(renderer);
    const sftp = Bun.which("rclone") ? new RcloneSftpService(ssh, { connections }) : undefined;
    const files = new FileProviderRouter(new LocalFileProvider(), sftp);
    let preview: RichDocumentServices | undefined;
    let previewError: unknown;
    let resourceCache: ResourceCache | undefined;
    let permissionGate: DomainPermissionGate | undefined;
    try {
      const cache = new ResourceCache(
        join(paths.cacheDirectory, "resources"),
        config.media.maxCacheBytes,
      );
      resourceCache = cache;
      const permissions = new DomainPermissionGate({
        persistedDomains: config.permissions.allowedHttpDomains,
        persist: async (domains) => {
          config.permissions.allowedHttpDomains = [...domains];
          await configStore.save(config);
        },
      });
      permissionGate = permissions;
      const rasterizer = new SvgRasterizer({ cache });
      preview = {
        loader: new ResourceLoader({ remote: sftp, cache, permissions }),
        permissions,
        decoder: new MediaDecoder(),
        rasterizer,
        formula: new FormulaRenderer({ cache, rasterizer }),
        adapter: selectMediaAdapter(config.media.adapter, undefined, terminalCapabilities),
        output: process.stdout,
        videoFramesPerSecond: config.media.videoFps,
        autoplayGif: config.media.autoplayGif,
      };
    } catch (error) {
      previewError = error;
    }
    const paneFactory = new DefaultPaneViewFactory(
      renderer,
      i18n,
      {
        ssh,
        tmux,
        reconnect: config.reconnect,
        files,
        preview,
        previewError,
        connections,
        hostDefaultPath: (hostId) => catalog.host(hostId).defaultPath,
        hostDefaultSession: (hostId) => catalog.host(hostId).defaultTmuxSession,
        hostProfile: (hostId) => {
          try {
            return catalog.host(hostId);
          } catch {
            return undefined;
          }
        },
      },
      {
        onPaneUpdate: (pane) => controller.dispatch({ type: "update-pane", pane }),
        onOpenPreview: (filesPane, entry) =>
          controller.dispatch({
            type: "split-pane",
            paneId: filesPane.id,
            direction: "horizontal",
            pane: {
              id: `pane-${crypto.randomUUID()}`,
              kind: "preview",
              title: entry.name,
              target: filesPane.target,
              path: entry.path,
              scrollOffset: 0,
            },
          }),
        onFocusHosts: () => app?.focusHosts(),
        onAttachSession: (pane, session, inSplit) =>
          app?.attachSession(catalog.host(pane.target.hostId), session, inSplit),
        onRawShell: (pane, inSplit) => app?.openRawShell(catalog.host(pane.target.hostId), inSplit),
        onDirectSsh: (pane) => app?.openDirectSsh(pane),
        onSelectTmux: (pane) => app?.selectTmux(pane),
        onTerminalPath: (pane, path) => app?.navigateTerminalPath(pane, path),
        onContextMenu: (request, restoreFocus) => app?.openContextMenu(request, restoreFocus),
      },
    );
    app = new WorkspaceApp(renderer, config, i18n, controller, paneFactory, {
      catalog,
      files,
      connections,
      transferQueue: sftp?.queue,
      saveConfig: async (next) => {
        await configStore.save(next);
        config = structuredClone(next);
        ssh.updateConfig(config);
        return structuredClone(config);
      },
      onCatalogChange: (snapshot) => ssh.syncHosts(snapshot.profiles),
      onRendererFocus: (hostId) => {
        void monitor?.refresh();
        if (hostId) void connections.ensureConnected(hostId).catch(() => undefined);
      },
      applyRuntimeConfig: async (_previous, next) => {
        resourceCache?.updateMaxBytes(next.media.maxCacheBytes);
        permissionGate?.replacePersistedDomains(next.permissions.allowedHttpDomains);
        if (preview) {
          preview.adapter = selectMediaAdapter(next.media.adapter, undefined, terminalCapabilities);
          preview.videoFramesPerSecond = next.media.videoFps;
          preview.autoplayGif = next.media.autoplayGif;
          return { preview };
        }
      },
    });
    monitor = new HostCatalogMonitor(catalog, {
      config: () => config,
      onRefresh: (snapshot) => {
        ssh.syncHosts(snapshot.profiles);
        app?.refreshHostTree();
      },
    });

    await destroyed;
  } finally {
    monitor?.dispose();
    app?.destroy();
    if (!renderer.isDestroyed) renderer.destroy();
    await controller.flush();
  }
  return 0;
}
