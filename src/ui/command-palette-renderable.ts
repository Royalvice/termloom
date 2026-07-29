import {
  BoxRenderable,
  InputRenderable,
  InputRenderableEvents,
  type KeyEvent,
  MouseButton,
  type RenderContext,
  SelectRenderable,
  SelectRenderableEvents,
  TextRenderable,
} from "@opentui/core";
import { attachMouseSelect } from "./mouse-select-adapter.js";
import { theme } from "./theme.js";

export interface PaletteCommand {
  id: string;
  title: string;
  shortcut?: string;
  run: () => void;
}

export interface CommandPaletteOptions {
  id: string;
  commands: readonly PaletteCommand[];
  onClose: () => void;
}

export class CommandPaletteRenderable extends BoxRenderable {
  private readonly commands: readonly PaletteCommand[];
  private filtered: readonly PaletteCommand[];
  private readonly input: InputRenderable;
  private readonly list: SelectRenderable;
  private readonly onCloseValue: () => void;
  private readonly disposeMouse: () => void;
  private executed = false;

  public constructor(ctx: RenderContext, options: CommandPaletteOptions) {
    super(ctx, {
      id: options.id,
      position: "absolute",
      left: "15%",
      top: "12%",
      width: "70%",
      height: "70%",
      zIndex: 300,
      border: true,
      borderStyle: "double",
      borderColor: theme.accent,
      title: " Help & Commands ",
      flexDirection: "column",
      backgroundColor: theme.surfaceRaised,
    });
    this.commands = options.commands;
    this.filtered = options.commands;
    this.onCloseValue = options.onClose;
    const header = new BoxRenderable(ctx, {
      id: `${options.id}-header`,
      height: 1,
      width: "100%",
      flexDirection: "row",
    });
    this.input = new PaletteInputRenderable(
      ctx,
      {
        id: `${options.id}-search`,
        flexGrow: 1,
        value: "",
        placeholder: "Search commands…",
        backgroundColor: theme.surface,
        focusedBackgroundColor: theme.selection,
        textColor: theme.foreground,
        cursorColor: theme.accent,
      },
      () => this.onCloseValue(),
    );
    header.add(this.input);
    header.add(
      new TextRenderable(ctx, {
        id: `${options.id}-close`,
        content: " × Close ",
        fg: theme.error,
        onMouseOver: () => this.ctx.setMousePointer("pointer"),
        onMouseOut: () => this.ctx.setMousePointer("default"),
        onMouseDown: (event) => {
          if (event.button !== MouseButton.LEFT) return;
          this.onCloseValue();
          event.preventDefault();
          event.stopPropagation();
        },
      }),
    );
    this.add(header);
    this.list = new PaletteSelectRenderable(
      ctx,
      {
        id: `${options.id}-list`,
        width: "100%",
        flexGrow: 1,
        options: [],
        showDescription: true,
        showScrollIndicator: true,
        selectedBackgroundColor: theme.selection,
        selectedTextColor: theme.foreground,
        descriptionColor: theme.muted,
        selectedDescriptionColor: theme.foreground,
        backgroundColor: theme.surfaceRaised,
      },
      () => this.onCloseValue(),
    );
    this.list.on(SelectRenderableEvents.ITEM_SELECTED, () => this.executeSelected());
    this.disposeMouse = attachMouseSelect(this.list, {
      onClick: (index) => {
        this.list.setSelectedIndex(index);
        this.executeSelected();
      },
    });
    this.add(this.list);
    this.input.on(InputRenderableEvents.INPUT, (value: string) => this.filter(value));
    this.input.on(InputRenderableEvents.ENTER, () => this.executeSelected());
    this.filter("");
    this.input.focus();
  }

  public override handleKeyPress(key: KeyEvent): boolean {
    if (key.eventType === "release") return false;
    if (key.name === "escape" || key.name === "f1") {
      this.onCloseValue();
      return true;
    }
    if (key.name === "up") {
      this.list.moveUp();
      return true;
    }
    if (key.name === "down") {
      this.list.moveDown();
      return true;
    }
    return false;
  }

  protected override destroySelf(): void {
    this.disposeMouse();
    super.destroySelf();
  }

  private filter(value: string): void {
    const query = value.trim().toLocaleLowerCase();
    this.filtered = query
      ? this.commands.filter((command) =>
          `${command.title}\n${command.shortcut ?? ""}`.toLocaleLowerCase().includes(query),
        )
      : this.commands;
    this.list.options = this.filtered.length
      ? this.filtered.map((command) => ({
          name: command.title,
          description: command.shortcut ?? "",
          value: command.id,
        }))
      : [{ name: "No matching commands", description: "" }];
    this.list.setSelectedIndex(0);
    this.requestRender();
  }

  private executeSelected(): void {
    if (this.executed) return;
    const command = this.filtered[this.list.getSelectedIndex()];
    if (!command) return;
    this.executed = true;
    this.onCloseValue();
    command.run();
  }
}

class PaletteInputRenderable extends InputRenderable {
  public constructor(
    ctx: RenderContext,
    options: ConstructorParameters<typeof InputRenderable>[1],
    private readonly close: () => void,
  ) {
    super(ctx, options);
  }

  public override handleKeyPress(key: KeyEvent): boolean {
    if (key.eventType !== "release" && (key.name === "escape" || key.name === "f1")) {
      this.close();
      return true;
    }
    return super.handleKeyPress(key);
  }
}

class PaletteSelectRenderable extends SelectRenderable {
  public constructor(
    ctx: RenderContext,
    options: ConstructorParameters<typeof SelectRenderable>[1],
    private readonly close: () => void,
  ) {
    super(ctx, options);
  }

  public override handleKeyPress(key: KeyEvent): boolean {
    if (key.eventType !== "release" && (key.name === "escape" || key.name === "f1")) {
      this.close();
      return true;
    }
    return super.handleKeyPress(key);
  }
}
