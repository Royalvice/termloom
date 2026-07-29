import {
  BoxRenderable,
  InputRenderable,
  InputRenderableEvents,
  type KeyEvent,
  MouseButton,
  type RenderContext,
  ScrollBoxRenderable,
  SelectRenderable,
  SelectRenderableEvents,
  TextAttributes,
  TextRenderable,
} from "@opentui/core";
import type { TermLoomConfig } from "../config/schema.js";
import { errorMessage, TermLoomError } from "../core/errors.js";
import type { I18n } from "../i18n/i18n.js";
import {
  type HostCatalog,
  type HostCatalogSnapshot,
  type HostProfile,
  metadataForProfile,
  stableHostId,
} from "../ssh/host-catalog.js";
import type { TmuxSessionInfo } from "../tmux/tmux-service.js";
import { attachMouseSelect } from "./mouse-select-adapter.js";
import {
  HostMetadataFormRenderable,
  type HostMetadataValues,
} from "./host-metadata-form-renderable.js";
import { theme } from "./theme.js";

export type SidebarSection = "hosts";

export interface SidebarSessionService {
  list(hostId: string): Promise<readonly TmuxSessionInfo[]>;
  create(hostId: string, name: string, cwd?: string): Promise<void>;
  rename(hostId: string, currentName: string, nextName: string): Promise<void>;
  kill(hostId: string, name: string): Promise<void>;
}

export interface SidebarRenderableOptions {
  id: string;
  config: TermLoomConfig;
  catalog: HostCatalog;
  i18n: I18n;
  sessions?: SidebarSessionService;
  saveConfig?: (config: TermLoomConfig) => Promise<TermLoomConfig>;
  hostInUse?: (hostId: string) => boolean;
  onSelectHost?: (profile: HostProfile) => void;
  onAttachSession?: (profile: HostProfile, session: TmuxSessionInfo) => void;
  onOpenSessionSplit?: (profile: HostProfile, session: TmuxSessionInfo) => void;
  onCollapse?: () => void;
  onCatalogChange?: (snapshot: HostCatalogSnapshot) => void;
}

type SidebarEntry =
  | { kind: "host"; profile: HostProfile }
  | { kind: "session"; profile: HostProfile; session: TmuxSessionInfo }
  | { kind: "loading"; profile: HostProfile }
  | { kind: "error"; profile: HostProfile; message: string };

interface ContextAction {
  label: string;
  run: () => Promise<void> | void;
}

export class SidebarRenderable extends BoxRenderable {
  private config: TermLoomConfig;
  private readonly optionsValue: SidebarRenderableOptions;
  private readonly search: InputRenderable;
  private readonly list: SelectRenderable;
  private readonly footer: TextRenderable;
  private entries: readonly SidebarEntry[] = [];
  private sessions: readonly TmuxSessionInfo[] = [];
  private selectedHostId: string | undefined;
  private selectedSessionName: string | undefined;
  private expandedHostId: string | undefined;
  private sessionsLoading = false;
  private sessionsError: string | undefined;
  private query = "";
  private modal: BoxRenderable | undefined;
  private modalInput: InputRenderable | undefined;
  private modalList: SelectRenderable | undefined;
  private modalMouseDispose: (() => void) | undefined;
  private contextActions: readonly ContextAction[] = [];
  private refreshGeneration = 0;
  private readonly disposeMouse: () => void;

