import {
  BoxRenderable,
  InputRenderable,
  InputRenderableEvents,
  type KeyEvent,
  MouseButton,
  type RenderContext,
  SelectRenderable,
  SelectRenderableEvents,
  SliderRenderable,
  TextAttributes,
  TextRenderable,
} from "@opentui/core";
import { TermLoomConfigSchema, type TermLoomConfig } from "../config/schema.js";
import { errorMessage } from "../core/errors.js";
import type { I18n } from "../i18n/i18n.js";
import { attachMouseSelect } from "./mouse-select-adapter.js";
import { theme } from "./theme.js";

export interface SettingsRenderableOptions {
  id: string;
  config: TermLoomConfig;
  i18n: I18n;
  save(config: TermLoomConfig): Promise<TermLoomConfig>;
  confirmSave?(previous: TermLoomConfig, next: TermLoomConfig): string | undefined;
  onSaved?(config: TermLoomConfig): void;
  onClose(): void;
}

type SettingKind = "enum" | "boolean" | "number" | "text" | "domains";

interface SettingField {
  path: string;
  group: string;
  title: string;
  description: string;
  kind: SettingKind;
  read(config: TermLoomConfig): string | number | boolean;
  write(config: TermLoomConfig, value: string | number | boolean): void;
  values?: readonly string[];
  min?: number;
  max?: number;
  step?: number;
}

export class SettingsRenderable extends BoxRenderable {
  private config: TermLoomConfig;
  private original: TermLoomConfig;
  private readonly optionsValue: SettingsRenderableOptions;
  private readonly list: SelectRenderable;
  private readonly status: TextRenderable;
  private editor: BoxRenderable | undefined;
  private editorMouseDispose: (() => void) | undefined;
  private readonly disposeMouse: () => void;
  private saving = false;
  private dirty = false;

