import { parse, stringify } from "smol-toml";
import { atomicWriteUtf8, readOptionalUtf8 } from "../core/atomic-file.js";
import { errorMessage, TermLoomError } from "../core/errors.js";
import { defaultConfig, type TermLoomConfig, TermLoomConfigSchema } from "./schema.js";

export class ConfigStore {
  public constructor(public readonly path: string) {}

  public async load(): Promise<TermLoomConfig> {
    const content = await readOptionalUtf8(this.path);
    if (content === null) return defaultConfig();
    try {
      return TermLoomConfigSchema.parse(parse(content));
    } catch (error) {
      throw new TermLoomError({
        code: "CONFIG_INVALID",
        message: `Configuration is invalid: ${errorMessage(error)}`,
        hint: `Repair ${this.path}; TermLoom did not replace it.`,
        cause: error,
        details: { path: this.path },
      });
    }
  }

  public async save(config: TermLoomConfig): Promise<void> {
    const validated = TermLoomConfigSchema.parse(config);
    await atomicWriteUtf8(this.path, `${stringify(validated)}\n`);
  }
}