  public constructor(ctx: RenderContext, options: SidebarRenderableOptions) {
    super(ctx, {
      id: options.id,
      width: "100%",
      height: "100%",
      flexDirection: "column",
      focusable: true,
      backgroundColor: theme.surface,
      overflow: "hidden",
    });
    this.optionsValue = options;
    this.config = structuredClone(options.config);
    this.selectedHostId = options.catalog.list()[0]?.id;
    this.add(this.createToolbar(ctx));
    this.search = new InputRenderable(ctx, {
      id: `${options.id}-search`,
      width: "100%",
      value: "",
      placeholder: "Search hosts…",
      backgroundColor: theme.surfaceRaised,
      focusedBackgroundColor: theme.selection,
      textColor: theme.foreground,
      cursorColor: theme.accent,
    });
    this.search.on(InputRenderableEvents.INPUT, (value: string) => {
      this.query = value.trim().toLocaleLowerCase();
      this.rebuildEntries();
    });
    this.search.on(InputRenderableEvents.ENTER, () => {
      this.list.focus();
      const selected = this.selectedEntry();
      if (selected) void this.activateEntry(selected);
    });
    this.add(this.search);
    this.list = new SelectRenderable(ctx, {
      id: `${options.id}-list`,
      width: "100%",
      flexGrow: 1,
      options: [],
      showDescription: true,
      showScrollIndicator: true,
      wrapSelection: false,
      backgroundColor: theme.surface,
      textColor: theme.foreground,
      selectedBackgroundColor: theme.selection,
      selectedTextColor: theme.foreground,
      descriptionColor: theme.muted,
      selectedDescriptionColor: theme.foreground,
    });
    this.list.on(SelectRenderableEvents.SELECTION_CHANGED, () => this.rememberHost());
    this.list.on(SelectRenderableEvents.ITEM_SELECTED, () => {
      const entry = this.selectedEntry();
      if (entry) void this.activateEntry(entry);
    });
    this.disposeMouse = attachMouseSelect(this.list, {
      onClick: () => this.rememberHost(),
      onDoubleClick: (index) => {
        const entry = this.entries[index];
        if (entry) void this.activateEntry(entry);
      },
      onContextMenu: (index) => {
        const entry = this.entries[index];
        if (entry) this.openContextMenu(entry);
      },
    });
    this.add(this.list);
    this.footer = new TextRenderable(ctx, {
      id: `${options.id}-footer`,
      width: "100%",
      height: 2,
      content: "Click a host · Enter open · Right-click actions",
      fg: theme.muted,
      attributes: TextAttributes.DIM,
    });
    this.add(this.footer);
    this.rebuildEntries();
  }

  public setConfig(config: TermLoomConfig): void {
    this.config = structuredClone(config);
    this.rebuildEntries();
  }

  public setSection(_section: SidebarSection, focus = false, _notify = true): void {
    if (focus) this.list.focus();
  }

  public currentSection(): SidebarSection {
    return "hosts";
  }

  public refreshDisplay(): void {
    this.rebuildEntries();
  }

  public async syncActiveHost(hostId: string, refreshSessions = false): Promise<void> {
    const profile = this.optionsValue.catalog
      .list({ includeHidden: true })
      .find((candidate) => candidate.id === hostId && !candidate.hidden);
    if (!profile) return;
    if (this.selectedHostId !== hostId) this.selectedSessionName = undefined;
    this.selectedHostId = hostId;
    this.expandedHostId = hostId;
    this.rebuildEntries();
    if (refreshSessions) await this.refreshSessions(hostId);
  }

  public refreshAppearance(): void {
    this.backgroundColor = theme.surface;
    this.search.backgroundColor = theme.surfaceRaised;
    this.search.focusedBackgroundColor = theme.selection;
    this.search.textColor = theme.foreground;
    this.search.cursorColor = theme.accent;
    this.list.backgroundColor = theme.surface;
    this.list.textColor = theme.foreground;
    this.list.selectedBackgroundColor = theme.selection;
    this.list.selectedTextColor = theme.foreground;
    this.list.descriptionColor = theme.muted;
    this.list.selectedDescriptionColor = theme.foreground;
    this.rebuildEntries();
  }

