import { homedir } from "node:os";
import { dirname as localDirname, posix } from "node:path";
import {
  BoxRenderable,
  CliRenderEvents,
  type CliRenderer,
  type MouseEvent,
  type Renderable,
  TextAttributes,
  TextRenderable,
} from "@opentui/core";
import type { Keymap } from "@opentui/keymap";
import { registerLeader } from "@opentui/keymap/addons";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import type { TermLoomConfig } from "../config/schema.js";
import type { FileEntry, FileProvider } from "../files/file-provider.js";
import { type I18n, resolveLocale } from "../i18n/i18n.js";
import type { TransferQueue } from "../sftp/transfer-queue.js";
import type { FileProviderRouter } from "../files/file-provider-router.js";
import type { HostConnectionCoordinator } from "../ssh/connection-coordinator.js";
import type { HostCatalog, HostCatalogSnapshot, HostProfile } from "../ssh/host-catalog.js";
import type { TmuxSessionInfo } from "../tmux/tmux-service.js";
import type { WorkspaceController } from "../workspace/controller.js";
import {
  activeSurface,
  activeTab,
  collectPaneIds,
  nearestSplitForPane,
} from "../workspace/reducer.js";
import {
  createHostWorkspaceTab,
  type LayoutNode,
  type PaneState,
  type WorkspaceSnapshot,
  type WorkspaceSurfaceName,
} from "../workspace/schema.js";
import { CommandPaletteRenderable, type PaletteCommand } from "./command-palette-renderable.js";
import {
  type ContextMenuRequest,
  DismissibleOverlayController,
} from "./dismissible-overlay-controller.js";
import type { PaneViewFactory } from "./pane-factory.js";
import { PaneRegistry } from "./pane-registry.js";
import { SettingsRenderable } from "./settings-renderable.js";
import { SidebarRenderable } from "./sidebar-renderable.js";
import { SshAuthenticationRenderable } from "./ssh-authentication-renderable.js";
import { applyTheme, theme } from "./theme.js";
import type { RichDocumentServices } from "./rich-document-renderable.js";
import { TransferManagerRenderable } from "./transfer-manager-renderable.js";
import { WorkspaceContextBarRenderable } from "./workspace-context-bar-renderable.js";

export interface WorkspaceAppServices {
  catalog: HostCatalog;
  files?: FileProviderRouter;
  connections?: HostConnectionCoordinator;
  transferQueue?: TransferQueue;
  saveConfig?: (config: TermLoomConfig) => Promise<TermLoomConfig>;
  onCatalogChange?: (snapshot: HostCatalogSnapshot) => void;
  onRendererFocus?: (hostId: string | undefined) => void;
  applyRuntimeConfig?: (
    previous: TermLoomConfig,
    next: TermLoomConfig,
  ) => Promise<{ preview?: RichDocumentServices } | undefined>;
}

type WorkspaceOverlay = SettingsRenderable | TransferManagerRenderable | CommandPaletteRenderable;

export class WorkspaceApp {
  public readonly root: BoxRenderable;
  private readonly sidebar: BoxRenderable;
  private readonly sidebarView: SidebarRenderable;
  private readonly sidebarDivider: TextRenderable;
  private readonly workspaceContext: WorkspaceContextBarRenderable;
  private readonly filesSegment: TextRenderable;
  private readonly terminalSegment: TextRenderable;
  private readonly layoutHost: BoxRenderable;
  private readonly footer: TextRenderable;
  private readonly registry: PaneRegistry;
  private readonly dismissibleOverlays: DismissibleOverlayController;
  private readonly keymap: Keymap<Renderable, import("@opentui/core").KeyEvent>;
  private config: TermLoomConfig;
  private readonly services: WorkspaceAppServices;
  private layoutRoot: Renderable | undefined;
  private overlay: WorkspaceOverlay | undefined;
  private authentication: SshAuthenticationRenderable | undefined;
  private authenticationHostId: string | undefined;
  private readonly disposers: Array<() => void> = [];
  private keymapDisposers: Array<() => void> = [];
  private activeSidebarTarget = "";
  private activeDividerDrag:
    | { kind: "sidebar" }
    | {
        kind: "split";
        splitId: string;
        horizontal: boolean;
        container: BoxRenderable;
      }
    | undefined;
  private lastHeartbeatAt = Date.now();
  private pathNavigationGeneration = 0;
  private destroyed = false;

