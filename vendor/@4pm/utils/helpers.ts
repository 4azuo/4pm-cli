/**
 * Vendored from @4pm/utils (helpers.ts) by scripts/vendor-shared.mjs — do not edit.
 */
export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
export function backoffJitterMs(attempt: number, baseMs = 500, maxMs = 10000): number {
    const exp = Math.min(baseMs * 2 ** attempt, maxMs);
    return Math.floor(exp / 2 + Math.random() * (exp / 2));
}
export function looksLikeJsonOrCode(text: string): "json" | "code" | null {
    const t = text.replace(/^\s+/, "");
    if (t.startsWith("```"))
        return "code";
    if (t.startsWith("{") || t.startsWith("["))
        return "json";
    return null;
}
export function prettyResult(text: string): string {
    const trimmed = text.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try {
            return JSON.stringify(JSON.parse(trimmed), null, 2);
        }
        catch {
            const start = trimmed.search(/[{[]/);
            const end = Math.max(trimmed.lastIndexOf("}"), trimmed.lastIndexOf("]"));
            if (start >= 0 && end > start) {
                try {
                    return JSON.stringify(JSON.parse(trimmed.slice(start, end + 1)), null, 2);
                }
                catch {
                }
            }
        }
    }
    return trimmed;
}
export function buildQueryString(params: Record<string, string | number | boolean | null | undefined>): string {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
        if (value === null || value === undefined || value === "")
            continue;
        search.set(key, String(value));
    }
    const qs = search.toString();
    return qs ? `?${qs}` : "";
}
