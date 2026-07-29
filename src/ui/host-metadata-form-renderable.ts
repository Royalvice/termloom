import {
  BoxRenderable,
  InputRenderable,
  InputRenderableEvents,
  type KeyEvent,
  MouseButton,
  type RenderContext,
  TextRenderable,
} from "@opentui/core";
import { errorMessage } from "../core/errors.js";
import { theme } from "./theme.js";

export interface HostMetadataValues {
  label: string;
  defaultPath: string;
  defaultSession: string;
}

export interface HostMetadataFormOptions {
  id: string;
  alias: string;
  values: HostMetadataValues;
  onSave(values: HostMetadataValues): Promise<void> | void;
  onClose(): void;
}

export class HostMetadataFormRenderable extends BoxRenderable {
  private readonly inputs: HostFormInput[];
  private readonly status: TextRenderable;
  private saving = false;

  public constructor(ctx: RenderContext, options: HostMetadataFormOptions) {
    super(ctx, {
      id: options.id,
      position: "absolute",
      left: 0,
      top: "18%",
      width: "100%",
      height: 13,
      zIndex: 150,
      border: true,
      borderStyle: "double",
      borderColor: theme.accent,
      title: ` ${options.alias} defaults `,
      padding: 1,
      flexDirection: "column",
      backgroundColor: theme.surfaceRaised,
    });
    const definitions = [
      { id: "label", label: "Display label", value: options.values.label },
      { id: "path", label: "Default remote path", value: options.values.defaultPath },
      { id: "session", label: "Default tmux session", value: options.values.defaultSession },
    ];
    this.inputs = definitions.map((definition, index) => {
      this.add(
        new TextRenderable(ctx, {
          id: `${options.id}-${definition.id}-label`,
          height: 1,
          content: definition.label,
          fg: theme.muted,
        }),
      );
      const input = new HostFormInput(
        ctx,
        {
          id: `${options.id}-${definition.id}`,
          width: "100%",
          value: definition.value,
          placeholder: definition.label,
          backgroundColor: theme.surface,
          focusedBackgroundColor: theme.selection,
          textColor: theme.foreground,
          cursorColor: theme.accent,
        },
        () => options.onClose(),
        (offset) =>
          this.inputs[(index + offset + definitions.length) % definitions.length]?.focus(),
      );
      this.add(input);
      return input;
    });
    this.status = new TextRenderable(ctx, {
      id: `${options.id}-status`,
      height: 1,
      width: "100%",
      content: "",
      fg: theme.muted,
    });
    this.add(this.status);
    const actions = new BoxRenderable(ctx, {
      id: `${options.id}-actions`,
      height: 1,
      width: "100%",
      flexDirection: "row",
      justifyContent: "flex-end",
      marginTop: 1,
    });
    const save = () => {
      if (this.saving) return;
      const [label, path, session] = this.inputs;
      if (!label || !path || !session) return;
      const values = {
        label: label.value.trim(),
        defaultPath: path.value.trim(),
        defaultSession: session.value.trim(),
      };
      if (!values.label) {
        this.showError("Display label is required");
        label.focus();
        return;
      }
      if (!values.defaultPath) {
        this.showError("Default path is required");
        path.focus();
        return;
      }
      this.saving = true;
      this.status.content = "Saving…";
      this.status.fg = theme.muted;
      this.requestRender();
      void Promise.resolve(options.onSave(values)).catch((error) => {
        if (this.isDestroyed) return;
        this.saving = false;
        this.showError(errorMessage(error));
      });
    };
    actions.add(this.button(ctx, "save", " Save all ", save, theme.success));
    actions.add(this.button(ctx, "cancel", " Cancel ", options.onClose, theme.warning));
    actions.add(this.button(ctx, "close", " × ", options.onClose, theme.error));
    this.add(actions);
    for (const input of this.inputs) input.on(InputRenderableEvents.ENTER, save);
    this.inputs[0]?.focus();
  }

  private showError(message: string): void {
    this.status.content = `Save failed: ${message}`;
    this.status.fg = theme.error;
    this.requestRender();
  }

  private button(
    ctx: RenderContext,
    name: string,
    label: string,
    run: () => void,
    color: string,
  ): TextRenderable {
    return new TextRenderable(ctx, {
      id: `${this.id}-${name}`,
      content: label,
      fg: color,
      bg: theme.surface,
      onMouseOver: () => this.ctx.setMousePointer("pointer"),
      onMouseOut: () => this.ctx.setMousePointer("default"),
      onMouseDown: (event) => {
        if (event.button !== MouseButton.LEFT) return;
        try {
          run();
        } catch {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
      },
    });
  }
}

class HostFormInput extends InputRenderable {
  public constructor(
    ctx: RenderContext,
    options: ConstructorParameters<typeof InputRenderable>[1],
    private readonly close: () => void,
    private readonly moveFocus: (offset: number) => void,
  ) {
    super(ctx, options);
  }

  public override handleKeyPress(key: KeyEvent): boolean {
    if (key.eventType !== "release" && key.name === "escape") {
      this.close();
      return true;
    }
    if (key.eventType !== "release" && key.name === "tab") {
      this.moveFocus(key.shift ? -1 : 1);
      return true;
    }
    return super.handleKeyPress(key);
  }
}
