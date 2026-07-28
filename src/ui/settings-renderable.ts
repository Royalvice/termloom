import {
  BoxRenderable,
  InputRenderable,
  InputRenderableEvents,
  type KeyEvent,
  type RenderContext,
  SelectRenderable,
  TextAttributes,
  TextRenderable,
} from "@opentui/core";
import { TermLoomConfigSchema, type TermLoomConfig } from "../config/schema.js";
import { errorMessage } from "../core/errors.js";
import type { I18n } from "../i18n/i18n.js";
import { theme } from "./theme.js";

export interface SettingsRenderableOptions {
  id: string;
  config: TermLoomConfig;
  i18n: I18n;
  save(config: TermLoomConfig): Promise<TermLoomConfig>;
  onSaved?(config: TermLoomConfig): void;
  onClose(): void;
}

interface SettingField {
  path: string;
  read(config: TermLoomConfig): string;
  write(config: TermLoomConfig, value: string): void;
}

export class SettingsRenderable extends BoxRenderable {
  private config: TermLoomConfig;
  private readonly optionsValue: SettingsRenderableOptions;
  private readonly list: SelectRenderable;
  private readonly status: TextRenderable;
  private prompt: BoxRenderable | undefined;
  private input: InputRenderable | undefined;
  private saving = false;

  public constructor(ctx: RenderContext, options: SettingsRenderableOptions) {
    super(ctx, {
      id: options.id,
      position: "absolute",
      left: "10%",
      top: "8%",
      width: "80%",
      height: "84%",
      zIndex: 500,
      flexDirection: "column",
      border: true,
      borderStyle: "double",
      borderColor: theme.accent,
      title: options.i18n.t("settings.title"),
      titleColor: theme.accent,
      padding: 1,
      focusable: true,
      backgroundColor: theme.surfaceRaised,
      overflow: "hidden",
    });
    this.optionsValue = options;
    this.config = structuredClone(options.config);
    this.add(
      new TextRenderable(ctx, {
        id: `${options.id}-header`,
        width: "100%",
        height: 2,
        content: options.i18n.t("settings.help"),
        fg: theme.foreground,
        attributes: TextAttributes.BOLD,
      }),
    );
    this.list = new SelectRenderable(ctx, {
      id: `${options.id}-list`,
      width: "100%",
      flexGrow: 1,
      options: [],
      showDescription: true,
      showScrollIndicator: true,
      wrapSelection: true,
      backgroundColor: theme.surfaceRaised,
      textColor: theme.foreground,
      selectedBackgroundColor: theme.selection,
      selectedTextColor: theme.foreground,
      descriptionColor: theme.muted,
      selectedDescriptionColor: theme.foreground,
    });
    this.status = new TextRenderable(ctx, {
      id: `${options.id}-status`,
      width: "100%",
      height: 2,
      content: options.i18n.t("settings.shortcuts"),
      fg: theme.muted,
      attributes: TextAttributes.DIM,
    });
    this.add(this.list);
    this.add(this.status);
    this.refresh();
  }

  public override handleKeyPress(key: KeyEvent): boolean {
    if (this.input) {
      if (key.name === "escape") {
        this.closePrompt();
        return true;
      }
      return false;
    }
    if (key.eventType === "release") return false;
    if (key.name === "escape" || (key.name === "q" && !key.ctrl && !key.meta)) {
      this.optionsValue.onClose();
      return true;
    }
    if (key.name === "up" || key.name === "k") {
      this.list.moveUp();
      return true;
    }
    if (key.name === "down" || key.name === "j") {
      this.list.moveDown();
      return true;
    }
    if (key.name === "return") {
      this.editSelected();
      return true;
    }
    return false;
  }

  public inspectConfig(): TermLoomConfig {
    return structuredClone(this.config);
  }

  protected override destroySelf(): void {
    this.closePrompt();
    super.destroySelf();
  }

  private refresh(): void {
    this.list.options = settingFields.map((field) => ({
      name: field.path,
      description: field.read(this.config),
      value: field.path,
    }));
    this.requestRender();
  }

  private editSelected(): void {
    if (this.saving) return;
    const index = this.list.getSelectedIndex();
    const field = settingFields[index];
    if (!field) return;
    this.showPrompt(field.path, field.read(this.config), async (value) => {
      const candidate = structuredClone(this.config);
      field.write(candidate, value);
      const validated = TermLoomConfigSchema.parse(candidate);
      this.saving = true;
      this.status.content = this.optionsValue.i18n.t("settings.saving");
      this.status.fg = theme.warning;
      try {
        this.config = await this.optionsValue.save(validated);
        this.optionsValue.onSaved?.(this.config);
        this.refresh();
        this.status.content = this.optionsValue.i18n.t("settings.saved");
        this.status.fg = theme.success;
      } finally {
        this.saving = false;
      }
    });
  }

