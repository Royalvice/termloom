import {
  BoxRenderable,
  InputRenderable,
  InputRenderableEvents,
  type KeyEvent,
  SelectRenderable,
  SelectRenderableEvents,
  TextAttributes,
  TextRenderable,
  type RenderContext,
} from "@opentui/core";
import type { TermLoomConfig } from "../config/schema.js";
import { errorMessage, TermLoomError } from "../core/errors.js";
import type { I18n } from "../i18n/i18n.js";
import type { TmuxSessionInfo } from "../tmux/tmux-service.js";
import { theme } from "./theme.js";

export type SidebarSection = "hosts" | "sessions" | "files";

export interface SidebarSessionService {
  list(hostId: string): Promise<readonly TmuxSessionInfo[]>;
  create(hostId: string, name: string, cwd?: string): Promise<void>;
  rename(hostId: string, currentName: string, nextName: string): Promise<void>;
  kill(hostId: string, name: string): Promise<void>;
}

export interface SidebarRenderableOptions {
  id: string;
  config: TermLoomConfig;
  section: SidebarSection;
  i18n: I18n;
  sessions?: SidebarSessionService;
  saveConfig?: (config: TermLoomConfig) => Promise<TermLoomConfig>;
  hostInUse?: (hostId: string) => boolean;
  onSectionChange?: (section: SidebarSection) => void;
  onOpenTerminal?: (hostId: string, tmuxSession?: string) => void;
  onOpenFiles?: (hostId: string, path: string) => void;
}

type SidebarEntry =
  | { kind: "host"; hostId: string }
  | { kind: "session"; hostId: string; session: TmuxSessionInfo }
  | { kind: "files"; hostId: string; path: string };

interface PromptField {
  key:
    | "sidebar.hostId"
    | "sidebar.hostAlias"
    | "sidebar.hostLabel"
    | "sidebar.hostPath"
    | "sidebar.hostSession";
  initial: string;
}

