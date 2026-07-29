import {
  BoxRenderable,
  InputRenderable,
  InputRenderableEvents,
  type KeyEvent,
  MouseButton,
  type RenderContext,
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
import type { WorkspaceTarget } from "../workspace/schema.js";
import type { ContextMenuAction, ContextMenuRequest } from "./dismissible-overlay-controller.js";
import {
  HostMetadataFormRenderable,
  type HostMetadataValues,
} from "./host-metadata-form-renderable.js";
import { attachMouseSelect } from "./mouse-select-adapter.js";
import { theme } from "./theme.js";

export type SidebarSection = "hosts";

export interface SidebarRenderableOptions {
  id: string;
  config: TermLoomConfig;
  catalog: HostCatalog;
  i18n: I18n;
  saveConfig?: (config: TermLoomConfig) => Promise<TermLoomConfig>;
  hostInUse?: (hostId: string) => boolean;
  onSelectLocal?: () => void;
  onSelectHost?: (profile: HostProfile) => void;
  onCollapse?: () => void;
  onCatalogChange?: (snapshot: HostCatalogSnapshot) => void;
  onContextMenu?: (request: ContextMenuRequest, restoreFocus: () => void) => void;
}

type SidebarEntry = { kind: "local" } | { kind: "host"; profile: HostProfile };

export class SidebarRenderable extends BoxRenderable {
  private config: TermLoomConfig;
  private readonly optionsValue: SidebarRenderableOptions;
  private readonly search: InputRenderable;
  private readonly list: SelectRenderable;
  private readonly footer: TextRenderable;
  private entries: readonly SidebarEntry[] = [];
  private selectedTarget: WorkspaceTarget = { kind: "local" };
  private query = "";
  private modal: BoxRenderable | undefined;
  private modalInput: InputRenderable | undefined;
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
    this.add(this.createToolbar(ctx));
    this.search = new InputRenderable(ctx, {
      id: `${options.id}-search`,
      width: "100%",
      value: "",
      placeholder: "Search SSH hosts…",
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
      if (selected) this.activateEntry(selected);
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
    this.list.on(SelectRenderableEvents.SELECTION_CHANGED, () => this.rememberSelection());
    this.list.on(SelectRenderableEvents.ITEM_SELECTED, () => {
      const entry = this.selectedEntry();
      if (entry) this.activateEntry(entry);
    });
    this.disposeMouse = attachMouseSelect(this.list, {
      onClick: (index) => {
        const entry = this.entries[index];
        if (entry) this.activateEntry(entry);
      },
      onDoubleClick: (index) => {
        const entry = this.entries[index];
        if (entry) this.activateEntry(entry);
      },
      onContextMenu: (index, event) => {
        const entry = this.entries[index];
        if (entry) this.openContextMenu(entry, event.x, event.y);
      },
    });
    this.add(this.list);
    this.footer = new TextRenderable(ctx, {
      id: `${options.id}-footer`,
      width: "100%",
      height: 1,
      content: "Local",
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

  public syncActiveTarget(target: WorkspaceTarget): void {
    this.selectedTarget = structuredClone(target);
    this.rebuildEntries();
  }

  public async syncActiveHost(hostId: string): Promise<void> {
    this.syncActiveTarget({ kind: "ssh", hostId });
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
      const selectedHostId =
        this.selectedTarget.kind === "ssh" ? this.selectedTarget.hostId : undefined;
      if (selectedHostId && !snapshot.profiles.some((profile) => profile.id === selectedHostId)) {
        this.selectedTarget = { kind: "local" };
      }
      this.rebuildEntries();
    } catch (error) {
      this.showError(error);
    }
  }

  public override handleKeyPress(key: KeyEvent): boolean {
    if (this.modalInput) {
      if (key.eventType !== "release" && key.name === "escape") {
        this.closeModal();
        return true;
      }
      return false;
    }
    if (key.eventType === "release" || key.ctrl || key.meta || key.super) return false;
    if (key.name === "up" || key.name === "k") {
      this.list.moveUp();
      this.rememberSelection();
      return true;
    }
    if (key.name === "down" || key.name === "j") {
      this.list.moveDown();
      this.rememberSelection();
      return true;
    }
    if (key.name === "return") {
      const entry = this.selectedEntry();
      if (entry) this.activateEntry(entry);
      return true;
    }
    if (key.name === "/") {
      this.search.focus();
      return true;
    }
    if (key.name === "r") {
      void this.refreshCatalog();
      return true;
    }
    if (key.name === "n") {
      this.promptAddAlias();
      return true;
    }
    return false;
  }

  protected override destroySelf(): void {
    this.disposeMouse();
    this.closeModal();
    super.destroySelf();
  }

  private createToolbar(ctx: RenderContext): BoxRenderable {
    const toolbar = new BoxRenderable(ctx, {
      id: `${this.optionsValue.id}-toolbar`,
      width: "100%",
      height: 1,
      flexDirection: "row",
      justifyContent: "flex-end",
      backgroundColor: theme.surfaceRaised,
    });
    toolbar.add(this.toolbarButton(ctx, "refresh", " ↻ ", () => void this.refreshCatalog()));
    toolbar.add(this.toolbarButton(ctx, "add", " + ", () => this.promptAddAlias()));
    toolbar.add(
      this.toolbarButton(ctx, "actions", " ⋯ ", () => {
        const entry = this.selectedEntry();
        if (entry) this.openContextMenu(entry, this.list.x + 2, this.list.y + 1);
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
    this.entries = [
      { kind: "local" },
      ...profiles.map((profile) => ({ kind: "host", profile }) as const),
    ];
    this.list.options = this.entries.map((entry) => entryOption(entry));
    const selectedIndex = this.entries.findIndex((entry) =>
      this.selectedTarget.kind === "local"
        ? entry.kind === "local"
        : entry.kind === "host" && entry.profile.id === this.selectedTarget.hostId,
    );
    this.list.setSelectedIndex(Math.max(0, selectedIndex));
    const discoveryError = this.optionsValue.catalog.snapshot().errors[0];
    if (discoveryError) {
      this.footer.content = `SSH config: ${discoveryError.message}`;
      this.footer.fg = theme.error;
    } else {
      this.footer.content = ` Local · ${profiles.length} SSH host${profiles.length === 1 ? "" : "s"}`;
      this.footer.fg = theme.muted;
    }
    this.requestRender();
  }

  private activateEntry(entry: SidebarEntry): void {
    if (entry.kind === "local") {
      this.selectedTarget = { kind: "local" };
      this.optionsValue.onSelectLocal?.();
      this.rebuildEntries();
      return;
    }
    this.selectedTarget = { kind: "ssh", hostId: entry.profile.id };
    if (entry.profile.source === "missing") this.promptRemapAlias(entry.profile);
    else this.optionsValue.onSelectHost?.(entry.profile);
    this.rebuildEntries();
  }

  private rememberSelection(): void {
    const entry = this.selectedEntry();
    if (!entry) return;
    this.selectedTarget =
      entry.kind === "local" ? { kind: "local" } : { kind: "ssh", hostId: entry.profile.id };
  }

  private selectedEntry(): SidebarEntry | undefined {
    return this.entries[this.list.getSelectedIndex()];
  }

  private openContextMenu(entry: SidebarEntry, x: number, y: number): void {
    if (!this.optionsValue.onContextMenu) return;
    const actions: ContextMenuAction[] = [];
    if (entry.kind === "local") {
      actions.push({ id: "open", label: "Open Local Files", run: () => this.activateEntry(entry) });
    } else if (entry.profile.source === "missing") {
      actions.push({
        id: "remap",
        label: "Remap SSH Alias…",
        run: () => this.promptRemapAlias(entry.profile),
      });
    } else {
      actions.push({ id: "open", label: "Open Files", run: () => this.activateEntry(entry) });
      actions.push({
        id: "edit",
        label: "Edit Label and Defaults…",
        run: () => this.openHostMetadataForm(entry.profile),
      });
      actions.push({
        id: "hide",
        label: entry.profile.source === "manual" ? "Remove Alias…" : "Hide Host…",
        run: () => this.removeOrHide(entry.profile),
      });
    }
    this.optionsValue.onContextMenu(
      {
        x,
        y,
        title: entry.kind === "local" ? "Local" : entry.profile.label,
        actions,
      },
      () => this.list.focus(),
    );
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
      if (profile) this.activateEntry({ kind: "host", profile });
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
      if (remapped) this.activateEntry({ kind: "host", profile: remapped });
    });
  }

  private removeOrHide(profile: HostProfile): void {
    this.showPrompt(
      profile.source === "manual"
        ? "Type REMOVE to remove this alias"
        : "Type HIDE to hide this SSH Config host",
      "",
      async (value) => {
        const manual = profile.source === "manual";
        if ((manual && value !== "REMOVE") || (!manual && value !== "HIDE")) {
          throw new Error(
            manual ? "Alias removal was not confirmed" : "Host hide was not confirmed",
          );
        }
        if (manual && this.optionsValue.hostInUse?.(profile.id)) {
          throw new TermLoomError({
            code: "WORKSPACE_INVALID",
            message: `Host ${profile.id} is still referenced by an open workspace`,
          });
        }
        const next = structuredClone(this.config);
        if (manual) next.hosts = next.hosts.filter((host) => host.id !== profile.id);
        else upsertHostMetadata(next, { ...profile, hidden: true });
        await this.saveConfig(next);
        this.selectedTarget = { kind: "local" };
        this.optionsValue.onSelectLocal?.();
      },
    );
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

  private closeModal(): void {
    const modal = this.modal;
    if (!modal) return;
    this.modal = undefined;
    this.modalInput = undefined;
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
    this.footer.content = `Endpoints: ${errorMessage(error)}`;
    this.footer.fg = theme.error;
    this.requestRender();
  }
}

function entryOption(entry: SidebarEntry): { name: string; description: string } {
  if (entry.kind === "local") {
    return { name: "● Local", description: "This Mac" };
  }
  return {
    name: `${connectionMarker(entry.profile)} ${entry.profile.label}`,
    description: `${entry.profile.alias} · ${sourceLabel(entry.profile)}`,
  };
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
