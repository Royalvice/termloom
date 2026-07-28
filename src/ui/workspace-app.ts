import {
  BoxRenderable,
  CliRenderEvents,
  type CliRenderer,
  type Renderable,
  TabSelectRenderable,
  TabSelectRenderableEvents,
  TextAttributes,
  TextRenderable,
} from "@opentui/core";
import { registerLeader } from "@opentui/keymap/addons";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import type { TermLoomConfig } from "../config/schema.js";
import type { I18n } from "../i18n/i18n.js";
import type { TransferQueue } from "../sftp/transfer-queue.js";
import type { TmuxService } from "../tmux/tmux-service.js";
import { activeTab, collectPaneIds, nearestSplitForPane } from "../workspace/reducer.js";
import type { WorkspaceController } from "../workspace/controller.js";
import type {
  LayoutNode,
  PaneState,
  WorkspaceSnapshot,
  WorkspaceTab,
} from "../workspace/schema.js";
import type { PaneViewFactory } from "./pane-factory.js";
import { PaneRegistry } from "./pane-registry.js";
import { SettingsRenderable } from "./settings-renderable.js";
import { SidebarRenderable, type SidebarSection } from "./sidebar-renderable.js";
import { theme } from "./theme.js";
import { TransferManagerRenderable } from "./transfer-manager-renderable.js";

export interface WorkspaceAppServices {
  sessions?: TmuxService;
  transferQueue?: TransferQueue;
  saveConfig?: (config: TermLoomConfig) => Promise<TermLoomConfig>;
}

export class WorkspaceApp {
  public readonly root: BoxRenderable;
  private readonly sidebar: BoxRenderable;
  private readonly sidebarView: SidebarRenderable;
  private readonly tabBar: TabSelectRenderable;
  private readonly layoutHost: BoxRenderable;
  private readonly footer: TextRenderable;
  private readonly registry: PaneRegistry;
  private config: TermLoomConfig;
  private readonly services: WorkspaceAppServices;
  private layoutRoot: Renderable | undefined;
  private overlay: SettingsRenderable | TransferManagerRenderable | undefined;
  private readonly disposers: Array<() => void> = [];
  private destroyed = false;

