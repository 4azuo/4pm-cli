/**
 * Vendored from @4pm/shared-constants (preferences.ts) by scripts/vendor-shared.mjs — do not edit.
 */
export const ThemeId = {
    DEFAULT: "default",
    EIGHT_BIT: "8bit",
    FLAT: "flat",
} as const;
export type ThemeId = (typeof ThemeId)[keyof typeof ThemeId];
export const ColorMode = {
    LIGHT: "light",
    DARK: "dark",
    SYSTEM: "system",
} as const;
export type ColorMode = (typeof ColorMode)[keyof typeof ColorMode];
export const Locale = {
    VI: "vi",
    EN: "en",
    ZH: "zh",
    JA: "ja",
} as const;
export type Locale = (typeof Locale)[keyof typeof Locale];
export const SUPPORTED_LOCALES: Locale[] = [Locale.EN, Locale.VI, Locale.ZH, Locale.JA];
export const DEFAULT_LOCALE: Locale = Locale.EN;
export function normalizeLocale(value: string | undefined | null): Locale {
    return SUPPORTED_LOCALES.includes(value as Locale) ? (value as Locale) : DEFAULT_LOCALE;
}
export const Density = {
    COMFORTABLE: "comfortable",
    COMPACT: "compact",
} as const;
export type Density = (typeof Density)[keyof typeof Density];
export const MotionPref = {
    SYSTEM: "system",
    FULL: "full",
    REDUCED: "reduced",
    OFF: "off",
} as const;
export type MotionPref = (typeof MotionPref)[keyof typeof MotionPref];
export const MOTION_PREFS: MotionPref[] = [MotionPref.SYSTEM, MotionPref.FULL, MotionPref.REDUCED, MotionPref.OFF];