  public constructor(
    private readonly renderer: CliRenderer,
    config: TermLoomConfig,
    private readonly i18n: I18n,
    private readonly controller: WorkspaceController,
    paneFactory: PaneViewFactory,
    services: WorkspaceAppServices,
  ) {
    this.config = structuredClone(config);
    this.i18n.setLocale(resolveLocale(config.ui.locale));
    applyTheme(config.ui.theme, renderer.themeMode);
    this.services = services;
    this.keymap = createDefaultOpenTuiKeymap(this.renderer);
    this.registry = new PaneRegistry(renderer, paneFactory, (paneId) => {
      this.controller.dispatch({ type: "focus-pane", paneId });
    });
    this.root = new BoxRenderable(renderer, {
      id: "termloom-root",
      width: "100%",
      height: "100%",
      flexDirection: "column",
      backgroundColor: theme.background,
      onMouseDrag: (event) => this.handleDividerDrag(event),
      onMouseUp: () => this.finishDividerDrag(),
      onMouseDragEnd: () => this.finishDividerDrag(),
    });
    this.dismissibleOverlays = new DismissibleOverlayController(renderer, this.root);
    const header = this.createHeader();
    this.filesSegment = header.files;
    this.terminalSegment = header.terminal;
    this.root.add(header.root);

    const body = new BoxRenderable(renderer, {
      id: "body",
      flexDirection: "row",
      flexGrow: 1,
      width: "100%",
      minHeight: 1,
    });
    this.sidebar = new BoxRenderable(renderer, {
      id: "sidebar",
      width: controller.state.sidebar.width,
      height: "100%",
      backgroundColor: theme.surface,
      overflow: "hidden",
    });
    this.sidebarView = new SidebarRenderable(renderer, {
      id: "sidebar-content",
      config: this.config,
      catalog: services.catalog,
      i18n,
      saveConfig: services.saveConfig ? (next) => this.saveConfig(next) : undefined,
      hostInUse: (hostId) =>
        Object.values(this.controller.state.panes).some(
          (pane) => pane.target.kind === "ssh" && pane.target.hostId === hostId,
        ),
      onSelectLocal: () => this.selectLocal(),
      onSelectHost: (profile) => this.selectHost(profile),
      onCollapse: () => this.controller.dispatch({ type: "toggle-sidebar" }),
      onCatalogChange: (snapshot) => services.onCatalogChange?.(snapshot),
      onContextMenu: (request, restoreFocus) => this.openContextMenu(request, restoreFocus),
    });
    this.sidebar.add(this.sidebarView);
    body.add(this.sidebar);
    this.sidebarDivider = this.createSidebarDivider();
    body.add(this.sidebarDivider);

    const main = new BoxRenderable(renderer, {
      id: "main",
      flexDirection: "column",
      flexGrow: 1,
      height: "100%",
      minWidth: 1,
    });
    this.workspaceContext = new WorkspaceContextBarRenderable(renderer, {
      id: "workspace-context",
      onPrevious: () => this.activateRelativeTab(-1),
      onNext: () => this.activateRelativeTab(1),
      onAdd: () => this.openAddMenu(),
      onClose: () => this.closeActiveTab(),
    });
    main.add(this.workspaceContext);
    this.layoutHost = new BoxRenderable(renderer, {
      id: "layout-host",
      flexGrow: 1,
      width: "100%",
      minHeight: 1,
      overflow: "hidden",
    });
    main.add(this.layoutHost);
    body.add(main);
    this.root.add(body);
    this.footer = new TextRenderable(renderer, {
      id: "footer",
      height: 1,
      width: "100%",
      content: footerText(),
      fg: theme.muted,
      bg: theme.surfaceRaised,
      attributes: TextAttributes.DIM,
    });
    this.root.add(this.footer);
    renderer.root.add(this.root);

    const destroyWithRenderer = () => this.destroy();
    renderer.once(CliRenderEvents.DESTROY, destroyWithRenderer);
    this.disposers.push(() => renderer.off(CliRenderEvents.DESTROY, destroyWithRenderer));
    const rendererFocus = () => void this.handleRendererFocus();
    renderer.on(CliRenderEvents.FOCUS, rendererFocus);
    this.disposers.push(() => renderer.off(CliRenderEvents.FOCUS, rendererFocus));
    const rendererTheme = (mode: "dark" | "light") => {
      if (this.config.ui.theme !== "system") return;
      applyTheme("system", mode);
      this.refreshAppearance();
    };
    renderer.on(CliRenderEvents.THEME_MODE, rendererTheme);
    this.disposers.push(() => renderer.off(CliRenderEvents.THEME_MODE, rendererTheme));
    const heartbeat = setInterval(() => this.checkForResume(), 5_000);
    heartbeat.unref?.();
    this.disposers.push(() => clearInterval(heartbeat));
    if (services.connections) {
      this.disposers.push(
        services.connections.onChange((event) => {
          this.sidebarView.refreshDisplay();
          this.renderWorkspaceContext(this.controller.state);
          if (event.status === "authenticating" && event.authenticationBackend) {
            this.showAuthentication(event.hostId, event.authenticationBackend);
          } else if (event.status === "connected") {
            this.closeAuthentication(event.hostId);
            void this.refreshHostData(event.hostId);
          } else if (event.status === "error" && event.error) {
            this.authentication?.setError(event.error);
          }
        }),
      );
    }

    this.installKeymap();
    this.disposers.push(this.controller.onChange((state) => this.renderState(state)));
    this.renderState(controller.state);
  }

  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const dispose of this.keymapDisposers.splice(0).reverse()) dispose();
    for (const dispose of this.disposers.splice(0).reverse()) dispose();
    this.dismissibleOverlays.destroy();
    this.authentication = undefined;
    this.registry.destroy();
    this.root.destroyRecursively();
  }

  public focusHosts(): void {
    if (!this.controller.state.sidebar.visible) {
      this.controller.dispatch({ type: "toggle-sidebar" });
    }
    this.sidebarView.focus();
  }

  public refreshHostTree(): void {
    this.sidebarView.refreshDisplay();
    this.renderWorkspaceContext(this.controller.state);
  }

  public checkForResume(now = Date.now()): void {
    if (this.destroyed) return;
    if (now < this.lastHeartbeatAt) {
      this.lastHeartbeatAt = now;
      return;
    }
    const gap = now - this.lastHeartbeatAt;
    this.lastHeartbeatAt = now;
    if (gap >= 15_000) void this.handleRendererFocus();
  }

  public selectLocal(): void {
    const tab = this.ensureLocalTab();
    if (tab.activeSurface !== "files") {
      this.controller.dispatch({ type: "set-active-surface", surface: "files" });
    }
  }

  public selectHost(profile: HostProfile): void {
    if (profile.source === "missing") {
      this.footer.content = `SSH alias missing: ${profile.alias}`;
      this.footer.fg = theme.error;
      return;
    }
    const tab = this.ensureHostTab(profile);
    if (tab.activeSurface !== "files") {
      this.controller.dispatch({ type: "set-active-surface", surface: "files" });
    }
    void this.services.connections?.ensureConnected(profile.id).catch(() => undefined);
  }

  public attachSession(profile: HostProfile, session: TmuxSessionInfo, inSplit: boolean): void {
    this.ensureHostTab(profile);
    if (activeTab(this.controller.state).activeSurface !== "terminal") {
      this.controller.dispatch({ type: "set-active-surface", surface: "terminal" });
    }
    const tab = activeTab(this.controller.state);
    const surface = tab.surfaces.terminal;
    const existing = collectPaneIds(surface.root).find((paneId) => {
      const pane = this.controller.state.panes[paneId];
      return pane?.kind === "terminal" && pane.tmuxSession === session.name;
    });
    if (existing) {
      this.controller.dispatch({ type: "focus-pane", paneId: existing });
      return;
    }
    const terminal: PaneState = {
      id: inSplit ? uniqueId("pane") : surface.activePaneId,
      kind: "terminal",
      title: session.name,
      target: { kind: "ssh", hostId: profile.id },
      tmuxSession: session.name,
      cwd: profile.defaultPath,
    };
    if (inSplit) {
      this.controller.dispatch({
        type: "split-pane",
        paneId: surface.activePaneId,
        direction: "horizontal",
        pane: terminal,
      });
    } else {
      this.controller.dispatch({ type: "update-pane", pane: terminal });
    }
  }

  public openRawShell(profile: HostProfile, inSplit: boolean): void {
    this.ensureHostTab(profile);
    if (activeTab(this.controller.state).activeSurface !== "terminal") {
      this.controller.dispatch({ type: "set-active-surface", surface: "terminal" });
    }
    const surface = activeTab(this.controller.state).surfaces.terminal;
    const pane: PaneState = {
      id: inSplit ? uniqueId("pane") : surface.activePaneId,
      kind: "terminal",
      title: `${profile.label} shell`,
      target: { kind: "ssh", hostId: profile.id },
    };
    if (inSplit) {
      this.controller.dispatch({
        type: "split-pane",
        paneId: surface.activePaneId,
        direction: "horizontal",
        pane,
      });
    } else {
      this.controller.dispatch({ type: "update-pane", pane });
    }
  }

  public openDirectSsh(launcher: Extract<PaneState, { kind: "terminal-launcher" }>): void {
    const profile = this.services.catalog.host(launcher.target.hostId);
    this.controller.dispatch({
      type: "update-pane",
      pane: {
        id: launcher.id,
        kind: "terminal",
        title: `${profile.label} shell`,
        target: launcher.target,
      },
    });
  }

  public selectTmux(launcher: Extract<PaneState, { kind: "terminal-launcher" }>): void {
    this.controller.dispatch({
      type: "update-pane",
      pane: {
        id: launcher.id,
        kind: "session-picker",
        title: "Tmux sessions",
        target: launcher.target,
      },
    });
  }

  public openContextMenu(request: ContextMenuRequest, restoreFocus: () => void): void {
    if (this.overlay || this.authentication) return;
    this.dismissibleOverlays.openContextMenu(request, restoreFocus);
  }

  /**
   * Open the local or remote Files surface for a path clicked in a terminal.
   * The path must already be absolute; FileProvider.stat is the authority for
   * both existence and directory/file routing.
   */
  public async navigateTerminalPath(
    source: Extract<PaneState, { kind: "terminal" }>,
    path: string,
  ): Promise<void> {
    const generation = ++this.pathNavigationGeneration;
    const router = this.services.files;
    if (!router || !path.startsWith("/") || path.includes("\0")) {
      this.showPathUnavailable();
      return;
    }

    let provider: FileProvider;
    let entry: FileEntry;
    try {
      provider = router.forTarget(source.target);
      entry = await provider.stat(path);
    } catch {
      if (!this.destroyed && generation === this.pathNavigationGeneration)
        this.showPathUnavailable();
      return;
    }
    if (this.destroyed || generation !== this.pathNavigationGeneration) return;

    // A target may have more than one persisted workspace tab. Prefer the tab
    // that actually owns the clicked terminal; only fall back to another tab
    // for an older/restored state whose layout no longer references the pane.
    const tab =
      this.controller.state.tabs.find((candidate) => tabOwnsPane(candidate, source.id)) ??
      this.controller.state.tabs.find((candidate) => sameTarget(candidate.target, source.target));
    if (!tab) {
      this.showPathUnavailable();
      return;
    }
    if (tab.id !== this.controller.state.activeTabId) {
      this.controller.dispatch({ type: "activate-tab", tabId: tab.id });
    }
    if (activeTab(this.controller.state).activeSurface !== "files") {
      this.controller.dispatch({ type: "set-active-surface", surface: "files" });
    }

    const filesSurface = activeTab(this.controller.state).surfaces.files;
    const filesPane = [filesSurface.activePaneId, ...collectPaneIds(filesSurface.root)]
      .map((paneId) => this.controller.state.panes[paneId])
      .find((pane): pane is Extract<PaneState, { kind: "files" }> => pane?.kind === "files");
    if (!filesPane) {
      this.showPathUnavailable();
      return;
    }

    const directory = entry.isDirectory
      ? entry.path
      : provider.kind === "local"
        ? localDirname(entry.path)
        : posix.dirname(entry.path);
    const selectedPath = entry.isDirectory ? undefined : entry.path;
    const browser = this.registry.fileBrowser(filesPane.id);
    if (browser) {
      await browser.reveal(directory, selectedPath);
      return;
    }
    this.controller.dispatch({
      type: "update-pane",
      pane: {
        ...filesPane,
        path: directory,
        selectedPath,
        previewPath: selectedPath,
      },
    });
  }

  private createHeader(): {
    root: BoxRenderable;
    files: TextRenderable;
    terminal: TextRenderable;
  } {
    const header = new BoxRenderable(this.renderer, {
      id: "header",
      height: 1,
      width: "100%",
      flexDirection: "row",
      backgroundColor: theme.surfaceRaised,
    });
    header.add(
      new TextRenderable(this.renderer, {
        id: "brand",
        width: 22,
        content: ` ◈ ${this.i18n.t("app.name")} `,
        fg: theme.accent,
        attributes: TextAttributes.BOLD,
      }),
    );
    const segments = new BoxRenderable(this.renderer, {
      id: "surface-switch",
      flexGrow: 1,
      height: 1,
      flexDirection: "row",
      justifyContent: "center",
      backgroundColor: theme.surfaceRaised,
    });
    const files = this.surfaceButton("surface-files", " Files ", "files");
    const terminal = this.surfaceButton("surface-terminal", " Terminal ", "terminal");
    segments.add(files);
    segments.add(terminal);
    header.add(segments);
    header.add(
      this.actionButton("sidebar-toggle-button", ` ☰ ${this.i18n.t("sidebar.hosts")} `, () =>
        this.controller.dispatch({ type: "toggle-sidebar" }),
      ),
    );
    header.add(this.actionButton("help-button", " F1 Help ", () => this.openCommandPalette()));
    header.add(this.actionButton("settings-button", " ⚙ ", () => this.openSettings()));
    return { root: header, files, terminal };
  }

  private actionButton(id: string, label: string, run: () => void): TextRenderable {
    const button = new TextRenderable(this.renderer, {
      id,
      content: label,
      fg: theme.accent,
      bg: theme.surfaceRaised,
      onMouseDown: (event) => {
        if (event.button !== 0) return;
        run();
        consumeMouse(event);
      },
    });
    button.onMouseOver = () => {
      button.bg = theme.selection;
      this.renderer.setMousePointer("pointer");
    };
    button.onMouseOut = () => {
      button.bg = theme.surfaceRaised;
      this.renderer.setMousePointer("default");
    };
    return button;
  }

  private surfaceButton(id: string, label: string, surface: WorkspaceSurfaceName): TextRenderable {
    return new TextRenderable(this.renderer, {
      id,
      content: label,
      fg: theme.muted,
      bg: theme.surfaceRaised,
      onMouseOver: () => this.renderer.setMousePointer("pointer"),
      onMouseOut: () => this.renderer.setMousePointer("default"),
      onMouseDown: (event) => {
        if (event.button !== 0) return;
        this.switchSurface(surface);
        consumeMouse(event);
      },
    });
  }

  private createSidebarDivider(): TextRenderable {
    return new TextRenderable(this.renderer, {
      id: "sidebar-divider",
      width: 1,
      height: "100%",
      content: "│",
      fg: theme.border,
      onMouseOver: () => this.renderer.setMousePointer("move"),
      onMouseOut: () => this.renderer.setMousePointer("default"),
      onMouseDown: (event) => {
        if (event.button !== 0) return;
        this.activeDividerDrag = { kind: "sidebar" };
        consumeMouse(event);
      },
      onMouseDrag: (event) => this.handleDividerDrag(event),
      onMouseDragEnd: () => this.finishDividerDrag(),
    });
  }

  private renderState(state: WorkspaceSnapshot): void {
    this.dismissibleOverlays.dismiss({ restoreFocus: false });
    this.sidebar.visible = state.sidebar.visible;
    this.sidebarDivider.visible = state.sidebar.visible;
    this.sidebar.width = state.sidebar.width;
    const tab = activeTab(state);
    this.renderWorkspaceContext(state);
    const targetIdentity = tab.target.kind === "local" ? "local" : `ssh:${tab.target.hostId}`;
    if (targetIdentity !== this.activeSidebarTarget) {
      this.activeSidebarTarget = targetIdentity;
      this.sidebarView.syncActiveTarget(tab.target);
    }
    this.filesSegment.bg = tab.activeSurface === "files" ? theme.accent : theme.surfaceRaised;
    this.filesSegment.fg = tab.activeSurface === "files" ? theme.background : theme.muted;
    this.filesSegment.attributes =
      tab.activeSurface === "files" ? TextAttributes.BOLD : TextAttributes.NONE;
    this.terminalSegment.bg = tab.activeSurface === "terminal" ? theme.accent : theme.surfaceRaised;
    this.terminalSegment.fg = tab.activeSurface === "terminal" ? theme.background : theme.muted;
    this.terminalSegment.attributes =
      tab.activeSurface === "terminal" ? TextAttributes.BOLD : TextAttributes.NONE;
    this.registry.reconcile(state);
    this.registry.detachAll();
    if (this.layoutRoot) {
      if (this.layoutRoot.parent === this.layoutHost) this.layoutHost.remove(this.layoutRoot);
      if (!this.registry.owns(this.layoutRoot)) this.layoutRoot.destroyRecursively();
    }
    const surface = activeSurface(tab);
    this.layoutRoot = this.buildLayout(surface.root, state);
    this.layoutHost.add(this.layoutRoot);
    if (
      !this.overlay &&
      !this.authentication &&
      !this.dismissibleOverlays.isOpen &&
      !this.sidebarView.focused
    ) {
      this.registry.focus(surface.focusedPaneId ?? surface.activePaneId);
    }
    this.footer.content = footerText();
    this.footer.fg = theme.muted;
    this.renderer.requestRender();
  }

  private renderWorkspaceContext(state: WorkspaceSnapshot): void {
    const tab = activeTab(state);
    const index = Math.max(
      0,
      state.tabs.findIndex((candidate) => candidate.id === tab.id),
    );
    if (tab.target.kind === "local") {
      this.workspaceContext.setState({
        kind: "local",
        label: tab.title === "Local" ? "This Mac" : tab.title,
        status: "local",
        index,
        total: state.tabs.length,
      });
      return;
    }
    try {
      const profile = this.services.catalog.host(tab.target.hostId);
      this.workspaceContext.setState({
        kind: "ssh",
        label: profile.label,
        status: profile.connectionStatus,
        missing: profile.source === "missing",
        index,
        total: state.tabs.length,
      });
    } catch {
      this.workspaceContext.setState({
        kind: "ssh",
        label: tab.title,
        status: "error",
        missing: true,
        index,
        total: state.tabs.length,
      });
    }
  }

  private buildLayout(node: LayoutNode, state: WorkspaceSnapshot): Renderable {
    if (node.type === "pane") {
      const pane = state.panes[node.paneId];
      if (!pane) throw new Error(`Missing pane ${node.paneId}`);
      return this.registry.frame(pane);
    }
    const horizontal = node.direction === "horizontal";
    const container = new BoxRenderable(this.renderer, {
      id: `layout-${node.id}`,
      width: "100%",
      height: "100%",
      flexDirection: horizontal ? "row" : "column",
      minWidth: 1,
      minHeight: 1,
    });
    const firstHost = new BoxRenderable(this.renderer, {
      id: `layout-${node.id}-first`,
      width: horizontal ? `${node.ratio * 100}%` : "100%",
      height: horizontal ? "100%" : `${node.ratio * 100}%`,
      minWidth: 1,
      minHeight: 1,
    });
    firstHost.add(this.buildLayout(node.first, state));
    const divider = new BoxRenderable(this.renderer, {
      id: `layout-${node.id}-divider`,
      width: horizontal ? 1 : "100%",
      height: horizontal ? "100%" : 1,
      backgroundColor: theme.border,
      onMouseOver: () => this.renderer.setMousePointer("move"),
      onMouseOut: () => this.renderer.setMousePointer("default"),
      onMouseDown: (event) => {
        if (event.button !== 0) return;
        this.activeDividerDrag = {
          kind: "split",
          splitId: node.id,
          horizontal,
          container,
        };
        consumeMouse(event);
      },
      onMouseDrag: (event) => this.handleDividerDrag(event),
      onMouseDragEnd: () => this.finishDividerDrag(),
    });
    const secondHost = new BoxRenderable(this.renderer, {
      id: `layout-${node.id}-second`,
      flexGrow: 1,
      minWidth: 1,
      minHeight: 1,
    });
    secondHost.add(this.buildLayout(node.second, state));
    container.add(firstHost);
    container.add(divider);
    container.add(secondHost);
    return container;
  }

  private installKeymap(): void {
    for (const dispose of this.keymapDisposers.splice(0).reverse()) dispose();
    this.keymapDisposers.push(registerLeader(this.keymap, { trigger: this.config.ui.leader }));
    this.keymapDisposers.push(
      this.keymap.registerLayer({
        commands: [
          { name: "app.quit", run: () => this.renderer.destroy() },
          { name: "app.help", run: () => this.openCommandPalette() },
          { name: "workspace.switch-surface", run: () => this.switchSurface() },
          { name: "workspace.split-horizontal", run: () => this.split("horizontal") },
          { name: "workspace.split-vertical", run: () => this.split("vertical") },
          { name: "workspace.close-pane", run: () => this.closeActivePane() },
          { name: "workspace.next-pane", run: () => this.focusRelativePane(1) },
          { name: "workspace.previous-pane", run: () => this.focusRelativePane(-1) },
          { name: "workspace.add-local-tab", run: () => this.addLocalTab() },
          { name: "workspace.close-tab", run: () => this.closeActiveTab() },
          { name: "workspace.next-tab", run: () => this.activateRelativeTab(1) },
          { name: "workspace.previous-tab", run: () => this.activateRelativeTab(-1) },
          { name: "workspace.grow-pane", run: () => this.resizeActivePane(0.05) },
          { name: "workspace.shrink-pane", run: () => this.resizeActivePane(-0.05) },
          { name: "workspace.exchange-pane", run: () => this.exchangeActivePane() },
          { name: "app.settings", run: () => this.openSettings() },
          { name: "app.transfers", run: () => this.openTransfers() },
          {
            name: "workspace.toggle-sidebar",
            run: () => this.controller.dispatch({ type: "toggle-sidebar" }),
          },
          { name: "terminal.literal-leader", run: () => this.sendLiteralLeader() },
          { name: "terminal.literal-f2", run: () => this.sendLiteralF2() },
        ],
        bindings: [
          { key: "ctrl+q", cmd: "app.quit" },
          { key: "f1", cmd: "app.help" },
          { key: this.config.ui.quickSwitch, cmd: "workspace.switch-surface" },
          { key: "<leader>s", cmd: "workspace.split-horizontal" },
          { key: "<leader>v", cmd: "workspace.split-vertical" },
          { key: "<leader>x", cmd: "workspace.close-pane" },
          { key: "<leader>n", cmd: "workspace.next-pane" },
          { key: "<leader>p", cmd: "workspace.previous-pane" },
          { key: "<leader>a", cmd: "workspace.add-local-tab" },
          { key: "<leader>w", cmd: "workspace.close-tab" },
          { key: "<leader>.", cmd: "workspace.next-tab" },
          { key: "<leader>,", cmd: "workspace.previous-tab" },
          { key: "<leader>]", cmd: "workspace.grow-pane" },
          { key: "<leader>[", cmd: "workspace.shrink-pane" },
          { key: "<leader>e", cmd: "workspace.exchange-pane" },
          { key: "<leader>g", cmd: "app.settings" },
          { key: "<leader>t", cmd: "app.transfers" },
          { key: "<leader>b", cmd: "workspace.toggle-sidebar" },
          { key: "<leader><leader>", cmd: "terminal.literal-leader" },
          { key: "<leader>f2", cmd: "terminal.literal-f2" },
        ],
      }),
    );
  }

  private handleDividerDrag(event: MouseEvent): void {
    const drag = this.activeDividerDrag;
    if (!drag) return;
    if (drag.kind === "sidebar") {
      const width = event.x - this.sidebar.x;
      this.controller.dispatch({ type: "set-sidebar-width", width });
    } else {
      const ratio = drag.horizontal
        ? (event.x - drag.container.x) / Math.max(1, drag.container.width)
        : (event.y - drag.container.y) / Math.max(1, drag.container.height);
      this.controller.dispatch({ type: "resize-split", splitId: drag.splitId, ratio });
    }
    consumeMouse(event);
  }

  private finishDividerDrag(): void {
    this.activeDividerDrag = undefined;
  }

  private switchSurface(surface?: WorkspaceSurfaceName): void {
    if (this.overlay || this.authentication) return;
    const tab = activeTab(this.controller.state);
    const next = surface ?? (tab.activeSurface === "files" ? "terminal" : "files");
    if (next !== tab.activeSurface) {
      this.controller.dispatch({ type: "set-active-surface", surface: next });
    }
  }

  private split(direction: "horizontal" | "vertical"): void {
    if (this.overlay || this.authentication) return;
    const surface = activeSurface(activeTab(this.controller.state));
    const source = this.controller.state.panes[surface.activePaneId];
    if (!source) return;
    this.controller.dispatch({
      type: "split-pane",
      paneId: source.id,
      direction,
      pane: this.newSiblingPane(source),
    });
  }

  private newSiblingPane(source: PaneState): PaneState {
    const id = uniqueId("pane");
    switch (source.kind) {
      case "terminal":
        return {
          ...source,
          id,
          title: source.target.kind === "ssh" ? `${source.target.hostId} shell` : "Local shell",
        };
      case "files":
        return { ...source, id, title: "Files" };
      case "preview":
        return { ...source, id, title: "Preview" };
      case "start":
        return { ...source, id };
      case "session-picker":
        return { ...source, id };
      case "terminal-launcher":
        return { ...source, id };
    }
  }

  private closeActivePane(): void {
    if (this.overlay || this.authentication) return;
    const surface = activeSurface(activeTab(this.controller.state));
    if (collectPaneIds(surface.root).length <= 1) return;
    this.controller.dispatch({ type: "close-pane", paneId: surface.activePaneId });
  }

  private focusRelativePane(offset: number): void {
    if (this.overlay || this.authentication) return;
    const surface = activeSurface(activeTab(this.controller.state));
    const panes = collectPaneIds(surface.root);
    const current = panes.indexOf(surface.activePaneId);
    const paneId = panes[(current + offset + panes.length) % panes.length];
    if (paneId) this.controller.dispatch({ type: "focus-pane", paneId });
  }

  private sendLiteralLeader(): void {
    if (this.overlay || this.authentication) return;
    const surface = activeSurface(activeTab(this.controller.state));
    this.registry
      .terminal(surface.activePaneId)
      ?.sendInput(controlCharacter(this.config.ui.leader));
  }

  private sendLiteralF2(): void {
    if (this.overlay || this.authentication) return;
    const surface = activeSurface(activeTab(this.controller.state));
    this.registry.terminal(surface.activePaneId)?.sendInput("\u001bOQ");
  }

  private addLocalTab(): void {
    if (this.overlay || this.authentication) return;
    this.ensureLocalTab(true);
  }

  private ensureLocalTab(forceNew = false) {
    const existing = forceNew
      ? undefined
      : this.controller.state.tabs.find((tab) => tab.target.kind === "local");
    if (existing) {
      if (existing.id !== this.controller.state.activeTabId) {
        this.controller.dispatch({ type: "activate-tab", tabId: existing.id });
      }
      return activeTab(this.controller.state);
    }
    const terminalId = uniqueId("pane");
    const filesId = uniqueId("pane");
    const tabId = uniqueId("tab");
    const target = { kind: "local" } as const;
    this.controller.dispatch({
      type: "add-tab",
      tab: {
        id: tabId,
        title: "Local",
        target,
        activeSurface: "files",
        surfaces: {
          files: {
            root: { type: "pane", paneId: filesId },
            activePaneId: filesId,
            focusedPaneId: filesId,
          },
          terminal: {
            root: { type: "pane", paneId: terminalId },
            activePaneId: terminalId,
            focusedPaneId: terminalId,
          },
        },
      },
      panes: [
        {
          id: filesId,
          kind: "files",
          title: "Files",
          target,
          path: homedir(),
        },
        {
          id: terminalId,
          kind: "terminal",
          title: "Local shell",
          target,
          cwd: homedir(),
        },
      ],
    });
    return activeTab(this.controller.state);
  }

  private ensureHostTab(profile: HostProfile) {
    const existing = this.controller.state.tabs.find(
      (tab) => tab.target.kind === "ssh" && tab.target.hostId === profile.id,
    );
    if (existing) {
      if (existing.id !== this.controller.state.activeTabId) {
        this.controller.dispatch({ type: "activate-tab", tabId: existing.id });
      }
      return activeTab(this.controller.state);
    }
    const created = createHostWorkspaceTab({
      tabId: uniqueId("tab"),
      hostId: profile.id,
      title: profile.label,
      defaultPath: profile.defaultPath,
    });
    this.controller.dispatch({ type: "add-tab", tab: created.tab, panes: created.panes });
    return activeTab(this.controller.state);
  }

  private closeActiveTab(): void {
    if (this.overlay || this.authentication || this.controller.state.tabs.length <= 1) return;
    this.controller.dispatch({ type: "close-tab", tabId: this.controller.state.activeTabId });
  }

  private activateRelativeTab(offset: number): void {
    if (this.overlay || this.authentication) return;
    const tabs = this.controller.state.tabs;
    const index = tabs.findIndex((tab) => tab.id === this.controller.state.activeTabId);
    const next = tabs[(index + offset + tabs.length) % tabs.length];
    if (next) this.controller.dispatch({ type: "activate-tab", tabId: next.id });
  }

  private resizeActivePane(delta: number): void {
    if (this.overlay || this.authentication) return;
    const surface = activeSurface(activeTab(this.controller.state));
    const nearest = nearestSplitForPane(surface.root, surface.activePaneId);
    if (!nearest) return;
    const ratio = nearest.split.ratio + (nearest.side === "first" ? delta : -delta);
    this.controller.dispatch({ type: "resize-split", splitId: nearest.split.id, ratio });
  }

  private exchangeActivePane(): void {
    if (this.overlay || this.authentication) return;
    const surface = activeSurface(activeTab(this.controller.state));
    const panes = collectPaneIds(surface.root);
    if (panes.length < 2) return;
    const index = panes.indexOf(surface.activePaneId);
    const target = panes[(index + 1) % panes.length];
    if (!target) return;
    this.controller.dispatch({
      type: "swap-panes",
      firstPaneId: surface.activePaneId,
      secondPaneId: target,
    });
  }

  private openAddMenu(): void {
    if (this.overlay || this.authentication) return;
    this.openCommandPalette([
      { id: "local-shell", title: "Open Local shell", run: () => this.addLocalTab() },
      { id: "focus-hosts", title: "Select an SSH Host", run: () => this.focusHosts() },
    ]);
  }

  private commands(): PaletteCommand[] {
    const leader = displayBinding(this.config.ui.leader);
    const advanced = (key: string) => `${leader} ${key.toUpperCase()}`;
    const surface = activeSurface(activeTab(this.controller.state));
    const fileCommands = this.registry.fileCommands(surface.activePaneId);
    return [
      ...fileCommands,
      {
        id: "switch",
        title: "Switch Files / Terminal",
        shortcut: displayBinding(this.config.ui.quickSwitch),
        run: () => this.switchSurface(),
      },
      { id: "hosts", title: "Focus Host tree", run: () => this.focusHosts() },
      {
        id: "split-h",
        title: "Split horizontally",
        shortcut: advanced("s"),
        run: () => this.split("horizontal"),
      },
      {
        id: "split-v",
        title: "Split vertically",
        shortcut: advanced("v"),
        run: () => this.split("vertical"),
      },
      {
        id: "close-pane",
        title: "Close active pane",
        shortcut: advanced("x"),
        run: () => this.closeActivePane(),
      },
      {
        id: "next-pane",
        title: "Focus next pane",
        shortcut: advanced("n"),
        run: () => this.focusRelativePane(1),
      },
      {
        id: "previous-pane",
        title: "Focus previous pane",
        shortcut: advanced("p"),
        run: () => this.focusRelativePane(-1),
      },
      {
        id: "local",
        title: "Open another Local workspace",
        shortcut: advanced("a"),
        run: () => this.addLocalTab(),
      },
      {
        id: "close-tab",
        title: "Close active tab",
        shortcut: advanced("w"),
        run: () => this.closeActiveTab(),
      },
      {
        id: "next-tab",
        title: "Activate next tab",
        shortcut: `${leader} .`,
        run: () => this.activateRelativeTab(1),
      },
      {
        id: "previous-tab",
        title: "Activate previous tab",
        shortcut: `${leader} ,`,
        run: () => this.activateRelativeTab(-1),
      },
      {
        id: "grow-pane",
        title: "Grow active pane",
        shortcut: `${leader} ]`,
        run: () => this.resizeActivePane(0.05),
      },
      {
        id: "shrink-pane",
        title: "Shrink active pane",
        shortcut: `${leader} [`,
        run: () => this.resizeActivePane(-0.05),
      },
      {
        id: "exchange-pane",
        title: "Exchange active pane",
        shortcut: advanced("e"),
        run: () => this.exchangeActivePane(),
      },
      {
        id: "toggle-sidebar",
        title: "Show or hide Host tree",
        shortcut: advanced("b"),
        run: () => this.controller.dispatch({ type: "toggle-sidebar" }),
      },
      {
        id: "settings",
        title: "Settings",
        shortcut: advanced("g"),
        run: () => this.openSettings(),
      },
      {
        id: "transfers",
        title: "Transfers",
        shortcut: advanced("t"),
        run: () => this.openTransfers(),
      },
      {
        id: "literal-leader",
        title: "Send the leader key to the terminal",
        shortcut: `${leader} ${leader}`,
        run: () => this.sendLiteralLeader(),
      },
      {
        id: "literal-f2",
        title: "Send F2 to the terminal",
        shortcut: `${leader} F2`,
        run: () => this.sendLiteralF2(),
      },
      { id: "quit", title: "Quit safely", shortcut: "Ctrl+Q", run: () => this.renderer.destroy() },
    ];
  }

  private openCommandPalette(commands = this.commands()): void {
    if (this.overlay || this.authentication) return;
    this.dismissibleOverlays.dismiss({ restoreFocus: false });
    const palette = new CommandPaletteRenderable(this.renderer, {
      id: "command-palette",
      commands,
      onClose: () => this.closeOverlay(),
    });
    this.overlay = palette;
    this.root.add(palette);
    palette.focus();
    this.renderer.requestRender();
  }

  private openSettings(): void {
    if (this.overlay || this.authentication) return;
    this.dismissibleOverlays.dismiss({ restoreFocus: false });
    if (!this.services.saveConfig) {
      this.footer.content = "Configuration is read-only";
      this.footer.fg = theme.error;
      return;
    }
    const settings = new SettingsRenderable(this.renderer, {
      id: "settings-modal",
      config: this.config,
      i18n: this.i18n,
      save: (next) => this.saveConfig(next),
      confirmSave: (previous, next) =>
        mediaConfigChanged(previous, next) && this.registry.hasPlayingMedia()
          ? this.i18n.t("settings.mediaConfirm")
          : undefined,
      onClose: () => this.closeOverlay(),
    });
    this.overlay = settings;
    this.root.add(settings);
    settings.focus();
    this.renderer.requestRender();
  }

  private openTransfers(): void {
    if (this.overlay || this.authentication) return;
    this.dismissibleOverlays.dismiss({ restoreFocus: false });
    const queue = this.services.transferQueue;
    if (!queue) {
      this.footer.content = this.i18n.t("file.noTransfer");
      this.footer.fg = theme.warning;
      return;
    }
    const transfers = new TransferManagerRenderable(this.renderer, {
      id: "transfer-modal",
      queue,
      i18n: this.i18n,
      onClose: () => this.closeOverlay(),
    });
    this.overlay = transfers;
    this.root.add(transfers);
    transfers.focus();
    this.renderer.requestRender();
  }

  private closeOverlay(): void {
    const overlay = this.overlay;
    if (!overlay) return;
    this.overlay = undefined;
    this.root.remove(overlay);
    overlay.destroyRecursively();
    const surface = activeSurface(activeTab(this.controller.state));
    this.registry.focus(surface.focusedPaneId ?? surface.activePaneId);
    this.renderer.requestRender();
  }

  private showAuthentication(
    hostId: string,
    backend: import("../terminal/pty-backend.js").PtyBackend,
  ): void {
    this.dismissibleOverlays.dismiss({ restoreFocus: false });
    if (this.authentication) {
      this.layoutHost.remove(this.authentication);
      this.authentication.destroyRecursively();
    }
    const profile = this.services.catalog.host(hostId);
    const authentication = new SshAuthenticationRenderable(this.renderer, {
      id: "ssh-authentication",
      hostLabel: profile.label,
      backend,
      onRetry: () => void this.services.connections?.reconnect(hostId).catch(() => undefined),
      onCancel: () => {
        this.services.connections?.cancel(hostId);
        this.closeAuthentication(hostId);
      },
    });
    this.authentication = authentication;
    this.authenticationHostId = hostId;
    this.layoutHost.add(authentication);
    authentication.focus();
    this.renderer.requestRender();
  }

  private closeAuthentication(hostId: string): void {
    if (!this.authentication || this.authenticationHostId !== hostId) return;
    const authentication = this.authentication;
    this.authentication = undefined;
    this.authenticationHostId = undefined;
    this.layoutHost.remove(authentication);
    authentication.destroyRecursively();
    const surface = activeSurface(activeTab(this.controller.state));
    this.registry.focus(surface.focusedPaneId ?? surface.activePaneId);
    this.renderer.requestRender();
  }

  private async saveConfig(next: TermLoomConfig): Promise<TermLoomConfig> {
    const save = this.services.saveConfig;
    if (!save) throw new Error("Configuration is read-only");
    const previousLeader = this.config.ui.leader;
    const previousQuickSwitch = this.config.ui.quickSwitch;
    const previous = structuredClone(this.config);
    const saved = await save(next);
    this.config = structuredClone(saved);
    const runtime = await this.services.applyRuntimeConfig?.(previous, saved);
    this.i18n.setLocale(resolveLocale(saved.ui.locale));
    applyTheme(saved.ui.theme, this.renderer.themeMode);
    this.sidebarView.setConfig(this.config);
    if (this.controller.state.sidebar.width !== saved.ui.sidebarWidth) {
      this.controller.dispatch({ type: "set-sidebar-width", width: saved.ui.sidebarWidth });
    }
    if (previousLeader !== saved.ui.leader || previousQuickSwitch !== saved.ui.quickSwitch) {
      this.installKeymap();
    }
    await this.registry.applyRuntimeConfig(
      saved.reconnect,
      mediaConfigChanged(previous, saved) ? runtime?.preview : undefined,
    );
    this.refreshAppearance();
    return structuredClone(saved);
  }

  private refreshAppearance(): void {
    this.renderer.setBackgroundColor(theme.background);
    this.root.backgroundColor = theme.background;
    this.sidebar.backgroundColor = theme.surface;
    this.layoutHost.backgroundColor = theme.background;
    this.sidebarDivider.fg = theme.border;
    this.workspaceContext.refreshAppearance();
    this.filesSegment.content = ` ${this.i18n.t("pane.files")} `;
    this.terminalSegment.content = ` ${this.i18n.t("pane.terminal")} `;
    const brand = this.root.findDescendantById("brand") as TextRenderable | undefined;
    if (brand) {
      brand.content = ` ◈ ${this.i18n.t("app.name")} `;
      brand.fg = theme.accent;
    }
    const help = this.root.findDescendantById("help-button") as TextRenderable | undefined;
    if (help) {
      help.content = ` ${this.i18n.t("header.help")} `;
      help.fg = theme.accent;
      help.bg = theme.surfaceRaised;
    }
    const hostTree = this.root.findDescendantById("sidebar-toggle-button") as
      | TextRenderable
      | undefined;
    if (hostTree) {
      hostTree.content = ` ☰ ${this.i18n.t("sidebar.hosts")} `;
      hostTree.fg = theme.accent;
      hostTree.bg = theme.surfaceRaised;
    }
    this.footer.content = footerText();
    this.footer.fg = theme.muted;
    this.footer.bg = theme.surfaceRaised;
    this.sidebarView.refreshAppearance();
    this.registry.refreshAppearance();
    this.renderState(this.controller.state);
  }

  private async handleRendererFocus(): Promise<void> {
    if (this.destroyed) return;
    this.dismissibleOverlays.dismiss({ restoreFocus: false });
    const target = activeTab(this.controller.state).target;
    const hostId = target.kind === "ssh" ? target.hostId : undefined;
    this.services.onRendererFocus?.(hostId);
    if (hostId) await this.refreshHostData(hostId);
  }

  private showPathUnavailable(): void {
    if (this.destroyed) return;
    this.footer.content = ` ${this.i18n.t("file.pathUnavailable")}`;
    this.footer.fg = theme.error;
    this.renderer.requestRender();
  }

  private async refreshHostData(hostId: string): Promise<void> {
    if (this.destroyed) return;
    await Promise.allSettled([this.registry.refreshHost(hostId)]);
  }
}

