/**
 * Vendored from @4pm/dto (book-ids.ts) by scripts/vendor-shared.mjs — do not edit.
 */
import { z } from "zod";
export const BOOK_GROUP_DIGITS = 6;
export const BOOK_ROW_DIGITS = 3;
export const BOOK_GROUP_MAX = 10 ** BOOK_GROUP_DIGITS - 1;
export const BOOK_ROW_MAX = 10 ** BOOK_ROW_DIGITS - 1;
export type BookIdPrefix = "REQ" | "TSK" | "QA" | "DOC" | "AST";
export const TASK_ROW_PREFIXES = ["TSK", "DOC", "AST"] as const;
export const TASK_ROW_ID_SOURCE = `(?:TSK|DOC|AST)-\\d{6}-\\d{3}`;
export const BOOK_ID_SOURCE = `[A-Z]+-\\d{${BOOK_GROUP_DIGITS}}-\\d{${BOOK_ROW_DIGITS}}`;
export const BOOK_ID_RE = new RegExp(`^([A-Z]+)-(\\d{${BOOK_GROUP_DIGITS}})-(\\d{${BOOK_ROW_DIGITS}})$`);
export const BOOK_ID_GLOBAL_RE = new RegExp(`\\b${BOOK_ID_SOURCE}\\b`, "g");
export function bookGroupCode(group: number): string {
    return String(group).padStart(BOOK_GROUP_DIGITS, "0");
}
export function bookRowId(prefix: BookIdPrefix, group: number | string, row: number): string {
    const g = typeof group === "number" ? bookGroupCode(group) : group;
    return `${prefix}-${g}-${String(row).padStart(BOOK_ROW_DIGITS, "0")}`;
}
export function isBookRowId(id: string): boolean {
    return BOOK_ID_RE.test(id);
}
export const bookRowIdParamSchema = z.string().refine(isBookRowId, { message: "invalid row id" });
export function bookGroupOf(id: string): string | null {
    return BOOK_ID_RE.exec(id)?.[2] ?? null;
}
export function bookGroupKey(id: string): string | null {
    const m = BOOK_ID_RE.exec(id);
    return m ? `${m[1]}-${m[2]}` : null;
}
export function isTaskRowId(id: string): boolean {
    return /^(?:TSK|DOC|AST)-\d{6}-\d{3}$/.test(id);
}
export function isAssetRowId(id: string): boolean {
    return /^AST-\d{6}-\d{3}$/.test(id);
}
export function isRoundRowId(id: string): boolean {
    return /^(?:DOC|AST)-\d{6}-\d{3}$/.test(id);
}
export function isDocRowId(id: string): boolean {
    return /^DOC-\d{6}-\d{3}$/.test(id);
}
export function designGroupKey(id: string): string {
    const m = /^(?:TSK|DOC|AST|QA)-(\d{6})-/.exec(id);
    return m ? `TSK-${m[1]}` : "";
}
export function qaIdsIn(text: string): string[] {
    const re = new RegExp(`\\bQA-\\d{${BOOK_GROUP_DIGITS}}-\\d{${BOOK_ROW_DIGITS}}\\b`, "g");
    return Array.from(new Set(text.match(re) ?? []));
}
export const BOOK_GROUPS_PER_REQUEST = 50;
export const allocateBookGroupsSchema = z.object({
    count: z.number().int().min(1).max(BOOK_GROUPS_PER_REQUEST).default(1),
});
export type AllocateBookGroupsRequest = z.infer<typeof allocateBookGroupsSchema>;
export interface AllocateBookGroupsResponse {
    groups: number[];
}
