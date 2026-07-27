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
import { activeTab, collectPaneIds } from "../workspace/reducer.js";
import type { WorkspaceController } from "../workspace/controller.js";
import type { LayoutNode, PaneState, WorkspaceSnapshot } from "../workspace/schema.js";
import type { PaneViewFactory } from "./pane-factory.js";
import { PaneRegistry } from "./pane-registry.js";
import { theme } from "./theme.js";

export class WorkspaceApp {
  public readonly root: BoxRenderable;
  private readonly sidebar: BoxRenderable;
  private readonly sidebarText: TextRenderable;
  private readonly tabBar: TabSelectRenderable;
  private readonly layoutHost: BoxRenderable;
  private readonly footer: TextRenderable;
  private readonly registry: PaneRegistry;
  private layoutRoot: Renderable | undefined;
  private readonly disposers: Array<() => void> = [];
  private destroyed = false;

  public constructor(
    private readonly renderer: CliRenderer,
    private readonly config: TermLoomConfig,
    private readonly i18n: I18n,
    private readonly controller: WorkspaceController,
    paneFactory: PaneViewFactory,
  ) {
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
    this.sidebarText = new TextRenderable(renderer, {
      id: "sidebar-content",
      content: " ",
      fg: theme.foreground,
      width: "100%",
      height: "100%",
    });
    this.sidebar.add(this.sidebarText);
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
      width: "100%",
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
    main.add(this.tabBar);
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
    this.sidebarText.content = this.sidebarContent(state);
    this.tabBar.setOptions(
      state.tabs.map((tab) => ({ name: ` ${tab.title} `, description: "", value: tab.id })),
    );
    this.tabBar.setSelectedIndex(state.tabs.findIndex((tab) => tab.id === state.activeTabId));
    this.registry.reconcile(state);
    this.registry.detachAll();
    if (this.layoutRoot) {
      this.layoutHost.remove(this.layoutRoot);
      if (!this.registry.owns(this.layoutRoot)) this.layoutRoot.destroyRecursively();
    }
    this.layoutRoot = this.buildLayout(activeTab(state).root, state);
    this.layoutHost.add(this.layoutRoot);
    this.registry.focus(activeTab(state).activePaneId);
    this.footer.content = `${this.i18n.t("footer.shortcuts")}  │  ${state.sidebar.section}`;
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

  private sidebarContent(state: WorkspaceSnapshot): string {
    const marker = (section: string) => (state.sidebar.section === section ? "▸" : " ");
    const hosts = this.config.hosts.length
      ? this.config.hosts.map((host) => `  ◇ ${host.label ?? host.alias}`).join("\n")
      : `  ${this.i18n.t("empty.hosts")}`;
    const active = activeTab(state);
    const panes = collectPaneIds(active.root)
      .map((paneId) => state.panes[paneId])
      .filter((pane): pane is PaneState => pane !== undefined);
    const sessions = panes
      .filter(
        (pane): pane is Extract<PaneState, { kind: "terminal" }> =>
          pane.kind === "terminal" && Boolean(pane.tmuxSession),
      )
      .map((pane) => `  ● ${pane.tmuxSession}`)
      .join("\n");
    const files = panes
      .filter((pane) => pane.kind === "files")
      .map((pane) => `  ▣ ${pane.path}`)
      .join("\n");
    return [
      `${marker("hosts")} ${this.i18n.t("sidebar.hosts")}`,
      hosts,
      "",
      `${marker("sessions")} ${this.i18n.t("sidebar.sessions")}`,
      sessions || `  ${this.i18n.t("empty.sessions")}`,
      "",
      `${marker("files")} ${this.i18n.t("sidebar.files")}`,
      files || `  ${this.i18n.t("empty.files")}`,
    ].join("\n");
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
          {
            name: "workspace.toggle-sidebar",
            run: () => this.controller.dispatch({ type: "toggle-sidebar" }),
          },
          {
            name: "sidebar.hosts",
            run: () =>
              this.controller.dispatch({ type: "select-sidebar-section", section: "hosts" }),
          },
          {
            name: "sidebar.sessions",
            run: () =>
              this.controller.dispatch({ type: "select-sidebar-section", section: "sessions" }),
          },
          {
            name: "sidebar.files",
            run: () =>
              this.controller.dispatch({ type: "select-sidebar-section", section: "files" }),
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
    const tab = activeTab(this.controller.state);
    if (collectPaneIds(tab.root).length <= 1) return;
    this.controller.dispatch({ type: "close-pane", paneId: tab.activePaneId });
  }

  private focusRelativePane(offset: number): void {
    const tab = activeTab(this.controller.state);
    const panes = collectPaneIds(tab.root);
    const current = panes.indexOf(tab.activePaneId);
    const next = (current + offset + panes.length) % panes.length;
    const paneId = panes[next];
    if (paneId) this.controller.dispatch({ type: "focus-pane", paneId });
  }

  private sendLiteralLeader(): void {
    const tab = activeTab(this.controller.state);
    this.registry.terminal(tab.activePaneId)?.sendInput("\u0000");
  }
}
