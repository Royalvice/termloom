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
import { errorMessage } from "../core/errors.js";
import type { TmuxSessionInfo } from "../tmux/tmux-service.js";
import type { PaneState } from "../workspace/schema.js";
import type { ContextMenuAction, ContextMenuRequest } from "./dismissible-overlay-controller.js";
import { attachMouseSelect } from "./mouse-select-adapter.js";
import { theme } from "./theme.js";

type SessionPickerPaneState = Extract<PaneState, { kind: "session-picker" }>;

export interface SessionPickerService {
  list(hostId: string): Promise<readonly TmuxSessionInfo[]>;
  create(hostId: string, name: string, cwd?: string): Promise<void>;
  rename(hostId: string, currentName: string, nextName: string): Promise<void>;
  kill(hostId: string, name: string): Promise<void>;
}

export interface SessionPickerOptions {
  id: string;
  pane: SessionPickerPaneState;
  service: SessionPickerService;
  defaultPath?: string;
  defaultSession?: string;
  onAttach: (pane: SessionPickerPaneState, session: TmuxSessionInfo, inSplit: boolean) => void;
  onRawShell: (pane: SessionPickerPaneState, inSplit: boolean) => void;
  onContextMenu?: (request: ContextMenuRequest, restoreFocus: () => void) => void;
}

export class SessionPickerRenderable extends BoxRenderable {
  private readonly pane: SessionPickerPaneState;
  private readonly service: SessionPickerService;
  private readonly optionsValue: SessionPickerOptions;
  private readonly list: SelectRenderable;
  private readonly status: TextRenderable;
  private sessions: readonly TmuxSessionInfo[] = [];
  private modal: BoxRenderable | undefined;
  private modalInput: InputRenderable | undefined;
  private generation = 0;
  private readonly disposeMouse: () => void;

  public constructor(ctx: RenderContext, options: SessionPickerOptions) {
    super(ctx, {
      id: options.id,
      width: "100%",
      height: "100%",
      flexDirection: "column",
      focusable: true,
      backgroundColor: theme.background,
      overflow: "hidden",
    });
    this.pane = options.pane;
    this.service = options.service;
    this.optionsValue = options;
    this.add(
      new TextRenderable(ctx, {
        id: `${options.id}-title`,
        height: 1,
        width: "100%",
        content: " tmux sessions ",
        fg: theme.accent,
        bg: theme.surfaceRaised,
        attributes: TextAttributes.BOLD,
      }),
    );
    this.add(this.createToolbar(ctx));
    this.list = new SelectRenderable(ctx, {
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
      backgroundColor: theme.background,
    });
    this.list.on(SelectRenderableEvents.ITEM_SELECTED, () => this.attach(false));
    this.disposeMouse = attachMouseSelect(this.list, {
      onDoubleClick: () => this.attach(false),
      onContextMenu: (_index, event) => this.showSessionActions(event.x, event.y),
    });
    this.add(this.list);
    this.status = new TextRenderable(ctx, {
      id: `${options.id}-status`,
      width: "100%",
      height: 2,
      content: "Loading sessions…",
      fg: theme.muted,
      attributes: TextAttributes.DIM,
    });
    this.add(this.status);
    void this.refresh();
  }

  public override handleKeyPress(key: KeyEvent): boolean {
    if (this.modalInput) {
      if (key.name === "escape") {
        this.closeModal();
        return true;
      }
      return false;
    }
    if (key.eventType === "release" || key.ctrl || key.meta || key.super) return false;
    if (key.name === "up" || key.name === "k") {
      this.list.moveUp();
      return true;
    }
    if (key.name === "down" || key.name === "j") {
      this.list.moveDown();
      return true;
    }
    if (key.name === "return") {
      this.attach(false);
      return true;
    }
    if (key.name === "s") {
      this.attach(true);
      return true;
    }
    if (key.name === "n") {
      this.promptNewSession();
      return true;
    }
    if (key.name === "o") {
      this.optionsValue.onRawShell(this.pane, false);
      return true;
    }
    if (key.name === "r" && key.shift) {
      this.promptRename();
      return true;
    }
    if (key.name === "d") {
      this.confirmKill();
      return true;
    }
    if (key.name === "r") {
      void this.refresh();
      return true;
    }
    return false;
  }

  public async refresh(): Promise<void> {
    const generation = ++this.generation;
    this.status.content = "Loading sessions…";
    this.status.fg = theme.muted;
    this.requestRender();
    try {
      const previouslySelected =
        this.sessions[this.list.getSelectedIndex()]?.name ?? this.optionsValue.defaultSession;
      this.sessions = await this.service.list(this.pane.target.hostId);
      if (generation !== this.generation || this.isDestroyed) return;
      this.list.options = this.sessions.length
        ? this.sessions.map((session) => ({
            name: `${session.attachedClients > 0 ? "●" : "○"} ${session.name}`,
            description: `${session.windows} windows · ${session.attachedClients} attached`,
          }))
        : [{ name: "No tmux sessions", description: "Create one or open a raw SSH shell" }];
      const preferredIndex = previouslySelected
        ? this.sessions.findIndex((session) => session.name === previouslySelected)
        : 0;
      this.list.setSelectedIndex(Math.max(0, preferredIndex));
      this.status.content = this.sessions.length
        ? "Double-click/Enter attach · S open in split · Right-click actions"
        : "New tmux session or Open raw SSH shell";
      this.status.fg = theme.muted;
    } catch (error) {
      if (generation !== this.generation || this.isDestroyed) return;
      this.sessions = [];
      this.list.options = [{ name: "Session discovery failed", description: errorMessage(error) }];
      this.status.content = `Session error: ${errorMessage(error)}`;
      this.status.fg = theme.error;
    }
    this.requestRender();
  }