  public async refreshCatalog(): Promise<void> {
    try {
      const snapshot = await this.optionsValue.catalog.refresh(this.config);
      this.optionsValue.onCatalogChange?.(snapshot);
      if (!snapshot.profiles.some((profile) => profile.id === this.selectedHostId)) {
        this.selectedHostId = this.optionsValue.catalog.list()[0]?.id;
        this.selectedSessionName = undefined;
        this.expandedHostId = undefined;
      }
      this.rebuildEntries();
      if (this.expandedHostId) await this.refreshSessions(this.expandedHostId);
    } catch (error) {
      this.showError(error);
    }
  }

  public override handleKeyPress(key: KeyEvent): boolean {
    if (this.modalInput) {
      if (key.name === "escape") {
        this.closeModal();
        return true;
      }
      return false;
    }
    if (this.modalList) {
      if (key.name === "escape") {
        this.closeModal();
        return true;
      }
      return this.modalList.handleKeyPress(key);
    }
    if (key.eventType === "release") return false;
    if (!key.ctrl && !key.meta && !key.super) {
      if (key.name === "up" || key.name === "k") {
        this.list.moveUp();
        this.rememberHost();
        return true;
      }
      if (key.name === "down" || key.name === "j") {
        this.list.moveDown();
        this.rememberHost();
        return true;
      }
      if (key.name === "return") {
        const entry = this.selectedEntry();
        if (entry) void this.activateEntry(entry);
        return true;
      }
      if (key.name === "/") {
        this.search.focus();
        return true;
      }
      if (key.name === "r" && !key.shift) {
        void this.refreshCatalog();
        return true;
      }
      if (key.name === "n" && !key.shift) {
        const entry = this.selectedEntry();
        if (entry && entry.profile.id === this.expandedHostId) this.promptNewSession(entry.profile);
        else this.promptAddAlias();
        return true;
      }
      if (key.name === "r" && key.shift) {
        this.renameSelectedSession();
        return true;
      }
      if (key.name === "d") {
        this.deleteSelected();
        return true;
      }
    }
    return false;
  }

  protected override destroySelf(): void {
    this.refreshGeneration += 1;
    this.disposeMouse();
    this.closeModal();
    super.destroySelf();
  }

  private createToolbar(ctx: RenderContext): ScrollBoxRenderable {
    const toolbar = new ScrollBoxRenderable(ctx, {
      id: `${this.optionsValue.id}-toolbar`,
      width: "100%",
      height: 1,
      scrollX: true,
      scrollY: false,
      viewportCulling: true,
      rootOptions: { backgroundColor: theme.surfaceRaised },
      contentOptions: {
        flexDirection: "row",
        height: 1,
        backgroundColor: theme.surfaceRaised,
      },
    });
    toolbar.add(
      this.toolbarButton(ctx, "refresh", " ↻ Refresh ", () => void this.refreshCatalog()),
    );
    toolbar.add(
      this.toolbarButton(ctx, "open", " Open ", () => {
        const entry = this.selectedEntry();
        if (entry) void this.activateEntry(entry);
      }),
    );
    toolbar.add(this.toolbarButton(ctx, "add", " + Alias ", () => this.promptAddAlias()));
    toolbar.add(
      this.toolbarButton(ctx, "actions", " ⋯ ", () => {
        const entry = this.selectedEntry();
        if (entry) this.openContextMenu(entry);
      }),
    );
    toolbar.add(this.toolbarButton(ctx, "collapse", " ‹ ", () => this.optionsValue.onCollapse?.()));
    return toolbar;
  }

  private toolbarButton(
    ctx: RenderContext,
    name: string,
    label: string,
    run: () => void,
  ): TextRenderable {
    return new TextRenderable(ctx, {
      id: `${this.optionsValue.id}-${name}`,
      content: label,
      fg: theme.accent,
      bg: theme.surfaceRaised,
      attributes: TextAttributes.BOLD,
      onMouseOver: () => this.ctx.setMousePointer("pointer"),
      onMouseOut: () => this.ctx.setMousePointer("default"),
      onMouseDown: (event) => {
        if (event.button !== MouseButton.LEFT) return;
        run();
        event.preventDefault();
        event.stopPropagation();
      },
    });
  }

