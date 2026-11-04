/**
 * Vendored from @4pm/shared-constants (ai-prompts-cli.ts) by scripts/vendor-shared.mjs — do not edit.
 */
import cliDefaults from "./ai-prompt-defaults/cli.json";
import sharedDefaults from "./ai-prompt-defaults/shared.json";
export const CLI_PROMPT_DEFAULTS: Readonly<Record<string, string>> = { ...cliDefaults, ...sharedDefaults };