  private showPrompt(
    title: string,
    initial: string,
    submit: (value: string) => Promise<void>,
  ): void {
    this.closePrompt();
    const prompt = new BoxRenderable(this.ctx, {
      id: `${this.id}-prompt`,
      position: "absolute",
      left: "10%",
      top: "40%",
      width: "80%",
      height: 5,
      zIndex: 600,
      border: true,
      borderStyle: "double",
      borderColor: theme.accentSecondary,
      title,
      padding: 1,
      backgroundColor: theme.surface,
    });
    const input = new InputRenderable(this.ctx, {
      id: `${this.id}-input`,
      width: "100%",
      value: initial,
      placeholder: title,
      backgroundColor: theme.surface,
      focusedBackgroundColor: theme.selection,
      textColor: theme.foreground,
      cursorColor: theme.accent,
    });
    input.on(InputRenderableEvents.ENTER, (value: string) => {
      this.closePrompt();
      void submit(value.trim()).catch((error) => {
        this.status.content = this.optionsValue.i18n.t("settings.error", {
          message: errorMessage(error),
        });
        this.status.fg = theme.error;
        this.requestRender();
      });
    });
    prompt.add(input);
    this.add(prompt);
    this.prompt = prompt;
    this.input = input;
    input.focus();
    this.requestRender();
  }

  private closePrompt(): void {
    if (!this.prompt) return;
    this.remove(this.prompt);
    this.prompt.destroyRecursively();
    this.prompt = undefined;
    this.input = undefined;
    if (!this.isDestroyed) super.focus();
    this.requestRender();
  }
}

const settingFields: readonly SettingField[] = [
  enumField(
    "ui.locale",
    (config) => config.ui.locale,
    (config, value) => (config.ui.locale = value as TermLoomConfig["ui"]["locale"]),
  ),
  enumField(
    "ui.theme",
    (config) => config.ui.theme,
    (config, value) => (config.ui.theme = value as TermLoomConfig["ui"]["theme"]),
  ),
  numberField(
    "ui.sidebarWidth",
    (config) => config.ui.sidebarWidth,
    (config, value) => (config.ui.sidebarWidth = value),
  ),
  textField(
    "ui.leader",
    (config) => config.ui.leader,
    (config, value) => (config.ui.leader = value),
  ),
  numberField(
    "ssh.controlPersistSeconds",
    (config) => config.ssh.controlPersistSeconds,
    (config, value) => (config.ssh.controlPersistSeconds = value),
  ),
  numberField(
    "ssh.connectTimeoutSeconds",
    (config) => config.ssh.connectTimeoutSeconds,
    (config, value) => (config.ssh.connectTimeoutSeconds = value),
  ),
  numberField(
    "ssh.serverAliveInterval",
    (config) => config.ssh.serverAliveInterval,
    (config, value) => (config.ssh.serverAliveInterval = value),
  ),
  numberField(
    "ssh.serverAliveCountMax",
    (config) => config.ssh.serverAliveCountMax,
    (config, value) => (config.ssh.serverAliveCountMax = value),
  ),
  booleanField(
    "reconnect.enabled",
    (config) => config.reconnect.enabled,
    (config, value) => (config.reconnect.enabled = value),
  ),
  numberField(
    "reconnect.initialDelayMs",
    (config) => config.reconnect.initialDelayMs,
    (config, value) => (config.reconnect.initialDelayMs = value),
  ),
  numberField(
    "reconnect.maxDelayMs",
    (config) => config.reconnect.maxDelayMs,
    (config, value) => (config.reconnect.maxDelayMs = value),
  ),
  numberField(
    "reconnect.multiplier",
    (config) => config.reconnect.multiplier,
    (config, value) => (config.reconnect.multiplier = value),
  ),
  numberField(
    "reconnect.jitter",
    (config) => config.reconnect.jitter,
    (config, value) => (config.reconnect.jitter = value),
  ),
  enumField(
    "media.adapter",
    (config) => config.media.adapter,
    (config, value) => (config.media.adapter = value as TermLoomConfig["media"]["adapter"]),
  ),
  numberField(
    "media.videoFps",
    (config) => config.media.videoFps,
    (config, value) => (config.media.videoFps = value),
  ),
  numberField(
    "media.maxCacheBytes",
    (config) => config.media.maxCacheBytes,
    (config, value) => (config.media.maxCacheBytes = value),
  ),
  booleanField(
    "media.autoplayGif",
    (config) => config.media.autoplayGif,
    (config, value) => (config.media.autoplayGif = value),
  ),
  {
    path: "permissions.allowedHttpDomains",
    read: (config) => config.permissions.allowedHttpDomains.join(","),
    write: (config, value) => {
      config.permissions.allowedHttpDomains = value
        .split(",")
        .map((domain) => domain.trim())
        .filter(Boolean);
    },
  },
];

function textField(
  path: string,
  read: (config: TermLoomConfig) => string,
  write: (config: TermLoomConfig, value: string) => void,
): SettingField {
  return { path, read, write };
}

function enumField(
  path: string,
  read: (config: TermLoomConfig) => string,
  write: (config: TermLoomConfig, value: string) => void,
): SettingField {
  return textField(path, read, write);
}

function numberField(
  path: string,
  read: (config: TermLoomConfig) => number,
  write: (config: TermLoomConfig, value: number) => void,
): SettingField {
  return {
    path,
    read: (config) => String(read(config)),
    write: (config, value) => {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) throw new Error(`${path} must be a number`);
      write(config, parsed);
    },
  };
}

function booleanField(
  path: string,
  read: (config: TermLoomConfig) => boolean,
  write: (config: TermLoomConfig, value: boolean) => void,
): SettingField {
  return {
    path,
    read: (config) => String(read(config)),
    write: (config, value) => {
      if (value !== "true" && value !== "false") throw new Error(`${path} must be true or false`);
      write(config, value === "true");
    },
  };
}