  private rebuildEntries(): void {
    const profiles = this.optionsValue.catalog.list().filter((profile) => {
      if (!this.query) return true;
      return `${profile.label}\n${profile.alias}`.toLocaleLowerCase().includes(this.query);
    });
    const entries: SidebarEntry[] = [];
    for (const profile of profiles) {
      entries.push({ kind: "host", profile });
      if (profile.id !== this.expandedHostId) continue;
      if (this.sessionsLoading && this.sessions.length === 0) {
        entries.push({ kind: "loading", profile });
      } else if (this.sessionsError) {
        entries.push({ kind: "error", profile, message: this.sessionsError });
      } else {
        for (const session of this.sessions) entries.push({ kind: "session", profile, session });
      }
    }
    this.entries = entries;
    this.list.options = entries.length
      ? entries.map((entry) => entryOption(entry))
      : [{ name: "No SSH hosts found", description: "Use + Alias for wildcard hosts" }];
    const selectedIndex = entries.findIndex((entry) => {
      if (entryHostId(entry) !== this.selectedHostId) return false;
      if (this.selectedSessionName) {
        return entry.kind === "session" && entry.session.name === this.selectedSessionName;
      }
      return entry.kind === "host";
    });
    this.list.setSelectedIndex(Math.max(0, selectedIndex));
    const discoveryErrors = this.optionsValue.catalog.snapshot().errors;
    if (discoveryErrors.length > 0) {
      this.footer.content = `SSH config: ${discoveryErrors[0]?.message ?? "discovery error"}`;
      this.footer.fg = theme.error;
    } else {
      this.footer.content = "Click a host · Enter open · Right-click actions";
      this.footer.fg = theme.muted;
    }
    this.requestRender();
  }

  private async activateEntry(entry: SidebarEntry): Promise<void> {
    this.selectedHostId = entry.profile.id;
    if (entry.kind === "session") {
      this.selectedSessionName = entry.session.name;
      this.optionsValue.onAttachSession?.(entry.profile, entry.session);
      return;
    }
    this.selectedSessionName = undefined;
    if (entry.kind === "loading" || entry.kind === "error") return;
    if (entry.profile.source === "missing") {
      this.promptRemapAlias(entry.profile);
      return;
    }
    this.expandedHostId = entry.profile.id;
    this.sessions = [];
    this.sessionsError = undefined;
    this.optionsValue.onSelectHost?.(entry.profile);
    this.rebuildEntries();
    await this.refreshSessions(entry.profile.id);
  }

  private async refreshSessions(hostId: string): Promise<void> {
    const generation = ++this.refreshGeneration;
    this.sessionsLoading = true;
    this.sessionsError = undefined;
    this.rebuildEntries();
    try {
      const sessions = this.optionsValue.sessions
        ? await this.optionsValue.sessions.list(hostId)
        : [];
      if (generation !== this.refreshGeneration || this.isDestroyed) return;
      this.sessions = sessions;
    } catch (error) {
      if (generation !== this.refreshGeneration || this.isDestroyed) return;
      this.sessions = [];
      this.selectedSessionName = undefined;
      this.sessionsError = errorMessage(error);
    } finally {
      if (generation === this.refreshGeneration && !this.isDestroyed) {
        this.sessionsLoading = false;
        this.rebuildEntries();
      }
    }
  }

  private rememberHost(): void {
    const entry = this.selectedEntry();
    if (!entry) return;
    this.selectedHostId = entry.profile.id;
    this.selectedSessionName = entry.kind === "session" ? entry.session.name : undefined;
  }

  private selectedEntry(): SidebarEntry | undefined {
    return this.entries[this.list.getSelectedIndex()];
  }

