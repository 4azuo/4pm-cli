/**
 * The cli's built-in prompt defaults — the `cli.*` templates plus the few shared with the web
 * (`shared.json`), so the cli bundle and its public vendor copy never carry the other web / server prompts.
 * @adr 0684 @arch 0047
 */
import cliDefaults from "./ai-prompt-defaults/cli.json";
import sharedDefaults from "./ai-prompt-defaults/shared.json";

/** Seed / fallback template per prompt key the cli builds. */
export const CLI_PROMPT_DEFAULTS: Readonly<Record<string, string>> = { ...cliDefaults, ...sharedDefaults };
