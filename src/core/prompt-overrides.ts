/**
 * Server-managed AI prompt overrides (ADR-0381) — the admin-edited templates for cli-built prompts,
 * delivered on each ws_token (`promptOverrides`) keyed by prompt key → per-locale content. A builder
 * calls `resolveCliPrompt(key, vars)`: it renders the admin override for the active locale (falling
 * back to the base `en`) when present, else the shared registry default (`@4pm/constants`
 * `AI_PROMPTS`, whose text lives in `ai-prompt-defaults.json`). Platform-wide; refreshed on each
 * (re)connect, so an older server (no field) simply leaves the built-in default in place.
 */
import { AI_PROMPTS, renderPrompt } from "@4pm/constants";
import { getLocale } from "../i18n";

/** The current overrides map ({ "<key>": { "<locale>": "content" } }); empty until a ws_token sets it. */
let overrides: Record<string, Record<string, string>> = {};

/** Replace the override map from a ws_token (missing ⇒ cleared). */
export function setPromptOverrides(map?: Record<string, Record<string, string>> | null): void {
  overrides = map ?? {};
}

/** The override template for a key at the active locale (falls back to the base `en`), or null. */
function getPromptOverride(key: string): string | null {
  const byLocale = overrides[key];
  if (!byLocale) return null;
  return byLocale[getLocale()] ?? byLocale.en ?? null;
}

/**
 * Resolve a cli prompt: render the admin override (with `vars`) when one exists for this key, else
 * the shared registry default. Both are `{{var}}` templates.
 */
export function resolveCliPrompt(key: string, vars: Record<string, string | number>): string {
  const template = getPromptOverride(key) ?? AI_PROMPTS[key]?.defaultTemplate ?? "";
  return renderPrompt(template, vars);
}
