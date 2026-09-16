/**
 * CLI i18n (ADR-0276) — resolves the operator's locale and translates message keys for
 * user-facing errors. Locale precedence: the worker `config.json` `locale` (set from the
 * Worker configs form via config-sync, ADR-0141) → `FOURPM_LOCALE` / `LANG` / `LC_ALL` →
 * English. The catalog is self-contained (no next-intl); server-error text is keyed by the
 * shared `@4pm/constants` ErrorCode tokens where it maps a server code.
 */
import { normalizeLocale, type Locale } from "@4pm/constants";
import { catalogs, en, type CliMessageKey } from "./messages";

export type { CliMessageKey } from "./messages";

/** The active locale, resolved lazily (env → English) until `initI18n` runs. */
let current: Locale | undefined;

/**
 * Resolve the CLI locale: an explicit config value first, then the environment, then English.
 * `LANG` is typically `en_US.UTF-8`, so only its leading language subtag is considered.
 */
export function resolveLocale(configLocale?: string | null): Locale {
  if (configLocale) return normalizeLocale(configLocale);
  const env = process.env.FOURPM_LOCALE || process.env.LANG || process.env.LC_ALL || "";
  return normalizeLocale(env.split(/[_.@-]/)[0]);
}

/** Set the active locale once the profile config is known (call at command startup). */
export function initI18n(configLocale?: string | null): Locale {
  current = resolveLocale(configLocale);
  return current;
}

/** The active locale (lazily resolved from the environment → English until `initI18n` runs). */
export function getLocale(): Locale {
  return (current ??= resolveLocale());
}

/**
 * Translate a message key for the active locale, interpolating `{name}` tokens. Falls back
 * to the English catalog, then to the raw key, so a missing translation never throws.
 */
export function t(key: CliMessageKey, params?: Record<string, string | number>): string {
  const table = catalogs[getLocale()] ?? en;
  let str = table[key] ?? en[key] ?? key;
  if (params) {
    for (const [name, value] of Object.entries(params)) {
      str = str.replaceAll(`{${name}}`, String(value));
    }
  }
  return str;
}
