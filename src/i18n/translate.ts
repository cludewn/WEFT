import { enUS, type MessageKey, type TranslationArguments } from "./en-US.js";
import { ja } from "./ja.js";

export type AppLocale = "en-US" | "ja";

export function resolveLocale(locale: unknown): AppLocale {
  return locale === "ja" ? "ja" : "en-US";
}

// Background presentation may use existing Guild state, without fetching or persisting a locale.
export function resolveGuildLocale(
  guild: { available?: boolean; preferredLocale?: unknown } | null | undefined,
): AppLocale {
  return guild?.available === true ? resolveLocale(guild.preferredLocale) : "en-US";
}

// The catalog argument lets tests exercise damaged entries without altering production catalogs.
export function createTranslator(japanese: Readonly<Partial<Record<MessageKey, unknown>>>) {
  return function translate<K extends MessageKey>(
    locale: AppLocale,
    key: K,
    ...args: TranslationArguments<K>
  ): string {
    const canonical = enUS[key];
    const render = (entry: unknown): string | undefined => {
      if (typeof entry !== typeof canonical) return undefined;
      try {
        const result: unknown =
          typeof entry === "function"
            ? (entry as (...parameters: TranslationArguments<K>) => unknown)(...args)
            : entry;
        return typeof result === "string" && result.trim().length > 0 ? result : undefined;
      } catch {
        return undefined;
      }
    };

    if (locale === "ja") {
      const translated = render(japanese[key]);
      if (translated !== undefined) return translated;
    }
    const fallback = render(canonical);
    if (fallback === undefined) throw new Error(`Invalid canonical translation: ${key}`);
    return fallback;
  };
}

export const translate = createTranslator(ja);
