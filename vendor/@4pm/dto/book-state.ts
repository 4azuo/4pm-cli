/**
 * Book row `State` — USER_TODO requests and USER_QA questions stay in their book after the cycle used them, marked
 * instead of removed: `Taken in` once intake analysed the row (or a task question was folded into its task), `Done`
 * once every row of the groups made from it is in AI_DONE. A row with a State is history: the cycle, the intake agent
 * and the approval flow treat it as gone, the web shows it read-only. The cli is the only writer of the cell.
 * @adr 0562
 */
import { bookRowsById } from "./autonomous-approval";

/** The `State` column header. */
export const BOOK_STATE_HEADER = "State";

/** The State values the cli writes. */
export const BOOK_STATE = { takenIn: "Taken in", done: "Done" } as const;
export type BookRowState = (typeof BOOK_STATE)[keyof typeof BOOK_STATE];

/** A `State` cell → its value, or null when empty / unknown (an open row). */
export function parseBookState(cell: string | undefined): BookRowState | null {
  const v = (cell ?? "").trim().toLowerCase();
  if (v === BOOK_STATE.done.toLowerCase()) return BOOK_STATE.done;
  if (v === BOOK_STATE.takenIn.toLowerCase()) return BOOK_STATE.takenIn;
  return null;
}

/** Row id → State of every row of a book that has one. */
export function bookRowStates(markdown: string): Map<string, BookRowState> {
  const out = new Map<string, BookRowState>();
  for (const [id, r] of bookRowsById(markdown)) {
    const s = parseBookState(r.cells.state);
    if (s) out.set(id, s);
  }
  return out;
}
