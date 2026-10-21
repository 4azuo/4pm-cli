/**
 * Project output language — the language a project's spec (`output_lang`) asks the AI to write repo
 * content in (docs, code comments, commit / PR text, book rows). Only an instruction to the AI: the
 * prompts stay English and get one appended English directive; any language name works (the list is
 * the combo's shortcuts, *Other…* stores free text).
 * @adr 0581
 */

/** One listed output language: its code (stored in the spec), English name (sent to the AI) and native name (shown). */
export interface OutputLanguage {
  code: string;
  name: string;
  native: string;
}

/** The output languages the spec combo lists (native names are not translated). */
export const OUTPUT_LANGUAGES: readonly OutputLanguage[] = [
  { code: "en", name: "English", native: "English" },
  { code: "vi", name: "Vietnamese", native: "Tiếng Việt" },
  { code: "ja", name: "Japanese", native: "日本語" },
  { code: "zh", name: "Chinese", native: "中文" },
  { code: "ko", name: "Korean", native: "한국어" },
  { code: "fr", name: "French", native: "Français" },
  { code: "de", name: "German", native: "Deutsch" },
  { code: "es", name: "Spanish", native: "Español" },
  { code: "pt", name: "Portuguese", native: "Português" },
  { code: "th", name: "Thai", native: "ไทย" },
  { code: "id", name: "Indonesian", native: "Bahasa Indonesia" },
];

/** The spec field key holding the output language. */
export const OUTPUT_LANG_SPEC_KEY = "output_lang";

/** Longest free-text language name accepted (anything longer is ignored as invalid). */
const MAX_FREE_NAME = 40;

/**
 * The English name of a stored output language (`vi` → `Vietnamese`; free text → itself, trimmed), or
 * null when unset / invalid — null means "no rule".
 */
export function outputLanguageName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  if (!v) return null;
  const listed = OUTPUT_LANGUAGES.find((l) => l.code === v.toLowerCase());
  if (listed) return listed.name;
  // Free text: a plain language name only (letters, spaces, dashes, parentheses) — never prompt text.
  return v.length <= MAX_FREE_NAME && /^[\p{L}\p{M} ()-]+$/u.test(v) ? v : null;
}

/**
 * Read the output language name from a spec — the self-describing envelope (`fields[{id, value}]`) or the flat
 * working spec (`spec.output_lang`) — null when unset.
 */
export function specOutputLanguage(spec: unknown): string | null {
  if (!spec || typeof spec !== "object") return null;
  const fields = (spec as { fields?: unknown }).fields;
  if (Array.isArray(fields)) {
    const f = fields.find((x) => !!x && typeof x === "object" && (x as { id?: unknown }).id === OUTPUT_LANG_SPEC_KEY);
    if (f) return outputLanguageName((f as { value?: unknown }).value);
  }
  return outputLanguageName((spec as Record<string, unknown>)[OUTPUT_LANG_SPEC_KEY]);
}

/** The directive appended to a repo-output prompt (`{{language}}` = the English name). */
export const OUTPUT_LANGUAGE_DIRECTIVE =
  "Output language: write every document, code comment, commit message, pull-request text and book-row text you " +
  "produce in {{language}}. Keep code identifiers, file and folder names, paths, ids, JSON keys, commit types and " +
  "every fixed format these instructions require exactly as specified. These instructions are in English; only " +
  "your output follows this rule.";

/** The extra line for prompts that author the project guide file (`CLAUDE.md` / `AGENT.md`). */
export const OUTPUT_LANGUAGE_GUIDE_NOTE =
  'In the guide\'s conventions, include the line: "Write docs, code comments, commit messages and pull-request text ' +
  'in {{language}}."';

/** How a prompt's output lands in the repo: `true` = repo content, `"guide"` = it also authors the guide file. */
export type RepoOutputKind = true | "guide";

/** Append the output-language directive to a rendered prompt (unchanged when `language` is unset). */
export function withOutputLanguage(prompt: string, language: string | null | undefined, kind: RepoOutputKind = true): string {
  const name = outputLanguageName(language);
  if (!name) return prompt;
  const parts = [OUTPUT_LANGUAGE_DIRECTIVE, ...(kind === "guide" ? [OUTPUT_LANGUAGE_GUIDE_NOTE] : [])];
  return `${prompt.trimEnd()}\n\n${parts.map((p) => p.replace(/\{\{language\}\}/g, name)).join("\n")}`;
}
