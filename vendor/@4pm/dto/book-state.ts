/**
 * Vendored from @4pm/dto (book-state.ts) by scripts/vendor-shared.mjs — do not edit.
 */
import { bookRowsById } from "./autonomous-approval";
export const BOOK_STATE_HEADER = "State";
export const BOOK_STATE = { takenIn: "Taken in", done: "Done" } as const;
export type BookRowState = (typeof BOOK_STATE)[keyof typeof BOOK_STATE];
export function parseBookState(cell: string | undefined): BookRowState | null {
    const v = (cell ?? "").trim().toLowerCase();
    if (v === BOOK_STATE.done.toLowerCase())
        return BOOK_STATE.done;
    if (v === BOOK_STATE.takenIn.toLowerCase())
        return BOOK_STATE.takenIn;
    return null;
}
export function bookRowStates(markdown: string): Map<string, BookRowState> {
    const out = new Map<string, BookRowState>();
    for (const [id, r] of bookRowsById(markdown)) {
        const s = parseBookState(r.cells.state);
        if (s)
            out.set(id, s);
    }
    return out;
}
