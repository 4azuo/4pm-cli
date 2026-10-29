/**
 * Server-managed AI prompt overrides — the admin-edited templates for cli-built prompts,
 * delivered on each ws_token (`promptOverrides`) keyed by prompt key → per-locale content. A builder
 * calls `resolveCliPrompt(key, vars)`: it renders the admin override for the active locale (falling
 * back to the base `en`) when present, else the built-in default (`@4pm/constants`
 * `CLI_PROMPT_DEFAULTS` — the `cli.*` templates only). Platform-wide; refreshed on each
 * (re)connect, so an older server (no field) simply leaves the built-in default in place.
 *
 * The served project's output language (ws_token / project.tokens `outputLang`; an older server ⇒ the
 * `project.spec.json` of the project root) appends its directive to the repo-output prompts.
 * @adr 0381 @adr 0581 @adr 0684
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AI_PROMPT_META, CLI_PROMPT_DEFAULTS, renderCatalogPrompt, specOutputLanguage } from "@4pm/constants";
import { getLocale } from "../../i18n";

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

/** The served project's output language from the server; `undefined` = not sent (older server) ⇒ read the spec file. */
let serverOutputLang: string | null | undefined;
/** The served project's root (for the spec-file fallback); null when idle. */
let projectRoot: string | null = null;

/** Apply the server's `outputLang` (ws_token / project.tokens); `undefined` (an older server) keeps the fallback. */
export function setOutputLanguage(lang: string | null | undefined): void {
  serverOutputLang = lang;
}

/** Remember the served project's root, where the fallback reads `project.spec.json`. */
export function setOutputLanguageRoot(root: string | null): void {
  projectRoot = root;
}

/** The output language of the served project: the server's value, else the root's `project.spec.json`, else null. */
export function projectOutputLanguage(): string | null {
  if (serverOutputLang !== undefined) return specOutputLanguage({ output_lang: serverOutputLang });
  if (!projectRoot) return null;
  try {
    return specOutputLanguage(JSON.parse(readFileSync(join(projectRoot, "project.spec.json"), "utf8")));
  } catch {
    return null; // no spec file / unreadable ⇒ no rule
  }
}

/** Per-call options of {@link resolveCliPrompt}. */
export interface ResolveCliPromptOptions {
  /** The output language to use instead of the served project's (e.g. scaffold, from the spec it writes). */
  outputLang?: string | null;
}

/**
 * Resolve a cli prompt: render the admin override (with `vars`) when one exists for this key, else
 * the shared registry default. Both are `{{var}}` templates. A repo-output prompt gets the project's
 * output-language directive.
 */
export function resolveCliPrompt(key: string, vars: Record<string, string | number>, opts: ResolveCliPromptOptions = {}): string {
  const template = getPromptOverride(key) ?? CLI_PROMPT_DEFAULTS[key] ?? "";
  // Untrusted vars are wrapped per the registry (ADR-0421), override or default alike.
  const outputLang = opts.outputLang !== undefined ? opts.outputLang : AI_PROMPT_META[key]?.repoOutput ? projectOutputLanguage() : null;
  return renderCatalogPrompt(key, template, vars, { outputLang });
}