function footerText(): string {
  return " F1 Help";
}

function sameTarget(left: PaneState["target"], right: PaneState["target"]): boolean {
  if (left.kind === "local" || right.kind === "local") {
    return left.kind === "local" && right.kind === "local";
  }
  return left.hostId === right.hostId;
}

function tabOwnsPane(tab: WorkspaceSnapshot["tabs"][number], paneId: string): boolean {
  return (
    collectPaneIds(tab.surfaces.files.root).includes(paneId) ||
    collectPaneIds(tab.surfaces.terminal.root).includes(paneId)
  );
}

function mediaConfigChanged(previous: TermLoomConfig, next: TermLoomConfig): boolean {
  return JSON.stringify(previous.media) !== JSON.stringify(next.media);
}

function uniqueId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function controlCharacter(binding: string): string {
  const match = /^ctrl\+([a-z@[\\\]^_?])$/i.exec(binding);
  const key = match?.[1]?.toUpperCase();
  if (!key) return "\u0007";
  if (key === "?") return "\u007f";
  return String.fromCharCode(key.charCodeAt(0) & 0x1f);
}

function displayBinding(binding: string): string {
  return binding
    .split("+")
    .map((part) =>
      part.length === 1 ? part.toUpperCase() : `${part[0]?.toUpperCase()}${part.slice(1)}`,
    )
    .join("+");
}

function consumeMouse(event: MouseEvent): void {
  event.preventDefault();
  event.stopPropagation();
}
