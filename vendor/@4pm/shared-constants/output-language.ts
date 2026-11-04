/**
 * Vendored from @4pm/shared-constants (output-language.ts) by scripts/vendor-shared.mjs — do not edit.
 */
export interface OutputLanguage {
    code: string;
    name: string;
    native: string;
}
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
export const OUTPUT_LANG_SPEC_KEY = "output_lang";
const MAX_FREE_NAME = 40;
export function outputLanguageName(value: unknown): string | null {
    if (typeof value !== "string")
        return null;
    const v = value.trim();
    if (!v)
        return null;
    const listed = OUTPUT_LANGUAGES.find((l) => l.code === v.toLowerCase());
    if (listed)
        return listed.name;
    return v.length <= MAX_FREE_NAME && /^[\p{L}\p{M} ()-]+$/u.test(v) ? v : null;
}
export function specOutputLanguage(spec: unknown): string | null {
    if (!spec || typeof spec !== "object")
        return null;
    const fields = (spec as {
        fields?: unknown;
    }).fields;
    if (Array.isArray(fields)) {
        const f = fields.find((x) => !!x && typeof x === "object" && (x as {
            id?: unknown;
        }).id === OUTPUT_LANG_SPEC_KEY);
        if (f)
            return outputLanguageName((f as {
                value?: unknown;
            }).value);
    }
    return outputLanguageName((spec as Record<string, unknown>)[OUTPUT_LANG_SPEC_KEY]);
}
export const OUTPUT_LANGUAGE_DIRECTIVE = "Output language: write every document, code comment, commit message, pull-request text and book-row text you " +
    "produce in {{language}}. Keep code identifiers, file and folder names, paths, ids, JSON keys, commit types and " +
    "every fixed format these instructions require exactly as specified. These instructions are in English; only " +
    "your output follows this rule.";
export const OUTPUT_LANGUAGE_GUIDE_NOTE = 'In the guide\'s conventions, include the line: "Write docs, code comments, commit messages and pull-request text ' +
    'in {{language}}."';
export type RepoOutputKind = true | "guide";
export function withOutputLanguage(prompt: string, language: string | null | undefined, kind: RepoOutputKind = true): string {
    const name = outputLanguageName(language);
    if (!name)
        return prompt;
    const parts = [OUTPUT_LANGUAGE_DIRECTIVE, ...(kind === "guide" ? [OUTPUT_LANGUAGE_GUIDE_NOTE] : [])];
    return `${prompt.trimEnd()}\n\n${parts.map((p) => p.replace(/\{\{language\}\}/g, name)).join("\n")}`;
}