  public refreshAppearance(): void {
    this.backgroundColor = theme.background;
    this.list.backgroundColor = theme.background;
    this.list.selectedBackgroundColor = theme.selection;
    this.list.selectedTextColor = theme.foreground;
    this.list.descriptionColor = theme.muted;
    this.list.selectedDescriptionColor = theme.foreground;
    this.status.fg = theme.muted;
    this.requestRender();
  }

  protected override destroySelf(): void {
    this.generation += 1;
    this.disposeMouse();
    this.closeModal();
    super.destroySelf();
  }

  private createToolbar(ctx: RenderContext): ScrollBoxRenderable {
    const toolbar = new ScrollBoxRenderable(ctx, {
      id: `${this.optionsValue.id}-toolbar`,
      height: 1,
      width: "100%",
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
    toolbar.add(this.button(ctx, "new", " + New tmux ", () => this.promptNewSession()));
    toolbar.add(
      this.button(ctx, "raw", " > Raw SSH shell ", () =>
        this.optionsValue.onRawShell(this.pane, false),
      ),
    );
    toolbar.add(this.button(ctx, "attach", " Attach ", () => this.attach(false)));
    toolbar.add(
      this.button(ctx, "actions", " Actions… ", () =>
        this.showSessionActions(this.list.screenX + 2, this.list.screenY + 1),
      ),
    );
    toolbar.add(this.button(ctx, "refresh", " ↻ ", () => void this.refresh()));
    return toolbar;
  }

  private button(ctx: RenderContext, id: string, label: string, run: () => void): TextRenderable {
    return new TextRenderable(ctx, {
      id: `${this.optionsValue.id}-${id}`,
      content: label,
      fg: theme.accent,
      bg: theme.surfaceRaised,
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

  private attach(inSplit: boolean): void {
    const session = this.sessions[this.list.getSelectedIndex()];
    if (session) this.optionsValue.onAttach(this.pane, session, inSplit);
  }

  private promptNewSession(): void {
    this.showPrompt("New tmux session", "work", async (value) => {
      const name = required(value, "Session name");
      await this.service.create(this.pane.target.hostId, name, this.optionsValue.defaultPath);
      await this.refresh();
      const session = this.sessions.find((candidate) => candidate.name === name);
      if (session) this.optionsValue.onAttach(this.pane, session, false);
    });
  }

  private promptRename(): void {
    const session = this.sessions[this.list.getSelectedIndex()];
    if (!session) return;
    this.showPrompt("Rename tmux session", session.name, async (value) => {
      await this.service.rename(
        this.pane.target.hostId,
        session.name,
        required(value, "Session name"),
      );
      await this.refresh();
    });
  }

  private confirmKill(): void {
    const session = this.sessions[this.list.getSelectedIndex()];
    if (!session) return;
    this.showPrompt(`Type DELETE to kill ${session.name}`, "", async (value) => {
      if (value !== "DELETE") throw new Error("Session kill was not confirmed");
      await this.service.kill(this.pane.target.hostId, session.name);
      await this.refresh();
    });
  }

  private showSessionActions(x: number, y: number): void {
    const session = this.sessions[this.list.getSelectedIndex()];
    if (!session || !this.optionsValue.onContextMenu) return;
    const actions: ContextMenuAction[] = [
      {
        id: "attach",
        label: "Attach",
        run: () => this.optionsValue.onAttach(this.pane, session, false),
      },
      {
        id: "open-split",
        label: "Open in split",
        run: () => this.optionsValue.onAttach(this.pane, session, true),
      },
      { id: "rename", label: "Rename…", run: () => this.promptRename() },
      { id: "kill", label: "Kill…", run: () => this.confirmKill() },
    ];
    this.optionsValue.onContextMenu({ x, y, title: session.name, actions }, () =>
      this.list.focus(),
    );
  }

  private showPrompt(
    title: string,
    initial: string,
    submit: (value: string) => Promise<void>,
  ): void {
    this.closeModal();
    const modal = new BoxRenderable(this.ctx, {
      id: `${this.id}-modal`,
      position: "absolute",
      left: "10%",
      top: "35%",
      width: "80%",
      height: 5,
      zIndex: 100,
      border: true,
      borderStyle: "double",
      borderColor: theme.accent,
      title,
      padding: 1,
      backgroundColor: theme.surfaceRaised,
    });
    const input = new SessionPromptInput(
      this.ctx,
      {
        id: `${this.id}-modal-input`,
        width: "100%",
        value: initial,
        placeholder: title,
        backgroundColor: theme.surface,
        focusedBackgroundColor: theme.selection,
        textColor: theme.foreground,
        cursorColor: theme.accent,
      },
      () => this.closeModal(),
    );
    input.on(InputRenderableEvents.ENTER, (value: string) => {
      this.closeModal();
      void submit(value.trim()).catch((error) => {
        this.status.content = `Session error: ${errorMessage(error)}`;
        this.status.fg = theme.error;
        this.requestRender();
      });
    });
    modal.add(input);
    this.add(modal);
    this.modal = modal;
    this.modalInput = input;
    input.focus();
    this.requestRender();
  }

  private closeModal(): void {
    const modal = this.modal;
    if (!modal) return;
    this.modal = undefined;
    this.modalInput = undefined;
    this.remove(modal);
    modal.destroyRecursively();
    if (!this.isDestroyed) this.list.focus();
    this.requestRender();
  }
}

class SessionPromptInput extends InputRenderable {
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

function required(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}
