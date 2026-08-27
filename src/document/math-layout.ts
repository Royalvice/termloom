/** A rectangular terminal-cell layout produced by the native LaTeX engine. */
export interface MathLayout {
  readonly lines: readonly string[];
  readonly width: number;
  readonly height: number;
  readonly baseline: number;
  readonly display: boolean;
}

/**
 * The only math contract exposed to the OpenTUI document layout.
 *
 * Implementations must parse and lay out LaTeX. They must reject unsupported
 * syntax; returning the source as ordinary text is not a valid implementation.
 */
export interface MathRenderer {
  layout(source: string, display: boolean, signal?: AbortSignal): Promise<MathLayout>;
}
