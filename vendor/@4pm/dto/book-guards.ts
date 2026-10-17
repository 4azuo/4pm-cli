/**
 * Book row guards shared by the web (warn before a save) and the cli (refuse the save): a row another row
 * still lists in its `Depends` cannot be deleted, and a row under a live `AI_PROGRESS` claim cannot be edited
 * or deleted. Pure functions over the book markdown.
 * @adr 0538
 */
import { bookRowsById } from "./autonomous-approval";

/** Split a `Depends` cell into its row ids (comma / space separated). */
export function dependsIds(cell: string): string[] {
  return cell
    .split(/[,\s]+/)
    .map((x) => x.trim())
    .filter((x) => /^[A-Z]+-\d/.test(x));
}

/**
 * For each id in `ids`, the rows of `books` (USER_TODO / USER_QA / AI_TODO markdown) whose `Depends` cell
 * names it — a row never counts as its own dependent, and neither does another id being deleted in the same
 * save. Only ids with at least one dependent are returned.
 */
export function bookDependents(books: readonly string[], ids: readonly string[]): Map<string, string[]> {
  const deleting = new Set(ids);
  const out = new Map<string, string[]>();
  for (const md of books) {
    for (const [rowId, row] of bookRowsById(md)) {
      if (deleting.has(rowId)) continue;
      for (const dep of dependsIds(row.cells.depends ?? "")) {
        if (!deleting.has(dep)) continue;
        const list = out.get(dep) ?? [];
        if (!list.includes(rowId)) list.push(rowId);
        out.set(dep, list);
      }
    }
  }
  return out;
}

/** One row of `AI_PROGRESS.md`: a task claim (`TSK-…`) or an intake claim (`REQ-…` / `QA-…`). */
export interface BookClaimRow {
  kind: "task" | "intake";
  id: string;
  worker: string;
  /** The UTC stamp the claim was written (`YYYY-MM-DD HH:mm[:ss]`). */
  started: string;
}

/** Parse the claim rows of `AI_PROGRESS.md` by header name. */
export function parseBookClaims(progress: string): BookClaimRow[] {
  const out: BookClaimRow[] = [];
  for (const [id, row] of bookRowsById(progress)) {
    const kind = id.startsWith("TSK-") ? "task" : /^(REQ|QA)-/.test(id) ? "intake" : null;
    if (!kind || !row.cells.started) continue;
    out.push({ kind, id, worker: row.cells.worker ?? "", started: row.cells.started });
  }
  return out;
}

/** Epoch ms of a books stamp (UTC when no zone is given); NaN when unparsable. */
export function bookStampMs(stamp: string): number {
  const iso = stamp.trim().replace(" ", "T");
  return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`);
}

/** Grace added to the run timeout before an intake claim counts as abandoned. @adr 0529 */
export const INTAKE_CLAIM_GRACE_MINUTES = 15;

/**
 * The ids under a **live** claim → the worker holding it. A task claim lives `claimTtlHours`, an intake claim
 * `runTimeoutMinutes` + 15 min; an expired claim no longer locks its row.
 */
export function liveClaimedIds(
  progress: string,
  ttl: { claimTtlHours: number; runTimeoutMinutes: number },
  now = Date.now(),
): Map<string, string> {
  const out = new Map<string, string>();
  for (const c of parseBookClaims(progress)) {
    const age = now - bookStampMs(c.started);
    const limit = c.kind === "task" ? ttl.claimTtlHours * 3_600_000 : (ttl.runTimeoutMinutes + INTAKE_CLAIM_GRACE_MINUTES) * 60_000;
    if (Number.isFinite(age) && age < limit) out.set(c.id, c.worker);
  }
  return out;
}
