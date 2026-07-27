import { TermLoomError } from "../core/errors.js";

export interface CommandExecution<TPayload = unknown> {
  payload: TPayload;
  signal: AbortSignal;
}

export type CommandHandler<TPayload = unknown, TResult = unknown> = (
  execution: CommandExecution<TPayload>,
) => TResult | Promise<TResult>;

export class CommandBus {
  private readonly handlers = new Map<string, CommandHandler>();

  public register<TPayload, TResult>(
    name: string,
    handler: CommandHandler<TPayload, TResult>,
  ): () => void {
    if (this.handlers.has(name)) {
      throw new Error(`Command already registered: ${name}`);
    }
    this.handlers.set(name, handler as CommandHandler);
    return () => this.handlers.delete(name);
  }

  public has(name: string): boolean {
    return this.handlers.has(name);
  }

  public names(): string[] {
    return [...this.handlers.keys()].sort();
  }

  public async execute<TPayload, TResult>(
    name: string,
    payload: TPayload,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<TResult> {
    const handler = this.handlers.get(name);
    if (!handler) {
      throw new TermLoomError({ code: "COMMAND_UNKNOWN", message: `Unknown command: ${name}` });
    }
    if (signal.aborted) throw signal.reason;
    try {
      return (await handler({ payload, signal })) as TResult;
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (error instanceof TermLoomError) throw error;
      throw new TermLoomError({
        code: "COMMAND_FAILED",
        message: `Command failed: ${name}`,
        cause: error,
        details: { command: name },
      });
    }
  }
}
