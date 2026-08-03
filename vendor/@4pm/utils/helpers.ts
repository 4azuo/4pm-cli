/**
 * Pure helpers with no domain dependency (usable in both browser and node).
 */

/** Wait `ms` milliseconds (Promise). */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Compute the retry wait time using exponential backoff + jitter.
 * @param attempt the attempt number (starting at 0)
 * @param baseMs  the base time
 * @param maxMs   the wait-time cap
 */
export function backoffJitterMs(
  attempt: number,
  baseMs = 500,
  maxMs = 10_000,
): number {
  const exp = Math.min(baseMs * 2 ** attempt, maxMs);
  return Math.floor(exp / 2 + Math.random() * (exp / 2));
}

/**
 * Detect whether a chunk of text is machine-readable output worth collapsing (ADR-0108):
 * JSON (leading `{`/`[`) or a fenced code block (leading ```` ``` ````). Returns the kind or
 * `null` for anything else (plain prose is never collapsed). Leading whitespace is ignored so
 * it works on the first streamed chunk.
 */
export function looksLikeJsonOrCode(text: string): "json" | "code" | null {
  const t = text.replace(/^\s+/, "");
  if (t.startsWith("```")) return "code";
  if (t.startsWith("{") || t.startsWith("[")) return "json";
  return null;
}

/**
 * Pretty-print a collapsed result for display when expanded (ADR-0108): JSON is re-indented
 * (2 spaces), tolerating trailing prose by parsing the outermost `{…}`/`[…]` slice; code and
 * unparseable text are returned trimmed and unchanged.
 */
export function prettyResult(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.stringify(JSON.parse(trimmed), null, 2);
    } catch {
      // Tolerate leading/trailing prose around the JSON: re-parse the outermost brace/bracket slice.
      const start = trimmed.search(/[{[]/);
      const end = Math.max(trimmed.lastIndexOf("}"), trimmed.lastIndexOf("]"));
      if (start >= 0 && end > start) {
        try {
          return JSON.stringify(JSON.parse(trimmed.slice(start, end + 1)), null, 2);
        } catch {
          // Fall through — keep the raw text below.
        }
      }
    }
  }
  return trimmed;
}

/**
 * Build a query string from an object (skips null/undefined/empty-string values).
 */
export function buildQueryString(
  params: Record<string, string | number | boolean | null | undefined>,
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === "") continue;
    search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `?${qs}` : "";
}
