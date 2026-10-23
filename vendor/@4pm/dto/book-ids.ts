/**
 * Book row ids `PREFIX-GGGGGG-NNN` (`REQ` · `TSK` · `QA` · `DOC`): a 6-digit group allocated by the server from the
 * project's group counter + a 3-digit row number given by whoever owns the group. The group key
 * `PREFIX-GGGGGG` names a group's mockups, sequences and task branches. Fixed width, so string order = numeric
 * order. Shared by web / server / cli — every id pattern comes from here. A `DOC-…` row (the docs of one request,
 * ADR-0536) sits in `AI_TODO` beside the `TSK-…` rows of its group and is claimed like a task.
 * @adr 0455 @adr 0536
 */
import { z } from "zod";

/** Digits of the group part. */
export const BOOK_GROUP_DIGITS = 6;
/** Digits of the row part. */
export const BOOK_ROW_DIGITS = 3;
/** The largest group / row number. */
export const BOOK_GROUP_MAX = 10 ** BOOK_GROUP_DIGITS - 1;
export const BOOK_ROW_MAX = 10 ** BOOK_ROW_DIGITS - 1;

/** The id prefixes of the books. */
export type BookIdPrefix = "REQ" | "TSK" | "QA" | "DOC" | "AST";

/** The `AI_TODO` row prefixes the cycle claims and runs: tasks, docs and assets rows. @adr 0536 @adr 0615 */
export const TASK_ROW_PREFIXES = ["TSK", "DOC", "AST"] as const;
/** A `TSK-…`, `DOC-…` or `AST-…` row id (no anchors / groups) — for embedding in larger patterns. @adr 0536 @adr 0615 */
export const TASK_ROW_ID_SOURCE = `(?:TSK|DOC|AST)-\\d{6}-\\d{3}`;

/** Regex source of any row id (no anchors / groups) — for embedding in larger patterns. */
export const BOOK_ID_SOURCE = `[A-Z]+-\\d{${BOOK_GROUP_DIGITS}}-\\d{${BOOK_ROW_DIGITS}}`;
/** A whole row id: groups = prefix, group digits, row digits. */
export const BOOK_ID_RE = new RegExp(`^([A-Z]+)-(\\d{${BOOK_GROUP_DIGITS}})-(\\d{${BOOK_ROW_DIGITS}})$`);
/** Row ids inside a text (global). */
export const BOOK_ID_GLOBAL_RE = new RegExp(`\\b${BOOK_ID_SOURCE}\\b`, "g");

/** The 6-digit group code of a group number. */
export function bookGroupCode(group: number): string {
  return String(group).padStart(BOOK_GROUP_DIGITS, "0");
}

/** The row id `PREFIX-GGGGGG-NNN`. */
export function bookRowId(prefix: BookIdPrefix, group: number | string, row: number): string {
  const g = typeof group === "number" ? bookGroupCode(group) : group;
  return `${prefix}-${g}-${String(row).padStart(BOOK_ROW_DIGITS, "0")}`;
}

/** True for a well-formed row id. */
export function isBookRowId(id: string): boolean {
  return BOOK_ID_RE.test(id);
}

/** A book row id path parameter (`PREFIX-GGGGGG-NNN`). @adr 0539 */
export const bookRowIdParamSchema = z.string().refine(isBookRowId, { message: "invalid row id" });

/** The group code (`GGGGGG`) of a row id, or null. */
export function bookGroupOf(id: string): string | null {
  return BOOK_ID_RE.exec(id)?.[2] ?? null;
}

/** The group key `PREFIX-GGGGGG` of a row id (e.g. `TSK-000123`), or null. */
export function bookGroupKey(id: string): string | null {
  const m = BOOK_ID_RE.exec(id);
  return m ? `${m[1]}-${m[2]}` : null;
}

/** True for a `TSK-…`, `DOC-…` or `AST-…` id — an `AI_TODO` row the cycle claims. @adr 0536 @adr 0615 */
export function isTaskRowId(id: string): boolean {
  return /^(?:TSK|DOC|AST)-\d{6}-\d{3}$/.test(id);
}

/** True for an `AST-…` id (an assets row). @adr 0615 */
export function isAssetRowId(id: string): boolean {
  return /^AST-\d{6}-\d{3}$/.test(id);
}

/** True for a row reviewed in rounds before it is accepted: a `DOC-…` or an `AST-…`. @adr 0615 */
export function isRoundRowId(id: string): boolean {
  return /^(?:DOC|AST)-\d{6}-\d{3}$/.test(id);
}

/** True for a `DOC-…` id. @adr 0536 */
export function isDocRowId(id: string): boolean {
  return /^DOC-\d{6}-\d{3}$/.test(id);
}

/**
 * The design-group key `TSK-GGGGGG` of a task / docs / question id — the name the group's mockups, sequences and
 * change requests use, whatever the row's own prefix (`DOC-000123-001` → `TSK-000123`); "" when none.
 * @adr 0453 @adr 0536
 */
export function designGroupKey(id: string): string {
  const m = /^(?:TSK|DOC|AST|QA)-(\d{6})-/.exec(id);
  return m ? `TSK-${m[1]}` : "";
}

/** The QA ids mentioned in a text (e.g. a task's `Depends`), de-duplicated. */
export function qaIdsIn(text: string): string[] {
  const re = new RegExp(`\\bQA-\\d{${BOOK_GROUP_DIGITS}}-\\d{${BOOK_ROW_DIGITS}}\\b`, "g");
  return Array.from(new Set(text.match(re) ?? []));
}

/** Most groups one allocation may ask for. */
export const BOOK_GROUPS_PER_REQUEST = 50;

/** Body POST /machines/:id/autonomous/book-groups — allocate fresh group numbers. @api machine-0082 */
export const allocateBookGroupsSchema = z.object({
  count: z.number().int().min(1).max(BOOK_GROUPS_PER_REQUEST).default(1),
});
export type AllocateBookGroupsRequest = z.infer<typeof allocateBookGroupsSchema>;

/** Response of machine-0082 — group numbers never handed out before in this project. */
export interface AllocateBookGroupsResponse {
  groups: number[];
}