  public constructor(ctx: RenderContext, options: SettingsRenderableOptions) {
    super(ctx, {
      id: options.id,
      position: "absolute",
      left: "8%",
      top: "6%",
      width: "84%",
      height: "88%",
      zIndex: 500,
      flexDirection: "column",
      border: true,
      borderStyle: "double",
      borderColor: theme.accent,
      title: ` ${options.i18n.t("settings.title")} `,
      titleColor: theme.accent,
      padding: 1,
      focusable: true,
      backgroundColor: theme.surfaceRaised,
      overflow: "hidden",
    });
    this.optionsValue = options;
    this.config = structuredClone(options.config);
    this.original = structuredClone(options.config);
    this.add(
      new TextRenderable(ctx, {
        id: `${options.id}-header`,
        width: "100%",
        height: 2,
        content: "Grouped settings · click a row or press Enter to edit · changes apply after Save",
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
    this.list.on(SelectRenderableEvents.ITEM_SELECTED, () => this.editSelected());
    this.disposeMouse = attachMouseSelect(this.list, {
      onClick: (index) => {
        this.list.setSelectedIndex(index);
        const field = settingFields[index];
        if (field?.kind === "boolean") this.toggleBoolean(field);
      },
      onDoubleClick: () => this.editSelected(),
    });
    this.add(this.list);
    this.status = new TextRenderable(ctx, {
      id: `${options.id}-status`,
      width: "100%",
      height: 2,
      content: "No unsaved changes",
      fg: theme.muted,
      attributes: TextAttributes.DIM,
    });
    this.add(this.status);
    this.add(this.createActions(ctx));
    this.refresh();
  }

  public override handleKeyPress(key: KeyEvent): boolean {
    if (this.editor || key.eventType === "release") return false;
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
    if (key.name === "return" || key.name === "space") {
      this.editSelected();
      return true;
    }
    if (key.ctrl && key.name === "s") {
      void this.save();
      return true;
    }
    return false;
  }

  public inspectConfig(): TermLoomConfig {
    return structuredClone(this.config);
  }

  protected override destroySelf(): void {
    this.disposeMouse();
    this.closeEditor();
    super.destroySelf();
  }

  private createActions(ctx: RenderContext): BoxRenderable {
    const actions = new BoxRenderable(ctx, {
      id: `${this.optionsValue.id}-actions`,
      width: "100%",
      height: 1,
      flexDirection: "row",
      justifyContent: "flex-end",
    });
    actions.add(this.button(ctx, "save", " Save ", () => void this.save(), theme.success));
    actions.add(
      this.button(
        ctx,
        "cancel",
        " Cancel changes ",
        () => {
          this.config = structuredClone(this.original);
          this.dirty = false;
          this.optionsValue.onClose();
        },
        theme.warning,
      ),
    );
    actions.add(
      this.button(ctx, "close", " × Close ", () => this.optionsValue.onClose(), theme.error),
    );
    return actions;
  }

  private button(
    ctx: RenderContext,
    name: string,
    label: string,
    run: () => void,
    color: string,
  ): TextRenderable {
    return new TextRenderable(ctx, {
      id: `${this.optionsValue.id}-${name}`,
      content: label,
      fg: color,
      bg: theme.surface,
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

  private refresh(): void {
    this.list.options = settingFields.map((field) => ({
      name: `${field.group} · ${field.title}`,
      description: `${displayValue(field, this.config)} · ${field.description}`,
      value: field.path,
    }));
    this.status.content = this.dirty
      ? "Unsaved changes · Save applies UI settings immediately; SSH settings apply on reconnect"
      : "No unsaved changes";
    this.status.fg = this.dirty ? theme.warning : theme.muted;
    this.requestRender();
  }

  private editSelected(): void {
    if (this.saving) return;
    const field = settingFields[this.list.getSelectedIndex()];
    if (!field) return;
    if (field.kind === "boolean") {
      this.toggleBoolean(field);
      return;
    }
    if (field.kind === "enum") this.showEnumEditor(field);
    else this.showValueEditor(field);
  }

  private toggleBoolean(field: SettingField): void {
    const candidate = structuredClone(this.config);
    field.write(candidate, !field.read(candidate));
    this.applyDraft(candidate);
  }

  private showEnumEditor(field: SettingField): void {
    this.closeEditor();
    const values = field.values ?? [];
    const editor = this.createEditor(field, Math.min(16, values.length * 2 + 4));
    const select = new SettingsSelectRenderable(
      this.ctx,
      {
        id: `${this.id}-editor-select`,
        width: "100%",
        flexGrow: 1,
        options: values.map((value) => ({ name: value, description: "", value })),
        showDescription: false,
        selectedBackgroundColor: theme.selection,
        selectedTextColor: theme.foreground,
        backgroundColor: theme.surface,
      },
      () => this.closeEditor(),
    );
    select.setSelectedIndex(Math.max(0, values.indexOf(String(field.read(this.config)))));
    const apply = () => {
      const value = values[select.getSelectedIndex()];
      if (value === undefined) return;
      const candidate = structuredClone(this.config);
      field.write(candidate, value);
      this.applyDraft(candidate);
      this.closeEditor();
    };
    select.on(SelectRenderableEvents.ITEM_SELECTED, apply);
    this.editorMouseDispose = attachMouseSelect(select, {
      onClick: (index) => select.setSelectedIndex(index),
      onDoubleClick: apply,
    });
    editor.add(select);
    this.add(editor);
    this.editor = editor;
    select.focus();
    this.requestRender();
  }

  private showValueEditor(field: SettingField): void {
    this.closeEditor();
    const editor = this.createEditor(field, field.kind === "number" ? 8 : 6);
    const input = new SettingsInputRenderable(
      this.ctx,
      {
        id: `${this.id}-input`,
        width: "100%",
        value: editableValue(field, this.config),
        placeholder: field.title,
        backgroundColor: theme.surface,
        focusedBackgroundColor: theme.selection,
        textColor: theme.foreground,
        cursorColor: theme.accent,
      },
      () => this.closeEditor(),
    );
    const apply = (value: string) => {
      try {
        const candidate = structuredClone(this.config);
        field.write(candidate, parseEditorValue(field, value));
        this.applyDraft(candidate);
        this.closeEditor();
      } catch (error) {
        this.status.content = errorMessage(error);
        this.status.fg = theme.error;
        this.requestRender();
      }
    };
    input.on(InputRenderableEvents.ENTER, apply);
    editor.add(input);
    if (field.kind === "number" && field.min !== undefined && field.max !== undefined) {
      const slider = new SliderRenderable(this.ctx, {
        id: `${this.id}-slider`,
        width: "100%",
        height: 1,
        orientation: "horizontal",
        min: field.min,
        max: field.max,
        value: Number(field.read(this.config)),
        backgroundColor: theme.border,
        foregroundColor: theme.accent,
        onChange: (value) => {
          input.value = String(roundToStep(value, field.step ?? 1));
        },
      });
      editor.add(slider);
    }
    editor.add(
      this.button(this.ctx, "editor-apply", " Apply ", () => apply(input.value), theme.success),
    );
    this.add(editor);
    this.editor = editor;
    input.focus();
    this.requestRender();
  }

  private createEditor(field: SettingField, height: number): BoxRenderable {
    return new BoxRenderable(this.ctx, {
      id: `${this.id}-editor`,
      position: "absolute",
      left: "12%",
      top: "28%",
      width: "76%",
      height,
      zIndex: 600,
      border: true,
      borderStyle: "double",
      borderColor: theme.accentSecondary,
      title: ` ${field.group} · ${field.title} `,
      padding: 1,
      flexDirection: "column",
      backgroundColor: theme.surface,
    });
  }

  private applyDraft(candidate: TermLoomConfig): void {
    this.config = TermLoomConfigSchema.parse(candidate);
    this.dirty = JSON.stringify(this.config) !== JSON.stringify(this.original);
    this.refresh();
  }

  private closeEditor(): void {
    this.editorMouseDispose?.();
    this.editorMouseDispose = undefined;
    const editor = this.editor;
    if (!editor) return;
    this.editor = undefined;
    this.remove(editor);
    editor.destroyRecursively();
    if (!this.isDestroyed) super.focus();
    this.requestRender();
  }

  private async save(): Promise<void> {
    if (this.saving || !this.dirty) return;
    const confirmation = this.optionsValue.confirmSave?.(
      structuredClone(this.original),
      structuredClone(this.config),
    );
    if (confirmation) {
      this.showSaveConfirmation(confirmation);
      return;
    }
    await this.persistSave();
  }

  private showSaveConfirmation(message: string): void {
    this.closeEditor();
    const confirm = new SettingsConfirmationRenderable(
      this.ctx,
      {
        id: `${this.id}-confirm`,
        position: "absolute",
        left: "12%",
        top: "30%",
        width: "76%",
        height: 9,
        zIndex: 650,
        border: true,
        borderStyle: "double",
        borderColor: theme.warning,
        title: ` ${this.optionsValue.i18n.t("settings.title")} `,
        padding: 1,
        flexDirection: "column",
        focusable: true,
        backgroundColor: theme.surface,
      },
      () => {
        this.closeEditor();
        void this.persistSave();
      },
      () => this.closeEditor(),
    );
    confirm.add(
      new TextRenderable(this.ctx, {
        id: `${this.id}-confirm-message`,
        width: "100%",
        height: 4,
        content: message,
        fg: theme.warning,
        attributes: TextAttributes.BOLD,
      }),
    );
    const actions = new BoxRenderable(this.ctx, {
      id: `${this.id}-confirm-actions`,
      width: "100%",
      height: 1,
      flexDirection: "row",
      justifyContent: "flex-end",
    });
    actions.add(
      this.button(
        this.ctx,
        "confirm-apply",
        " Apply and reload preview ",
        () => {
          this.closeEditor();
          void this.persistSave();
        },
        theme.warning,
      ),
    );
    actions.add(
      this.button(
        this.ctx,
        "confirm-cancel",
        " Keep editing ",
        () => this.closeEditor(),
        theme.muted,
      ),
    );
    confirm.add(actions);
    this.add(confirm);
    this.editor = confirm;
    confirm.focus();
    this.requestRender();
  }

  private async persistSave(): Promise<void> {
    if (this.saving || !this.dirty) return;
    this.saving = true;
    this.status.content = this.optionsValue.i18n.t("settings.saving");
    this.status.fg = theme.warning;
    try {
      this.config = await this.optionsValue.save(TermLoomConfigSchema.parse(this.config));
      this.original = structuredClone(this.config);
      this.dirty = false;
      this.optionsValue.onSaved?.(structuredClone(this.config));
      this.status.content = this.optionsValue.i18n.t("settings.saved");
      this.status.fg = theme.success;
      this.refresh();
    } catch (error) {
      this.status.content = this.optionsValue.i18n.t("settings.error", {
        message: errorMessage(error),
      });
      this.status.fg = theme.error;
    } finally {
      this.saving = false;
      this.requestRender();
    }
  }
}

class SettingsConfirmationRenderable extends BoxRenderable {
  public constructor(
    ctx: RenderContext,
    options: ConstructorParameters<typeof BoxRenderable>[1],
    private readonly confirm: () => void,
    private readonly cancel: () => void,
  ) {
    super(ctx, options);
  }

  public override handleKeyPress(key: KeyEvent): boolean {
    if (key.eventType === "release") return false;
    if (key.name === "return") {
      this.confirm();
      return true;
    }
    if (key.name === "escape") {
      this.cancel();
      return true;
    }
    return false;
  }
}

class SettingsInputRenderable extends InputRenderable {
  public constructor(
    ctx: RenderContext,
    options: ConstructorParameters<typeof InputRenderable>[1],
    private readonly cancel: () => void,
  ) {
    super(ctx, options);
  }

  public override handleKeyPress(key: KeyEvent): boolean {
    if (key.eventType !== "release" && key.name === "escape") {
      this.cancel();
      return true;
    }
    return super.handleKeyPress(key);
  }
}

class SettingsSelectRenderable extends SelectRenderable {
  public constructor(
    ctx: RenderContext,
    options: ConstructorParameters<typeof SelectRenderable>[1],
    private readonly cancel: () => void,
  ) {
    super(ctx, options);
  }

  public override handleKeyPress(key: KeyEvent): boolean {
    if (key.eventType !== "release" && key.name === "escape") {
      this.cancel();
      return true;
    }
    return super.handleKeyPress(key);
  }
}

const settingFields: readonly SettingField[] = [
  enumSetting("ui.locale", "Appearance", "Language", "Application language", [
    "auto",
    "en",
    "zh-CN",
  ]),
  enumSetting("ui.theme", "Appearance", "Theme", "Terminal color theme", [
    "system",
    "dark",
    "light",
  ]),
  numberSetting(
    "ui.sidebarWidth",
    "Appearance",
    "Sidebar width",
    "Columns used by the Host tree",
    18,
    60,
    1,
  ),
  textSetting("ui.leader", "Keyboard", "Advanced command leader", "Default: ctrl+g"),
  textSetting("ui.quickSwitch", "Keyboard", "Files/Terminal shortcut", "Default: f2"),
  numberSetting(
    "ssh.controlPersistSeconds",
    "SSH",
    "Connection keepalive",
    "ControlMaster persistence in seconds",
    30,
    86_400,
    30,
  ),
  numberSetting(
    "ssh.connectTimeoutSeconds",
    "SSH",
    "Connect timeout",
    "Timeout in seconds",
    1,
    120,
    1,
  ),
  numberSetting(
    "ssh.serverAliveInterval",
    "SSH",
    "Server-alive interval",
    "Probe interval in seconds",
    1,
    600,
    1,
  ),
  numberSetting(
    "ssh.serverAliveCountMax",
    "SSH",
    "Server-alive retries",
    "Failed probes before reconnect",
    1,
    20,
    1,
  ),
  booleanSetting(
    "reconnect.enabled",
    "Reconnect",
    "Automatic reconnect",
    "Reconnect the active Host after interruption",
  ),
  numberSetting(
    "reconnect.initialDelayMs",
    "Reconnect",
    "Initial delay",
    "First retry delay in milliseconds",
    100,
    60_000,
    100,
  ),
  numberSetting(
    "reconnect.maxDelayMs",
    "Reconnect",
    "Maximum delay",
    "Maximum retry delay in milliseconds",
    500,
    300_000,
    500,
  ),
  numberSetting(
    "reconnect.multiplier",
    "Reconnect",
    "Backoff multiplier",
    "Retry delay growth factor",
    1,
    5,
    0.1,
  ),
  numberSetting(
    "reconnect.jitter",
    "Reconnect",
    "Retry jitter",
    "Randomization from 0 to 1",
    0,
    1,
    0.05,
  ),
  enumSetting(
    "media.adapter",
    "Media",
    "Graphics adapter",
    "Capability-aware terminal image protocol",
    ["auto", "kitty", "iterm2", "truecolor-cells"],
  ),
  numberSetting(
    "media.videoFps",
    "Media",
    "Video frame rate",
    "Preview frames per second",
    1,
    60,
    1,
  ),
  numberSetting(
    "media.maxCacheBytes",
    "Media",
    "Cache limit",
    "Maximum resource cache bytes",
    1_048_576,
    4_294_967_296,
    1_048_576,
  ),
  booleanSetting(
    "media.autoplayGif",
    "Media",
    "Autoplay GIF",
    "Start animated GIF previews automatically",
  ),
  domainsSetting(),
];

function enumSetting(
  path: string,
  group: string,
  title: string,
  description: string,
  values: readonly string[],
): SettingField {
  return pathSetting(path, group, title, description, "enum", { values });
}

function numberSetting(
  path: string,
  group: string,
  title: string,
  description: string,
  min: number,
  max: number,
  step: number,
): SettingField {
  return pathSetting(path, group, title, description, "number", { min, max, step });
}

function booleanSetting(
  path: string,
  group: string,
  title: string,
  description: string,
): SettingField {
  return pathSetting(path, group, title, description, "boolean");
}

function textSetting(
  path: string,
  group: string,
  title: string,
  description: string,
): SettingField {
  return pathSetting(path, group, title, description, "text");
}

function pathSetting(
  path: string,
  group: string,
  title: string,
  description: string,
  kind: SettingKind,
  constraints: Pick<SettingField, "values" | "min" | "max" | "step"> = {},
): SettingField {
  return {
    path,
    group,
    title,
    description,
    kind,
    ...constraints,
    read: (config) => getPath(config, path) as string | number | boolean,
    write: (config, value) => setPath(config, path, value),
  };
}

function domainsSetting(): SettingField {
  return {
    path: "permissions.allowedHttpDomains",
    group: "Permissions",
    title: "Allowed HTTP domains",
    description: "Comma-separated domains allowed for Markdown media",
    kind: "domains",
    read: (config) => config.permissions.allowedHttpDomains.join(", "),
    write: (config, value) => {
      config.permissions.allowedHttpDomains = String(value)
        .split(",")
        .map((domain) => domain.trim())
        .filter(Boolean);
    },
  };
}

function getPath(config: TermLoomConfig, path: string): unknown {
  let value: unknown = config;
  for (const key of path.split(".")) value = (value as Record<string, unknown>)[key];
  return value;
}

function setPath(config: TermLoomConfig, path: string, value: unknown): void {
  const parts = path.split(".");
  const key = parts.pop();
  if (!key) throw new Error(`Invalid setting path: ${path}`);
  let parent: Record<string, unknown> = config as unknown as Record<string, unknown>;
  for (const part of parts) parent = parent[part] as Record<string, unknown>;
  parent[key] = value;
}

function parseEditorValue(field: SettingField, value: string): string | number {
  if (field.kind !== "number") return value.trim();
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${field.title} must be a number`);
  return roundToStep(parsed, field.step ?? 1);
}

function editableValue(field: SettingField, config: TermLoomConfig): string {
  return String(field.read(config));
}

function displayValue(field: SettingField, config: TermLoomConfig): string {
  const value = field.read(config);
  if (field.kind === "boolean") return value ? "[✓] On" : "[ ] Off";
  if (field.path === "media.maxCacheBytes") return `${Math.round(Number(value) / 1_048_576)} MiB`;
  return String(value || "None");
}

function roundToStep(value: number, step: number): number {
  const rounded = Math.round(value / step) * step;
  return Number(rounded.toFixed(Math.max(0, decimalPlaces(step))));
}

function decimalPlaces(value: number): number {
  const text = String(value);
  return text.includes(".") ? text.length - text.indexOf(".") - 1 : 0;
}