export class SidebarRenderable extends BoxRenderable {
  private config: TermLoomConfig;
  private section: SidebarSection;
  private readonly optionsValue: SidebarRenderableOptions;
  private readonly header: TextRenderable;
  private readonly list: SelectRenderable;
  private readonly footer: TextRenderable;
  private entries: readonly SidebarEntry[] = [];
  private sessions: readonly TmuxSessionInfo[] = [];
  private selectedHostId: string | undefined;
  private modal: BoxRenderable | undefined;
  private modalInput: InputRenderable | undefined;
  private refreshGeneration = 0;

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
    this.section = options.section;
    this.selectedHostId = this.config.hosts[0]?.id;
    this.header = new TextRenderable(ctx, {
      id: `${options.id}-header`,
      width: "100%",
      height: 2,
      content: "",
      fg: theme.accent,
      attributes: TextAttributes.BOLD,
    });
    this.list = new SelectRenderable(ctx, {
      id: `${options.id}-list`,
      width: "100%",
      flexGrow: 1,
      options: [],
      showDescription: true,
      showScrollIndicator: true,
      wrapSelection: true,
      backgroundColor: theme.surface,
      textColor: theme.foreground,
      selectedBackgroundColor: theme.selection,
      selectedTextColor: theme.foreground,
      descriptionColor: theme.muted,
      selectedDescriptionColor: theme.foreground,
    });
    this.footer = new TextRenderable(ctx, {
      id: `${options.id}-footer`,
      width: "100%",
      height: 3,
      content: "",
      fg: theme.muted,
      attributes: TextAttributes.DIM,
    });
    this.add(this.header);
    this.add(this.list);
    this.add(this.footer);
    this.list.on(SelectRenderableEvents.SELECTION_CHANGED, () => this.rememberHost());
    this.list.on(SelectRenderableEvents.ITEM_SELECTED, () => void this.openSelected());
    void this.refresh();
  }

  public setConfig(config: TermLoomConfig): void {
    this.config = structuredClone(config);
    if (!this.config.hosts.some((host) => host.id === this.selectedHostId)) {
      this.selectedHostId = this.config.hosts[0]?.id;
    }
    void this.refresh();
  }

  public setSection(section: SidebarSection, focus = false, notify = true): void {
    const changed = this.section !== section;
    this.section = section;
    if (changed && notify) this.optionsValue.onSectionChange?.(section);
    if (changed) void this.refresh();
    if (focus) this.focus();
  }

  public currentSection(): SidebarSection {
    return this.section;
  }

  public override handleKeyPress(key: KeyEvent): boolean {
    if (this.modalInput) {
      if (key.name === "escape") {
        this.closePrompt();
        return true;
      }
      return false;
    }
    if (key.ctrl || key.meta || key.super || key.eventType === "release") return false;
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
    if (key.name === "left") {
      this.setSection(relativeSection(this.section, -1), true);
      return true;
    }
    if (key.name === "right") {
      this.setSection(relativeSection(this.section, 1), true);
      return true;
    }
    if (key.name === "return") {
      void this.openSelected();
      return true;
    }
    if (key.name === "r" && !key.shift) {
      void this.refresh();
      return true;
    }
    if (key.name === "n" && !key.shift) {
      this.createSelectedKind();
      return true;
    }
    if (key.name === "r" && key.shift) {
      this.renameSelected();
      return true;
    }
    if (key.name === "d") {
      this.deleteSelected();
      return true;
    }
    if (key.name === "f" && this.section === "hosts") {
      const host = this.selectedHost();
      if (host) this.optionsValue.onOpenFiles?.(host.id, host.defaultPath);
      return true;
    }
    if (key.name === "s" && this.section === "hosts") {
      this.rememberHost();
      this.setSection("sessions", true);
      return true;
    }
    if (key.name === "p" && this.section === "files") {
      const host = this.selectedHost();
      if (host) {
        this.showPrompt("sidebar.remotePath", host.defaultPath, (path) => {
          this.optionsValue.onOpenFiles?.(host.id, required(path, "Remote path"));
        });
      }
      return true;
    }
    return false;
  }

  public async refresh(): Promise<void> {
    const generation = ++this.refreshGeneration;
    this.header.content = this.headerText(true);
    this.footer.content = this.optionsValue.i18n.t("sidebar.loading");
    this.footer.fg = theme.muted;
    this.requestRender();
    try {
      if (this.section === "sessions") {
        const hostId = this.selectedHostId ?? this.config.hosts[0]?.id;
        this.sessions =
          hostId && this.optionsValue.sessions ? await this.optionsValue.sessions.list(hostId) : [];
      }
      if (generation !== this.refreshGeneration || this.isDestroyed) return;
      this.rebuildEntries();
      this.header.content = this.headerText(false);
      this.footer.content = this.shortcutText();
      this.footer.fg = theme.muted;
    } catch (error) {
      if (generation !== this.refreshGeneration || this.isDestroyed) return;
      this.showError(error);
    }
    this.requestRender();
  }

  protected override destroySelf(): void {
    this.refreshGeneration += 1;
    this.closePrompt();
    super.destroySelf();
  }

  private rebuildEntries(): void {
    if (this.section === "hosts") {
      this.entries = this.config.hosts.map((host) => ({ kind: "host", hostId: host.id }));
      this.list.options = this.entries.length
        ? this.entries.map((entry) => {
            const host = this.config.hosts.find((candidate) => candidate.id === entry.hostId);
            return {
              name: `◇ ${host?.label ?? host?.id ?? entry.hostId}`,
              description: `${host?.alias ?? ""}  ${host?.defaultPath ?? ""}`,
              value: entry,
            };
          })
        : [emptyOption(this.optionsValue.i18n.t("empty.hosts"))];
    } else if (this.section === "sessions") {
      const hostId = this.selectedHostId ?? "";
      this.entries = this.sessions.map((session) => ({ kind: "session", hostId, session }));
      this.list.options = this.entries.length
        ? this.entries.map((entry) => {
            if (entry.kind !== "session") throw new Error("Expected session entry");
            return {
              name: `${entry.session.attachedClients > 0 ? "●" : "○"} ${entry.session.name}`,
              description: this.optionsValue.i18n.t("sidebar.sessionDescription", {
                windows: entry.session.windows,
                attached: entry.session.attachedClients,
              }),
              value: entry,
            };
          })
        : [emptyOption(this.optionsValue.i18n.t("empty.sessions"))];
    } else {
      this.entries = this.config.hosts.map((host) => ({
        kind: "files",
        hostId: host.id,
        path: host.defaultPath,
      }));
      this.list.options = this.entries.length
        ? this.entries.map((entry) => ({
            name: `▣ ${entry.hostId}`,
            description: entry.kind === "files" ? entry.path : "",
            value: entry,
          }))
        : [emptyOption(this.optionsValue.i18n.t("empty.files"))];
    }
    const selected = this.entries.findIndex((entry) => entry.hostId === this.selectedHostId);
    this.list.setSelectedIndex(Math.max(0, selected));
  }

  private async openSelected(): Promise<void> {
    const entry = this.selectedEntry();
    if (!entry) return;
    this.selectedHostId = entry.hostId;
    if (entry.kind === "session") {
      this.optionsValue.onOpenTerminal?.(entry.hostId, entry.session.name);
    } else if (entry.kind === "files") {
      this.optionsValue.onOpenFiles?.(entry.hostId, entry.path);
    } else {
      const host = this.config.hosts.find((candidate) => candidate.id === entry.hostId);
      if (host) this.optionsValue.onOpenTerminal?.(host.id, host.defaultTmuxSession);
    }
  }

  private createSelectedKind(): void {
    if (this.section === "hosts") {
      this.promptHost(undefined);
      return;
    }
    if (this.section === "sessions") {
      const host = this.selectedHost();
      if (!host || !this.optionsValue.sessions) return;
      this.showPrompt("sidebar.sessionName", "work", async (name) => {
        await this.optionsValue.sessions?.create(
          host.id,
          required(name, "Session name"),
          host.defaultPath,
        );
        await this.refresh();
      });
      return;
    }
    const host = this.selectedHost();
    if (host) {
      this.showPrompt("sidebar.remotePath", host.defaultPath, (path) => {
        this.optionsValue.onOpenFiles?.(host.id, required(path, "Remote path"));
      });
    }
  }

  private renameSelected(): void {
    const entry = this.selectedEntry();
    if (entry?.kind === "host") {
      const host = this.config.hosts.find((candidate) => candidate.id === entry.hostId);
      if (host) this.promptHost(host.id);
      return;
    }
    if (entry?.kind === "session" && this.optionsValue.sessions) {
      this.showPrompt("sidebar.sessionRename", entry.session.name, async (nextName) => {
        await this.optionsValue.sessions?.rename(
          entry.hostId,
          entry.session.name,
          required(nextName, "Session name"),
        );
        await this.refresh();
      });
    }
  }

  private deleteSelected(): void {
    const entry = this.selectedEntry();
    if (!entry || entry.kind === "files") return;
    this.showPrompt("sidebar.deleteConfirm", "", async (confirmation) => {
      if (confirmation !== "DELETE") throw new Error("Deletion was not confirmed");
      if (entry.kind === "session") {
        await this.optionsValue.sessions?.kill(entry.hostId, entry.session.name);
        await this.refresh();
        return;
      }
      if (this.optionsValue.hostInUse?.(entry.hostId)) {
        throw new TermLoomError({
          code: "WORKSPACE_INVALID",
          message: `Host ${entry.hostId} is still referenced by an open pane`,
        });
      }
      const next = structuredClone(this.config);
      next.hosts = next.hosts.filter((host) => host.id !== entry.hostId);
      await this.saveConfig(next);
    });
  }

  private promptHost(editingId: string | undefined): void {
    const existing = editingId
      ? this.config.hosts.find((candidate) => candidate.id === editingId)
      : undefined;
    const fields: PromptField[] = [
      { key: "sidebar.hostId", initial: existing?.id ?? "" },
      { key: "sidebar.hostAlias", initial: existing?.alias ?? "" },
      { key: "sidebar.hostLabel", initial: existing?.label ?? "" },
      { key: "sidebar.hostPath", initial: existing?.defaultPath ?? "." },
      { key: "sidebar.hostSession", initial: existing?.defaultTmuxSession ?? "" },
    ];
    this.promptFields(fields, async ([id, alias, label, defaultPath, defaultTmuxSession]) => {
      const next = structuredClone(this.config);
      const host = {
        id: required(id, "Host id"),
        alias: required(alias, "SSH alias"),
        ...(label ? { label } : {}),
        defaultPath: required(defaultPath, "Default path"),
        ...(defaultTmuxSession ? { defaultTmuxSession } : {}),
      };
      if (editingId) {
        if (host.id !== editingId && this.optionsValue.hostInUse?.(editingId)) {
          throw new Error("A host referenced by an open pane cannot change id");
        }
        const index = next.hosts.findIndex((candidate) => candidate.id === editingId);
        if (index < 0) throw new Error(`Host ${editingId} no longer exists`);
        next.hosts[index] = host;
      } else {
        next.hosts.push(host);
      }
      this.selectedHostId = host.id;
      await this.saveConfig(next);
    });
  }

  private promptFields(
    fields: readonly PromptField[],
    complete: (values: readonly string[]) => Promise<void>,
    index = 0,
    values: readonly string[] = [],
  ): void {
    const field = fields[index];
    if (!field) {
      void complete(values).catch((error) => this.showError(error));
      return;
    }
    this.showPrompt(field.key, field.initial, (value) => {
      const next = [...values, value];
      if (index + 1 < fields.length) this.promptFields(fields, complete, index + 1, next);
      else return complete(next);
    });
  }

  private async saveConfig(next: TermLoomConfig): Promise<void> {
    if (!this.optionsValue.saveConfig) throw new Error("Configuration is read-only");
    this.config = await this.optionsValue.saveConfig(next);
    if (!this.config.hosts.some((host) => host.id === this.selectedHostId)) {
      this.selectedHostId = this.config.hosts[0]?.id;
    }
    await this.refresh();
  }

  private selectedEntry(): SidebarEntry | undefined {
    return this.entries[this.list.getSelectedIndex()];
  }

  private selectedHost() {
    const entry = this.selectedEntry();
    const hostId = entry?.hostId ?? this.selectedHostId;
    return this.config.hosts.find((host) => host.id === hostId);
  }

  private rememberHost(): void {
    const hostId = this.selectedEntry()?.hostId;
    if (hostId) this.selectedHostId = hostId;
  }

  private headerText(loading: boolean): string {
    const marker = (section: SidebarSection, label: string) =>
      `${section === this.section ? "▸" : " "}${label}`;
    const suffix = loading ? `  ${this.optionsValue.i18n.t("sidebar.loading")}` : "";
    return `${marker("hosts", `1 ${this.optionsValue.i18n.t("sidebar.hosts")}`)}  ${marker(
      "sessions",
      `2 ${this.optionsValue.i18n.t("sidebar.sessions")}`,
    )}  ${marker("files", `3 ${this.optionsValue.i18n.t("sidebar.files")}`)}${suffix}`;
  }

  private shortcutText(): string {
    if (this.section === "hosts") return this.optionsValue.i18n.t("sidebar.hostShortcuts");
    if (this.section === "sessions") return this.optionsValue.i18n.t("sidebar.sessionShortcuts");
    return this.optionsValue.i18n.t("sidebar.fileShortcuts");
  }

  private showPrompt(
    key: Parameters<I18n["t"]>[0],
    initial: string,
    submit: (value: string) => Promise<void> | void,
  ): void {
    this.closePrompt();
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
      title: this.optionsValue.i18n.t(key),
      padding: 1,
      backgroundColor: theme.surfaceRaised,
    });
    const input = new InputRenderable(this.ctx, {
      id: `${this.id}-modal-input`,
      width: "100%",
      value: initial,
      placeholder: this.optionsValue.i18n.t(key),
      backgroundColor: theme.surface,
      focusedBackgroundColor: theme.selection,
      textColor: theme.foreground,
      cursorColor: theme.accent,
    });
    input.on(InputRenderableEvents.ENTER, (value: string) => {
      this.closePrompt();
      void Promise.resolve(submit(value.trim())).catch((error) => this.showError(error));
    });
    modal.add(input);
    this.add(modal);
    this.modal = modal;
    this.modalInput = input;
    input.focus();
    this.requestRender();
  }

  private closePrompt(): void {
    if (!this.modal) return;
    this.remove(this.modal);
    this.modal.destroyRecursively();
    this.modal = undefined;
    this.modalInput = undefined;
    if (!this.isDestroyed) super.focus();
    this.requestRender();
  }

  private showError(error: unknown): void {
    this.footer.content = this.optionsValue.i18n.t("sidebar.error", {
      message: errorMessage(error),
    });
    this.footer.fg = theme.error;
    this.requestRender();
  }
}

function relativeSection(section: SidebarSection, offset: number): SidebarSection {
  const sections: readonly SidebarSection[] = ["hosts", "sessions", "files"];
  const index = sections.indexOf(section);
  return sections[(index + offset + sections.length) % sections.length] ?? "hosts";
}

function emptyOption(name: string) {
  return { name, description: "", value: undefined };
}

function required(value: string | undefined, label: string): string {
  if (value) return value;
  throw new Error(`${label} is required`);
}
