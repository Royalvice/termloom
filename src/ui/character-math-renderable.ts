import { BoxRenderable, TextRenderable, type RenderContext } from "@opentui/core";
import type { RichMathExpression } from "../document/model.js";
import type { MathLayout } from "../document/math-layout.js";
import { theme } from "./theme.js";

export interface MathRenderFailure {
  readonly code: string;
  readonly message: string;
}

/** A formula rendered as ordinary OpenTUI text cells, never as an image. */
export class CharacterMathRenderable extends BoxRenderable {
  public readonly layout: MathLayout | undefined;
  public readonly error: MathRenderFailure | undefined;

  public constructor(
    ctx: RenderContext,
    expression: RichMathExpression,
    result: MathLayout | MathRenderFailure,
  ) {
    const isFailure = "message" in result;
    const layout = isFailure ? undefined : (result as MathLayout);
    const error = isFailure ? (result as MathRenderFailure) : undefined;
    const content =
      layout?.lines.join("\n") ??
      `LaTeX error [${error?.code}]: ${singleLineError(error?.message ?? "Unknown error")}`;
    const contentWidth = error ? "100%" : Math.max(1, layout?.width ?? 1);
    super(ctx, {
      id: `document-${expression.id}`,
      width: expression.display || error ? "100%" : contentWidth,
      height: Math.max(1, layout?.height ?? 1),
      flexDirection: "column",
      alignItems: expression.display ? "center" : "flex-start",
      flexShrink: 0,
      marginTop: expression.display ? 1 : 0,
      marginBottom: expression.display ? 1 : 0,
    });
    this.layout = layout;
    this.error = error;
    this.add(
      new TextRenderable(ctx, {
        id: `text-${expression.id}`,
        content,
        width: contentWidth,
        height: Math.max(1, layout?.height ?? 1),
        fg: error ? theme.error : theme.foreground,
        selectable: true,
        flexShrink: 0,
      }),
    );
  }
}

function singleLineError(message: string): string {
  const compact = message.replace(/\s+/gu, " ").trim();
  return compact.length > 240 ? `${compact.slice(0, 237)}...` : compact;
}
