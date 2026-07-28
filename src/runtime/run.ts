import { createCliRenderer } from "@opentui/core";
import { join } from "node:path";
import { resolvePathsFromProcess } from "../config/paths.js";
import { ConfigStore } from "../config/store.js";
import { DomainPermissionGate } from "../document/domain-permission.js";
import { ResourceCache } from "../document/resource-cache.js";
import { ResourceLoader } from "../document/resource-loader.js";
import { I18n, resolveLocale } from "../i18n/i18n.js";
import { selectMediaAdapter } from "../media/capabilities.js";
import { MediaDecoder } from "../media/decoder.js";
import { FormulaRenderer } from "../media/formula-renderer.js";
import { SvgRasterizer } from "../media/svg-rasterizer.js";
import { RcloneSftpService } from "../sftp/rclone-sftp.js";
import { SshClient } from "../ssh/client.js";
import { TmuxService } from "../tmux/tmux-service.js";
import { DefaultPaneViewFactory } from "../ui/pane-factory.js";
import type { RichDocumentServices } from "../ui/rich-document-renderable.js";
import { WorkspaceApp } from "../ui/workspace-app.js";
import { WorkspaceController } from "../workspace/controller.js";
import { WorkspaceStore } from "../workspace/store.js";

export async function runTermLoom(args: readonly string[]): Promise<void> {
  if (args.includes("--version") || args.includes("-V")) {
    console.log("TermLoom 0.1.0");
    return;
  }

  if (args.includes("--help") || args.includes("-h")) {
    console.log(
      [
        "TermLoom 0.1.0",
        "",
        "Usage: termloom [options]",
        "",
        "Options:",
        "  -h, --help       Show this help",
        "  -V, --version    Show the version",
      ].join("\n"),
    );
    return;
  }

  const paths = resolvePathsFromProcess();
  const configStore = new ConfigStore(paths.configFile);
  const config = await configStore.load();
  const workspaceStore = new WorkspaceStore(paths.stateFile);
  const workspace = await workspaceStore.load(config.ui.sidebarWidth);
  const i18n = new I18n(resolveLocale(config.ui.locale));
  const ssh = await SshClient.create(config, { controlDirectory: paths.controlDirectory });
  const tmux = new TmuxService(ssh);

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
  const controller = new WorkspaceController(workspace, workspaceStore);
  const sftp = Bun.which("rclone") ? new RcloneSftpService(ssh) : undefined;
  let preview: RichDocumentServices | undefined;
  let previewError: unknown;
  try {
    if (!sftp) throw new Error("rclone was not found");
    const cache = new ResourceCache(
      join(paths.cacheDirectory, "resources"),
      config.media.maxCacheBytes,
    );
    const permissions = new DomainPermissionGate({
      persistedDomains: config.permissions.allowedHttpDomains,
      persist: async (domains) => {
        config.permissions.allowedHttpDomains = [...domains];
        await configStore.save(config);
      },
    });
    const rasterizer = new SvgRasterizer({ cache });
    preview = {
      loader: new ResourceLoader({ remote: sftp, cache, permissions }),
      permissions,
      decoder: new MediaDecoder(),
      rasterizer,
      formula: new FormulaRenderer({ cache, rasterizer }),
      adapter: selectMediaAdapter(config.media.adapter, undefined, renderer.capabilities),
      output: process.stdout,
      videoFramesPerSecond: config.media.videoFps,
      autoplayGif: config.media.autoplayGif,
    };
  } catch (error) {
    previewError = error;
  }
  new WorkspaceApp(
    renderer,
    config,
    i18n,
    controller,
    new DefaultPaneViewFactory(
      renderer,
      i18n,
      { ssh, tmux, reconnect: config.reconnect, sftp, preview, previewError },
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
              hostId: filesPane.hostId,
              path: entry.path,
              scrollOffset: 0,
            },
          }),
      },
    ),
  );

  await destroyed;
  await controller.flush();
}
