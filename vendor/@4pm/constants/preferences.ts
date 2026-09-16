/**
 * User preference enums for the web dashboard (ADR-0001) — imported by both
 * server and web so values stay in sync for future per-user preferences.
 */

/** Color theme (each theme has one CSS-variables file in the web app). */
export const ThemeId = {
  DEFAULT: "default",
  EIGHT_BIT: "8bit",
  FLAT: "flat",
} as const;

/** Theme union type. */
export type ThemeId = (typeof ThemeId)[keyof typeof ThemeId];

/** Light/dark mode. */
export const ColorMode = {
  LIGHT: "light",
  DARK: "dark",
  SYSTEM: "system",
} as const;

/** Color mode union type. */
export type ColorMode = (typeof ColorMode)[keyof typeof ColorMode];

/** UI language. */
export const Locale = {
  VI: "vi",
  EN: "en",
  ZH: "zh",
  JA: "ja",
} as const;

/** Locale union type. */
export type Locale = (typeof Locale)[keyof typeof Locale];

/** Supported UI locales (order = the language switcher's order). */
export const SUPPORTED_LOCALES: Locale[] = [Locale.EN, Locale.VI, Locale.ZH, Locale.JA];

/** Default (fallback) locale. */
export const DEFAULT_LOCALE: Locale = Locale.EN;

/** Normalize any value to a supported locale, falling back to the default. */
export function normalizeLocale(value: string | undefined | null): Locale {
  return SUPPORTED_LOCALES.includes(value as Locale) ? (value as Locale) : DEFAULT_LOCALE;
}

/** Display density. */
export const Density = {
  COMFORTABLE: "comfortable",
  COMPACT: "compact",
} as const;

/** Density union type. */
export type Density = (typeof Density)[keyof typeof Density];