  public constructor(
    private readonly renderer: CliRenderer,
    config: TermLoomConfig,
    private readonly i18n: I18n,
    private readonly controller: WorkspaceController,
    paneFactory: PaneViewFactory,
    services: WorkspaceAppServices = {},
  ) {
    this.config = structuredClone(config);
    this.services = services;
    this.registry = new PaneRegistry(renderer, paneFactory, (paneId) => {
      this.controller.dispatch({ type: "focus-pane", paneId });
    });
    this.root = new BoxRenderable(renderer, {
      id: "termloom-root",
      width: "100%",
      height: "100%",
      flexDirection: "column",
      backgroundColor: theme.background,
    });
    this.root.add(this.createHeader());
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
      border: ["right"],
      borderColor: theme.border,
      backgroundColor: theme.surface,
      overflow: "hidden",
    });
    this.sidebarView = new SidebarRenderable(renderer, {
      id: "sidebar-content",
      config: this.config,
      section: controller.state.sidebar.section,
      i18n,
      sessions: services.sessions,
      saveConfig: services.saveConfig ? (next) => this.saveConfig(next) : undefined,
      hostInUse: (hostId) =>
        Object.values(this.controller.state.panes).some(
          (pane) => "hostId" in pane && pane.hostId === hostId,
        ),
      onSectionChange: (section) => {
        if (this.controller.state.sidebar.section !== section) {
          this.controller.dispatch({ type: "select-sidebar-section", section });
        }
      },
      onOpenTerminal: (hostId, tmuxSession) =>
        this.openPaneInTab({
          id: uniqueId("pane"),
          kind: "terminal",
          title: tmuxSession ? `${hostId}:${tmuxSession}` : `${hostId} shell`,
          hostId,
          ...(tmuxSession ? { tmuxSession } : {}),
        }),
      onOpenFiles: (hostId, path) =>
        this.openPaneInTab({
          id: uniqueId("pane"),
          kind: "files",
          title: `${hostId}:${path}`,
          hostId,
          path,
        }),
    });
    this.sidebar.add(this.sidebarView);
    body.add(this.sidebar);

    const main = new BoxRenderable(renderer, {
      id: "main",
      flexDirection: "column",
      flexGrow: 1,
      height: "100%",
      minWidth: 1,
    });
    this.tabBar = new TabSelectRenderable(renderer, {
      id: "tabs",
      height: 1,
      flexGrow: 1,
      minWidth: 1,
      options: [],
      showDescription: false,
      showUnderline: true,
      showScrollArrows: true,
      tabWidth: 18,
      backgroundColor: theme.surfaceRaised,
      textColor: theme.muted,
      selectedTextColor: theme.foreground,
      selectedBackgroundColor: theme.surfaceRaised,
    });
    this.tabBar.on(TabSelectRenderableEvents.SELECTION_CHANGED, (index: number) => {
      const tab = this.controller.state.tabs[index];
      if (tab && tab.id !== this.controller.state.activeTabId) {
        this.controller.dispatch({ type: "activate-tab", tabId: tab.id });
      }
    });
    const tabRow = new BoxRenderable(renderer, {
      id: "tab-row",
      height: 1,
      width: "100%",
      flexDirection: "row",
      backgroundColor: theme.surfaceRaised,
    });
    tabRow.add(this.tabBar);
    tabRow.add(
      new TextRenderable(renderer, {
        id: "tab-actions",
        width: 24,
        height: 1,
        content: this.i18n.t("tabs.actions"),
        fg: theme.muted,
        attributes: TextAttributes.DIM,
      }),
    );
    main.add(tabRow);
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
      content: this.i18n.t("footer.shortcuts"),
      fg: theme.muted,
      bg: theme.surfaceRaised,
      attributes: TextAttributes.DIM,
    });
    this.root.add(this.footer);
    renderer.root.add(this.root);

    const destroyWithRenderer = () => this.destroy();
    renderer.once(CliRenderEvents.DESTROY, destroyWithRenderer);
    this.disposers.push(() => renderer.off(CliRenderEvents.DESTROY, destroyWithRenderer));

    this.installKeymap();
    this.disposers.push(this.controller.onChange((state) => this.renderState(state)));
    this.renderState(controller.state);
  }

  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    // Disposers are dependencies: the keymap layer references the leader token,
    // so tear them down in reverse registration order. Removing the token first
    // briefly recompiles a still-live layer with an unresolved <leader> binding.
    for (const dispose of this.disposers.splice(0).reverse()) dispose();
    this.registry.destroy();
    this.root.destroyRecursively();
  }

  private createHeader(): BoxRenderable {
    const header = new BoxRenderable(this.renderer, {
      id: "header",
      height: 1,
      width: "100%",
      flexDirection: "row",
      justifyContent: "space-between",
      backgroundColor: theme.surfaceRaised,
    });
    header.add(
      new TextRenderable(this.renderer, {
        id: "brand",
        content: ` ◈ ${this.i18n.t("app.name")} `,
        fg: theme.accent,
        attributes: TextAttributes.BOLD,
      }),
    );
    header.add(
      new TextRenderable(this.renderer, {
        id: "status",
        content: ` ${this.i18n.t("status.ready")} `,
        fg: theme.success,
      }),
    );
    return header;
  }

  private renderState(state: WorkspaceSnapshot): void {
    this.sidebar.visible = state.sidebar.visible;
    this.sidebar.width = state.sidebar.width;
    this.sidebarView.setSection(state.sidebar.section, false, false);
    this.tabBar.setOptions(
      state.tabs.map((tab) => ({ name: ` ${tab.title} `, description: "", value: tab.id })),
    );
    this.tabBar.setSelectedIndex(state.tabs.findIndex((tab) => tab.id === state.activeTabId));
    this.registry.reconcile(state);
    this.registry.detachAll();
    if (this.layoutRoot) {
      if (this.layoutRoot.parent === this.layoutHost) this.layoutHost.remove(this.layoutRoot);
      if (!this.registry.owns(this.layoutRoot)) this.layoutRoot.destroyRecursively();
    }
    this.layoutRoot = this.buildLayout(activeTab(state).root, state);
    this.layoutHost.add(this.layoutRoot);
    if (!this.overlay && !this.sidebarView.focused)
      this.registry.focus(activeTab(state).activePaneId);
    this.footer.content = `${this.i18n.t("footer.shortcuts")}  │  ${this.i18n.t(
      "workspace.shortcuts",
    )}`;
    this.renderer.requestRender();
  }

  private buildLayout(node: LayoutNode, state: WorkspaceSnapshot): Renderable {
    if (node.type === "pane") {
      const pane = state.panes[node.paneId];
      if (!pane) throw new Error(`Missing pane ${node.paneId}`);
      return this.registry.frame(pane);
    }
    const container = new BoxRenderable(this.renderer, {
      id: `layout-${node.id}`,
      width: "100%",
      height: "100%",
      flexDirection: node.direction === "horizontal" ? "row" : "column",
      minWidth: 1,
      minHeight: 1,
    });
    const firstHost = new BoxRenderable(this.renderer, {
      id: `layout-${node.id}-first`,
      width: node.direction === "horizontal" ? `${node.ratio * 100}%` : "100%",
      height: node.direction === "vertical" ? `${node.ratio * 100}%` : "100%",
      minWidth: 1,
      minHeight: 1,
    });
    firstHost.add(this.buildLayout(node.first, state));
    const secondHost = new BoxRenderable(this.renderer, {
      id: `layout-${node.id}-second`,
      flexGrow: 1,
      minWidth: 1,
      minHeight: 1,
    });
    secondHost.add(this.buildLayout(node.second, state));
    container.add(firstHost);
    container.add(secondHost);
    return container;
  }

  private installKeymap(): void {
    const keymap = createDefaultOpenTuiKeymap(this.renderer);
    this.disposers.push(registerLeader(keymap, { trigger: this.config.ui.leader }));
    this.disposers.push(
      keymap.registerLayer({
        commands: [
          { name: "app.quit", run: () => this.renderer.destroy() },
          { name: "workspace.split-horizontal", run: () => this.split("horizontal") },
          { name: "workspace.split-vertical", run: () => this.split("vertical") },
          { name: "workspace.close-pane", run: () => this.closeActivePane() },
          { name: "workspace.next-pane", run: () => this.focusRelativePane(1) },
          { name: "workspace.previous-pane", run: () => this.focusRelativePane(-1) },
          { name: "workspace.add-tab", run: () => this.addLocalTab() },
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
          {
            name: "sidebar.hosts",
            run: () => this.selectSidebar("hosts"),
          },
          {
            name: "sidebar.sessions",
            run: () => this.selectSidebar("sessions"),
          },
          {
            name: "sidebar.files",
            run: () => this.selectSidebar("files"),
          },
          { name: "terminal.literal-leader", run: () => this.sendLiteralLeader() },
        ],
        bindings: [
          { key: "ctrl+q", cmd: "app.quit" },
          { key: "<leader>s", cmd: "workspace.split-horizontal" },
          { key: "<leader>v", cmd: "workspace.split-vertical" },
          { key: "<leader>x", cmd: "workspace.close-pane" },
          { key: "<leader>n", cmd: "workspace.next-pane" },
          { key: "<leader>p", cmd: "workspace.previous-pane" },
          { key: "<leader>a", cmd: "workspace.add-tab" },
          { key: "<leader>w", cmd: "workspace.close-tab" },
          { key: "<leader>.", cmd: "workspace.next-tab" },
          { key: "<leader>,", cmd: "workspace.previous-tab" },
          { key: "<leader>]", cmd: "workspace.grow-pane" },
          { key: "<leader>[", cmd: "workspace.shrink-pane" },
          { key: "<leader>e", cmd: "workspace.exchange-pane" },
          { key: "<leader>g", cmd: "app.settings" },
          { key: "<leader>t", cmd: "app.transfers" },
          { key: "<leader>b", cmd: "workspace.toggle-sidebar" },
          { key: "<leader>1", cmd: "sidebar.hosts" },
          { key: "<leader>2", cmd: "sidebar.sessions" },
          { key: "<leader>3", cmd: "sidebar.files" },
          { key: "<leader><leader>", cmd: "terminal.literal-leader" },
        ],
      }),
    );
  }

  private split(direction: "horizontal" | "vertical"): void {
    if (this.overlay) return;
    const tab = activeTab(this.controller.state);
    const source = this.controller.state.panes[tab.activePaneId];
    if (!source) return;
    this.controller.dispatch({
      type: "split-pane",
      paneId: source.id,
      direction,
      pane: this.newSiblingPane(source),
    });
  }

  private newSiblingPane(source: PaneState): PaneState {
    const id = `pane-${crypto.randomUUID()}`;
    if (source.kind === "terminal") {
      return { ...source, id, title: source.hostId ? `${source.hostId} shell` : "Local shell" };
    }
    if (source.kind === "files") return { ...source, id, title: "Files" };
    return { ...source, id, title: "Preview" };
  }

  private closeActivePane(): void {
    if (this.overlay) return;
    const tab = activeTab(this.controller.state);
    if (collectPaneIds(tab.root).length <= 1) return;
    this.controller.dispatch({ type: "close-pane", paneId: tab.activePaneId });
  }

  private focusRelativePane(offset: number): void {
    if (this.overlay) return;
    const tab = activeTab(this.controller.state);
    const panes = collectPaneIds(tab.root);
    const current = panes.indexOf(tab.activePaneId);
    const next = (current + offset + panes.length) % panes.length;
    const paneId = panes[next];
    if (paneId) this.controller.dispatch({ type: "focus-pane", paneId });
  }

  private sendLiteralLeader(): void {
    if (this.overlay) return;
    const tab = activeTab(this.controller.state);
    this.registry.terminal(tab.activePaneId)?.sendInput("\u0000");
  }

  private addLocalTab(): void {
    if (this.overlay) return;
    this.openPaneInTab({
      id: uniqueId("pane"),
      kind: "terminal",
      title: "Local shell",
    });
  }

  private openPaneInTab(pane: PaneState): void {
    if (this.overlay) return;
    const tab: WorkspaceTab = {
      id: uniqueId("tab"),
      title: pane.title,
      root: { type: "pane", paneId: pane.id },
      activePaneId: pane.id,
    };
    this.controller.dispatch({ type: "add-tab", tab, panes: [pane] });
    this.registry.focus(pane.id);
  }

  private closeActiveTab(): void {
    if (this.overlay || this.controller.state.tabs.length <= 1) return;
    this.controller.dispatch({ type: "close-tab", tabId: this.controller.state.activeTabId });
  }

  private activateRelativeTab(offset: number): void {
    if (this.overlay) return;
    const tabs = this.controller.state.tabs;
    const index = tabs.findIndex((tab) => tab.id === this.controller.state.activeTabId);
    const next = tabs[(index + offset + tabs.length) % tabs.length];
    if (next) this.controller.dispatch({ type: "activate-tab", tabId: next.id });
  }

  private resizeActivePane(delta: number): void {
    if (this.overlay) return;
    const tab = activeTab(this.controller.state);
    const nearest = nearestSplitForPane(tab.root, tab.activePaneId);
    if (!nearest) return;
    const ratio = nearest.split.ratio + (nearest.side === "first" ? delta : -delta);
    this.controller.dispatch({
      type: "resize-split",
      splitId: nearest.split.id,
      ratio,
    });
  }

  private exchangeActivePane(): void {
    if (this.overlay) return;
    const tab = activeTab(this.controller.state);
    const panes = collectPaneIds(tab.root);
    if (panes.length < 2) return;
    const index = panes.indexOf(tab.activePaneId);
    const target = panes[(index + 1) % panes.length];
    if (!target) return;
    this.controller.dispatch({
      type: "swap-panes",
      firstPaneId: tab.activePaneId,
      secondPaneId: target,
    });
  }

  private selectSidebar(section: SidebarSection): void {
    if (this.overlay) return;
    if (!this.controller.state.sidebar.visible) {
      this.controller.dispatch({ type: "toggle-sidebar" });
    }
    if (this.controller.state.sidebar.section !== section) {
      this.controller.dispatch({ type: "select-sidebar-section", section });
    }
    this.sidebarView.setSection(section, true, false);
  }

  private openSettings(): void {
    if (this.overlay) return;
    if (!this.services.saveConfig) {
      this.footer.content = this.i18n.t("settings.error", {
        message: "Configuration is read-only",
      });
      this.footer.fg = theme.error;
      return;
    }
    const settings = new SettingsRenderable(this.renderer, {
      id: "settings-modal",
      config: this.config,
      i18n: this.i18n,
      save: (next) => this.saveConfig(next),
      onClose: () => this.closeOverlay(),
    });
    this.overlay = settings;
    this.root.add(settings);
    settings.focus();
    this.renderer.requestRender();
  }

  private openTransfers(): void {
    if (this.overlay) return;
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
    this.registry.focus(activeTab(this.controller.state).activePaneId);
    this.renderer.requestRender();
  }

  private async saveConfig(next: TermLoomConfig): Promise<TermLoomConfig> {
    const save = this.services.saveConfig;
    if (!save) throw new Error("Configuration is read-only");
    const saved = await save(next);
    this.config = structuredClone(saved);
    this.sidebarView.setConfig(this.config);
    if (this.controller.state.sidebar.width !== saved.ui.sidebarWidth) {
      this.controller.dispatch({ type: "set-sidebar-width", width: saved.ui.sidebarWidth });
    }
    return structuredClone(saved);
  }
}

function uniqueId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}