  private promptAddAlias(): void {
    this.showPrompt("OpenSSH alias", "", async (value) => {
      const alias = required(value, "OpenSSH alias");
      if (
        this.optionsValue.catalog
          .list({ includeHidden: true })
          .some((profile) => profile.alias.toLocaleLowerCase() === alias.toLocaleLowerCase())
      ) {
        throw new Error(`SSH alias already exists in TermLoom: ${alias}`);
      }
      const next = structuredClone(this.config);
      next.hosts.push({
        id: stableHostId(alias),
        alias,
        defaultPath: ".",
        hidden: false,
        source: "manual",
      });
      await this.saveConfig(next);
      const profile = this.optionsValue.catalog
        .list({ includeHidden: true })
        .find((candidate) => candidate.alias.toLocaleLowerCase() === alias.toLocaleLowerCase());
      if (profile) await this.activateEntry({ kind: "host", profile });
    });
  }

  private promptRemapAlias(profile: HostProfile): void {
    this.showPrompt("Remap to an OpenSSH alias", profile.alias, async (value) => {
      const alias = required(value, "OpenSSH alias");
      const duplicate = this.optionsValue.catalog
        .list({ includeHidden: true })
        .find(
          (candidate) =>
            candidate.id !== profile.id &&
            candidate.alias.toLocaleLowerCase() === alias.toLocaleLowerCase(),
        );
      const next = structuredClone(this.config);
      next.hosts = next.hosts.filter((host) => host.id !== duplicate?.id);
      const current = next.hosts.find((host) => host.id === profile.id);
      const metadata = {
        ...metadataForProfile(profile),
        alias,
        source: "manual" as const,
        hidden: false,
      };
      if (current) Object.assign(current, metadata);
      else next.hosts.push(metadata);
      await this.saveConfig(next);
      const remapped = this.optionsValue.catalog
        .list({ includeHidden: true })
        .find((candidate) => candidate.id === profile.id);
      if (remapped) await this.activateEntry({ kind: "host", profile: remapped });
    });
  }

  private renameSelectedSession(): void {
    const entry = this.selectedEntry();
    if (entry?.kind !== "session" || !this.optionsValue.sessions) return;
    this.showPrompt("Rename tmux session", entry.session.name, async (value) => {
      await this.optionsValue.sessions?.rename(
        entry.profile.id,
        entry.session.name,
        required(value, "Session name"),
      );
      await this.refreshSessions(entry.profile.id);
    });
  }

  private deleteSelected(): void {
    const entry = this.selectedEntry();
    if (!entry) return;
    if (entry.kind === "session") {
      this.showPrompt("Type DELETE to kill the tmux session", "", async (value) => {
        if (value !== "DELETE") throw new Error("Session kill was not confirmed");
        await this.optionsValue.sessions?.kill(entry.profile.id, entry.session.name);
        await this.refreshSessions(entry.profile.id);
      });
      return;
    }
    if (entry.kind !== "host") return;
    this.showPrompt(
      entry.profile.source === "manual"
        ? "Type DELETE to remove this alias"
        : "Type HIDE to hide this SSH Config host",
      "",
      async (value) => {
        const manual = entry.profile.source === "manual";
        if ((manual && value !== "DELETE") || (!manual && value !== "HIDE")) {
          throw new Error(
            manual ? "Alias deletion was not confirmed" : "Host hide was not confirmed",
          );
        }
        if (manual && this.optionsValue.hostInUse?.(entry.profile.id)) {
          throw new TermLoomError({
            code: "WORKSPACE_INVALID",
            message: `Host ${entry.profile.id} is still referenced by an open workspace`,
          });
        }
        const next = structuredClone(this.config);
        if (manual) next.hosts = next.hosts.filter((host) => host.id !== entry.profile.id);
        else upsertHostMetadata(next, { ...entry.profile, hidden: true });
        await this.saveConfig(next);
      },
    );
  }

