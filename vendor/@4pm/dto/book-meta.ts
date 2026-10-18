/**
 * Book metadata cells — `Tags` (comma-separated tag codes) and `Due` (`YYYY-MM-DD`) on USER_TODO / USER_QA /
 * AI_TODO / AI_DONE rows. They sit outside the signed content and the authorship stamp, so the helpers here
 * compare rows *without* them and parse / format the two cells for every writer (web, server, cli).
 * `Issue` (the linked issue ref — ADR-0546) and `Title` (the row's short name — ADR-0549) are metadata in the same way.
 * @adr 0543 @adr 0546 @adr 0549
 */
import { BOOK_TITLE_MAX, DUE_DATE_RE, TAG_CODE_RE } from "@4pm/constants";

/** The metadata columns, lower-cased (as `bookRowsById` keys cells) — `Issue` and `Title` too. */
export const BOOK_META_COLUMNS = ["tags", "due", "issue", "title"] as const;

/** The header names writers use for the metadata columns. */
export const BOOK_TAGS_HEADER = "Tags";
export const BOOK_DUE_HEADER = "Due";
export const BOOK_ISSUE_HEADER = "Issue";
export const BOOK_TITLE_HEADER = "Title";

/** True when `header` (any case) names a metadata column. */
export function isBookMetaColumn(header: string): boolean {
  return (BOOK_META_COLUMNS as readonly string[]).includes(header.trim().toLowerCase());
}

/** Split a `Tags` cell into codes — trimmed, lower-cased, deduplicated, in order; blanks dropped. */
export function parseTagsCell(cell: string): string[] {
  const out: string[] = [];
  for (const raw of cell.split(/[,\s]+/)) {
    const code = raw.trim().toLowerCase();
    if (code && !out.includes(code)) out.push(code);
  }
  return out;
}

/** Render codes as a `Tags` cell (`a, b`). */
export function formatTagsCell(codes: readonly string[]): string {
  return parseTagsCell(codes.join(",")).join(", ");
}

/** The codes of a `Tags` cell that are not valid tag codes. */
export function malformedTagCodes(cell: string): string[] {
  return parseTagsCell(cell).filter((c) => !TAG_CODE_RE.test(c));
}

/** True when `value` is a real calendar date written `YYYY-MM-DD`. */
export function isValidDue(value: string): boolean {
  if (!DUE_DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** True when a `Due` cell is empty or a valid date. */
export function isValidDueCell(cell: string): boolean {
  const v = cell.trim();
  return v === "" || isValidDue(v);
}

/**
 * Normalize a row title: one line (whitespace collapsed, `|` dropped), trimmed, cut at `BOOK_TITLE_MAX` chars.
 * @adr 0549
 */
export function clampBookTitle(value: string): string {
  const one = value.replace(/\|/g, " ").replace(/\s+/g, " ").trim();
  return one.length > BOOK_TITLE_MAX ? one.slice(0, BOOK_TITLE_MAX).trimEnd() : one;
}

/** True when a `Title` cell fits `BOOK_TITLE_MAX` (after trimming). @adr 0549 */
export function isValidTitleCell(cell: string): boolean {
  return cell.trim().length <= BOOK_TITLE_MAX;
}

/** A cells record without the metadata columns (keys compared lower-cased). */
export function withoutMetaCells(cells: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(cells)) if (!isBookMetaColumn(k)) out[k.toLowerCase()] = v;
  return out;
}

/**
 * True when two rows hold the same content — every cell but `Tags` / `Due` equal. A column present on one side
 * only counts as empty on the other, so adding an empty column changes nothing.
 */
export function bookCellsContentEqual(a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>): boolean {
  const x = withoutMetaCells(a);
  const y = withoutMetaCells(b);
  for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) {
    if ((x[k] ?? "").trim() !== (y[k] ?? "").trim()) return false;
  }
  return true;
}
