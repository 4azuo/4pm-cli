/**
 * Vendored from @4pm/dto (book-meta.ts) by scripts/vendor-shared.mjs — do not edit.
 */
import { BOOK_TITLE_MAX, DUE_DATE_RE, TAG_CODE_RE } from "@4pm/shared-constants";
export const BOOK_META_COLUMNS = ["tags", "due", "issue", "title", "assignees"] as const;
export const BOOK_TAGS_HEADER = "Tags";
export const BOOK_DUE_HEADER = "Due";
export const BOOK_ISSUE_HEADER = "Issue";
export const BOOK_TITLE_HEADER = "Title";
export const BOOK_ASSIGNEES_HEADER = "Assignees";
export const BOOK_ASSIGNEES_MAX = 10;
const ASSIGNEE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isBookMetaColumn(header: string): boolean {
    return (BOOK_META_COLUMNS as readonly string[]).includes(header.trim().toLowerCase());
}
export function parseTagsCell(cell: string): string[] {
    const out: string[] = [];
    for (const raw of cell.split(/[,\s]+/)) {
        const code = raw.trim().toLowerCase();
        if (code && !out.includes(code))
            out.push(code);
    }
    return out;
}
export function formatTagsCell(codes: readonly string[]): string {
    return parseTagsCell(codes.join(",")).join(", ");
}
export function malformedTagCodes(cell: string): string[] {
    return parseTagsCell(cell).filter((c) => !TAG_CODE_RE.test(c));
}
export function parseAssigneesCell(cell: string): string[] {
    const out: string[] = [];
    for (const raw of cell.split(/[,\s]+/)) {
        const id = raw.trim().toLowerCase();
        if (id && !out.includes(id))
            out.push(id);
    }
    return out;
}
export function formatAssigneesCell(ids: readonly string[]): string {
    return parseAssigneesCell(ids.join(",")).join(", ");
}
export function isValidAssigneesCell(cell: string): boolean {
    const ids = parseAssigneesCell(cell);
    return ids.length <= BOOK_ASSIGNEES_MAX && ids.every((id) => ASSIGNEE_ID_RE.test(id));
}
export function isValidDue(value: string): boolean {
    if (!DUE_DATE_RE.test(value))
        return false;
    const d = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}
export function isValidDueCell(cell: string): boolean {
    const v = cell.trim();
    return v === "" || isValidDue(v);
}
export function clampBookTitle(value: string): string {
    const one = value.replace(/\|/g, " ").replace(/\s+/g, " ").trim();
    return one.length > BOOK_TITLE_MAX ? one.slice(0, BOOK_TITLE_MAX).trimEnd() : one;
}
export function isValidTitleCell(cell: string): boolean {
    return cell.trim().length <= BOOK_TITLE_MAX;
}
export function withoutMetaCells(cells: Readonly<Record<string, string>>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(cells))
        if (!isBookMetaColumn(k))
            out[k.toLowerCase()] = v;
    return out;
}
export function bookCellsContentEqual(a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>): boolean {
    const x = withoutMetaCells(a);
    const y = withoutMetaCells(b);
    for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) {
        if ((x[k] ?? "").trim() !== (y[k] ?? "").trim())
            return false;
    }
    return true;
}