  private openContextMenu(entry: SidebarEntry): void {
    const actions: ContextAction[] = [];
    if (entry.kind === "host") {
      if (entry.profile.source === "missing") {
        actions.push({
          label: "Remap SSH alias…",
          run: () => this.promptRemapAlias(entry.profile),
        });
      } else {
        actions.push({ label: "Open Files", run: () => this.activateEntry(entry) });
        actions.push({
          label: "Edit label and defaults…",
          run: () => this.openHostMetadataForm(entry.profile),
        });
        actions.push({
          label: "New tmux session…",
          run: () => this.promptNewSession(entry.profile),
        });
        actions.push({
          label: "Refresh sessions",
          run: () => this.refreshSessions(entry.profile.id),
        });
      }
      actions.push({
        label: entry.profile.source === "manual" ? "Delete alias…" : "Hide host…",
        run: () => this.deleteSelected(),
      });
    } else if (entry.kind === "session") {
      actions.push({
        label: "Attach",
        run: () => this.optionsValue.onAttachSession?.(entry.profile, entry.session),
      });
      actions.push({
        label: "Open in split",
        run: () => this.optionsValue.onOpenSessionSplit?.(entry.profile, entry.session),
      });
      actions.push({ label: "Rename…", run: () => this.renameSelectedSession() });
      actions.push({ label: "Kill…", run: () => this.deleteSelected() });
    }
    if (actions.length === 0) return;
    this.closeModal();
    const modal = new BoxRenderable(this.ctx, {
      id: `${this.id}-context`,
      position: "absolute",
      left: 1,
      top: "25%",
      width: "90%",
      height: Math.min(12, actions.length * 2 + 2),
      zIndex: 100,
      border: true,
      borderStyle: "double",
      borderColor: theme.accent,
      title: entry.profile.label,
      backgroundColor: theme.surfaceRaised,
    });
    const list = new SelectRenderable(this.ctx, {
      id: `${this.id}-context-list`,
      width: "100%",
      height: "100%",
      options: actions.map((action) => ({ name: action.label, description: "" })),
      showDescription: false,
      selectedBackgroundColor: theme.selection,
      selectedTextColor: theme.foreground,
      backgroundColor: theme.surfaceRaised,
    });
    this.contextActions = actions;
    let executed = false;
    const execute = (action: ContextAction | undefined) => {
      if (!action || executed) return;
      executed = true;
      this.closeModal();
      void Promise.resolve(action.run()).catch((error) => this.showError(error));
    };
    list.on(SelectRenderableEvents.ITEM_SELECTED, () => {
      execute(this.contextActions[list.getSelectedIndex()]);
    });
    this.modalMouseDispose = attachMouseSelect(list, {
      onClick: (index) => {
        execute(this.contextActions[index]);
      },
    });
    modal.add(list);
    this.add(modal);
    this.modal = modal;
    this.modalList = list;
    list.focus();
    this.requestRender();
  }

  private showPrompt(
    title: string,
    initial: string,
    submit: (value: string) => Promise<void> | void,
  ): void {
    this.closeModal();
    const modal = new BoxRenderable(this.ctx, {
      id: `${this.id}-modal`,
      position: "absolute",
      left: 1,
      top: "35%",
      width: "90%",
      height: 5,
      zIndex: 100,
      border: true,
      borderStyle: "double",
      borderColor: theme.accent,
      title,
      padding: 1,
      backgroundColor: theme.surfaceRaised,
    });
    const input = new InputRenderable(this.ctx, {
      id: `${this.id}-modal-input`,
      width: "100%",
      value: initial,
      placeholder: title,
      backgroundColor: theme.surface,
      focusedBackgroundColor: theme.selection,
      textColor: theme.foreground,
      cursorColor: theme.accent,
    });
    input.on(InputRenderableEvents.ENTER, (value: string) => {
      this.closeModal();
      void Promise.resolve(submit(value.trim())).catch((error) => this.showError(error));
    });
    modal.add(input);
    this.add(modal);
    this.modal = modal;
    this.modalInput = input;
    input.focus();
    this.requestRender();
  }

