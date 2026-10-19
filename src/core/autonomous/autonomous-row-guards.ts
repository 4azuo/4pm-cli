/**
 * Row guards of a web book save, checked on the books branch before anything is written: a deleted row
 * must have no dependents left in any book's `Depends`, and a row under a live `AI_PROGRESS` claim (the AI
 * is working on it) may not be added, edited or deleted. A request / question kept as history (a `State`) may not
 * be edited or deleted, and no save may set or change a `State` (the cli is its only writer).
 * @adr 0538 @adr 0543 @adr 0562
 */
import { bookCellsContentEqual, bookDependents, bookRowsById, liveClaimedIds, parseBookState } from "@4pm/dto";

/** A guard refusal: the code, the first offending row and what blocks it. */
export interface RowGuardRefusal {
  code: "BOOK_ROW_HAS_DEPENDENTS" | "BOOK_ROW_CLAIMED" | "BOOK_ROW_HISTORY";
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
  // History rows are frozen: any change to one (metadata included), its removal, or a `State` set by the save.
  const cellsChanged = (a: Record<string, string>, b: Record<string, string>): boolean =>
    [...new Set([...Object.keys(a), ...Object.keys(b)])].some((k) => (a[k] ?? "").trim() !== (b[k] ?? "").trim());
  const history = [...new Set([...prev.keys(), ...next.keys()])].find((id) => {
    const p = prev.get(id);
    const n = next.get(id);
    const was = parseBookState(p?.cells.state);
    if (was) return !n || cellsChanged(p!.cells, n.cells);
    return (n?.cells.state ?? "").trim() !== (p?.cells.state ?? "").trim();
  });
  if (history) return { code: "BOOK_ROW_HISTORY", failedId: history, blockers: [] };
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
