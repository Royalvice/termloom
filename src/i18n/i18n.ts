import {
  type Catalog,
  englishCatalog,
  type MessageKey,
  simplifiedChineseCatalog,
} from "./catalog.js";

export type SupportedLocale = "en" | "zh-CN";

export function resolveLocale(
  configured: "auto" | SupportedLocale,
  environment = process.env,
): SupportedLocale {
  if (configured !== "auto") return configured;
  const { LC_ALL: allLocale, LC_MESSAGES: messageLocale, LANG: language } = environment;
  const locale = allLocale ?? messageLocale ?? language ?? "en";
  return /^zh(?:[_-]|$)/i.test(locale) ? "zh-CN" : "en";
}

export class I18n {
  private catalog: Catalog;

  public constructor(public locale: SupportedLocale) {
    this.catalog = locale === "zh-CN" ? simplifiedChineseCatalog : englishCatalog;
  }

  public setLocale(locale: SupportedLocale): void {
    this.locale = locale;
    this.catalog = locale === "zh-CN" ? simplifiedChineseCatalog : englishCatalog;
  }

  public t(key: MessageKey, values: Readonly<Record<string, string | number>> = {}): string {
    return this.catalog[key].replace(/\{([^}]+)\}/g, (match, name: string) => {
      const value = values[name];
      return value === undefined ? match : String(value);
    });
  }
}