  private openHostMetadataForm(profile: HostProfile): void {
    this.closeModal();
    const form = new HostMetadataFormRenderable(this.ctx, {
      id: `${this.id}-host-form`,
      alias: profile.alias,
      values: {
        label: profile.label,
        defaultPath: profile.defaultPath,
        defaultSession: profile.defaultTmuxSession ?? "",
      },
      onSave: async (values: HostMetadataValues) => {
        const next = structuredClone(this.config);
        upsertHostMetadata(next, {
          ...profile,
          label: values.label,
          defaultPath: values.defaultPath,
          defaultTmuxSession: values.defaultSession || undefined,
        });
        await this.saveConfig(next);
        this.closeModal();
      },
      onClose: () => this.closeModal(),
    });
    this.add(form);
    this.modal = form;
    this.requestRender();
  }

  private promptNewSession(profile: HostProfile): void {
    if (!this.optionsValue.sessions) return;
    this.showPrompt("New tmux session", "work", async (value) => {
      await this.optionsValue.sessions?.create(
        profile.id,
        required(value, "Session name"),
        profile.defaultPath,
      );
      this.expandedHostId = profile.id;
      await this.refreshSessions(profile.id);
    });
  }

  private closeModal(): void {
    const modal = this.modal;
    if (!modal) return;
    this.modal = undefined;
    this.modalInput = undefined;
    this.modalList = undefined;
    this.contextActions = [];
    this.modalMouseDispose?.();
    this.modalMouseDispose = undefined;
    if (modal.parent === this) this.remove(modal);
    if (!modal.isDestroyed) modal.destroyRecursively();
    if (!this.isDestroyed) this.list.focus();
    this.requestRender();
  }

  private async saveConfig(next: TermLoomConfig): Promise<void> {
    if (!this.optionsValue.saveConfig) throw new Error("Configuration is read-only");
    this.config = await this.optionsValue.saveConfig(next);
    const snapshot = await this.optionsValue.catalog.refresh(this.config);
    this.optionsValue.onCatalogChange?.(snapshot);
    this.rebuildEntries();
  }

  private showError(error: unknown): void {
    this.footer.content = `Host tree: ${errorMessage(error)}`;
    this.footer.fg = theme.error;
    this.requestRender();
  }
}

function entryOption(entry: SidebarEntry): { name: string; description: string } {
  if (entry.kind === "host") {
    return {
      name: `${connectionMarker(entry.profile)} ${entry.profile.label}`,
      description: `${entry.profile.alias} · ${sourceLabel(entry.profile)}`,
    };
  }
  if (entry.kind === "session") {
    return {
      name: `  ${entry.session.attachedClients > 0 ? "●" : "○"} ${entry.session.name}`,
      description: `  ${entry.session.windows} windows · ${entry.session.attachedClients} attached`,
    };
  }
  if (entry.kind === "loading") return { name: "  ◌ Loading tmux sessions…", description: "" };
  return { name: "  ! Session discovery failed", description: entry.message };
}

function connectionMarker(profile: HostProfile): string {
  switch (profile.connectionStatus) {
    case "connected":
      return "●";
    case "authenticating":
      return "◐";
    case "resolving":
    case "reconnecting":
      return "◌";
    case "error":
      return "!";
    default:
      return "○";
  }
}

function sourceLabel(profile: HostProfile): string {
  if (profile.source === "ssh-config") return "SSH Config";
  if (profile.source === "missing") return "SSH alias missing";
  return "Manual alias";
}

function entryHostId(entry: SidebarEntry): string {
  return entry.profile.id;
}

function required(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function upsertHostMetadata(config: TermLoomConfig, profile: HostProfile): void {
  const metadata = metadataForProfile(profile);
  const index = config.hosts.findIndex(
    (host) => host.alias.toLocaleLowerCase() === profile.alias.toLocaleLowerCase(),
  );
  if (index >= 0) config.hosts[index] = metadata;
  else config.hosts.push(metadata);
}
