/**
 * CLI message catalogs (ADR-0276) — one JSON file per locale (`<locale>.json`), flat dotted
 * keys with `{name}` interpolation tokens, kept as JSON for easy scanning/editing. English is
 * the source of truth + fallback, and its keys define the valid key set. tsup inlines these
 * JSON files into the single bundle, so no runtime file reads are needed.
 */
import { Locale } from "@4pm/constants";
import en from "./en.json";
import vi from "./vi.json";
import ja from "./ja.json";
import zh from "./zh.json";

/** Valid message keys, derived from the English catalog. */
export type CliMessageKey = keyof typeof en;

/** The catalog shape — every locale provides the same keys. */
export type CliMessages = Record<CliMessageKey, string>;

export { en };

/** Per-locale catalogs (each JSON must carry the same keys as `en.json` — checked by the compiler). */
export const catalogs: Record<Locale, CliMessages> = {
  [Locale.EN]: en,
  [Locale.VI]: vi,
  [Locale.JA]: ja,
  [Locale.ZH]: zh,
};
