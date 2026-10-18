/**
 * Row guards of a web book save, checked on the books branch before anything is written: a deleted row
 * must have no dependents left in any book's `Depends`, and a row under a live `AI_PROGRESS` claim (the AI
 * is working on it) may not be added, edited or deleted.
 * @adr 0538 @adr 0543
 */
import { bookCellsContentEqual, bookDependents, bookRowsById, liveClaimedIds } from "@4pm/dto";

/** A guard refusal: the code, the first offending row and what blocks it. */
export interface RowGuardRefusal {
  code: "BOOK_ROW_HAS_DEPENDENTS" | "BOOK_ROW_CLAIMED";
  failedId: string;
  /** The dependent rows, or the worker holding the claim. */
  blockers: string[];
}

/**
 * Check one book save (`prevMd` → `nextMd`) against the other books after the save (`booksAfter`, this book
 * included) and the claims in `progress`. Null when the save passes.
 */
export function checkRowGuards(
  prevMd: string,
  nextMd: string,
  booksAfter: readonly string[],
  progress: string,
  ttl: { claimTtlHours: number; runTimeoutMinutes: number },
): RowGuardRefusal | null {
  const prev = bookRowsById(prevMd);
  const next = bookRowsById(nextMd);
  const removed = [...prev.keys()].filter((id) => !next.has(id));
  const touched = [
    ...removed,
    // A `Tags` / `Due` edit alone is metadata (ADR-0543) — allowed while the AI holds the row.
    ...[...next.keys()].filter((id) => !prev.has(id) || prev.get(id)!.team !== next.get(id)!.team || !bookCellsContentEqual(prev.get(id)!.cells, next.get(id)!.cells)),
  ];
  const claimed = liveClaimedIds(progress, ttl);
  const busy = touched.find((id) => claimed.has(id));
  if (busy) return { code: "BOOK_ROW_CLAIMED", failedId: busy, blockers: [claimed.get(busy) ?? ""] };
  if (removed.length) {
    const deps = bookDependents(booksAfter, removed);
    const first = [...deps.entries()][0];
    if (first) return { code: "BOOK_ROW_HAS_DEPENDENTS", failedId: first[0], blockers: first[1] };
  }
  return null;
}
