import { parse, stringify } from "smol-toml";
import { atomicWriteUtf8, readOptionalUtf8 } from "../core/atomic-file.js";
import { errorMessage, TermLoomError } from "../core/errors.js";
import {
  defaultConfig,
  migrateConfigV1,
  type TermLoomConfig,
  TermLoomConfigSchema,
  TermLoomConfigV1Schema,
} from "./schema.js";

export class ConfigStore {
  public constructor(public readonly path: string) {}

  public async load(): Promise<TermLoomConfig> {
    const content = await readOptionalUtf8(this.path);
    if (content === null) return defaultConfig();
    try {
      const parsed = parse(content);
      const version = configVersion(parsed);
      if (version === 1) {
        const migrated = migrateConfigV1(TermLoomConfigV1Schema.parse(parsed));
        await this.persistMigration(content, migrated);
        return migrated;
      }
      return TermLoomConfigSchema.parse(parsed);
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

  private async persistMigration(original: string, migrated: TermLoomConfig): Promise<void> {
    const backupPath = `${this.path}.v1.bak`;
    if ((await readOptionalUtf8(backupPath)) === null) {
      await atomicWriteUtf8(backupPath, original);
    }
    await atomicWriteUtf8(this.path, `${stringify(migrated)}\n`);
  }
}

function configVersion(value: unknown): unknown {
  if (typeof value !== "object" || value === null || !("schemaVersion" in value)) return 1;
  return value.schemaVersion;
}
