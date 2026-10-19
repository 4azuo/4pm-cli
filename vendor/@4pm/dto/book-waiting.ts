/**
 * Book "waiting for" — which of a row's `Depends` the autonomous cycle still waits on, shared by the cli (intake skips
 * a request that waits) and the web (the red *Waiting for* line). A dependency waits while:
 * - a `REQ-…`: it still waits for intake, or, once taken in, its book groups (lineage) still hold open rows — tasks / docs
 *   not in AI_DONE yet or open questions (those rows are reported, `via` the request);
 * - a `QA-…`: it is still an open question, or its own groups still hold open rows;
 * - a `TSK-…` / `DOC-…`: it is not in AI_DONE.
 * @adr 0561
 */
import { bookGroupOf } from "./book-ids";
import type { LineageSidecar } from "./autonomous-docs";

/** What the helper reads from the books (each side parses its own markdown). */
export interface WaitingBooks {
  /** `REQ-…` ids still in USER_TODO (not taken in yet). */
  pendingRequests: ReadonlySet<string>;
  /** Open rows: AI_TODO tasks / docs, claimed tasks and USER_QA questions still in their book. */
  openIds: Iterable<string>;
  /** `TSK-…` / `DOC-…` ids in AI_DONE. */
  doneIds: ReadonlySet<string>;
  lineage: LineageSidecar;
}

/** One dependency still waited on; `via` = the request / question whose open row it is. */
export interface WaitingItem {
  id: string;
  via?: string;
}

/** Build `waitingOf(depends)` → the dependencies still waited on, in `depends` order (deduplicated). */
export function buildDependsWaiting(books: WaitingBooks): (depends: readonly string[]) => WaitingItem[] {
  const open = new Set(books.openIds);
  const openByGroup = new Map<string, string[]>();
  for (const id of open) {
    const g = bookGroupOf(id);
    if (g) openByGroup.set(g, [...(openByGroup.get(g) ?? []), id]);
  }
  // Source row → the groups intake made from it (a QA source also counts for its root request).
  const groupsOf = new Map<string, string[]>();
  for (const [g, e] of Object.entries(books.lineage)) {
    for (const src of new Set([e.source, e.root].filter((s): s is string => Boolean(s)))) groupsOf.set(src, [...(groupsOf.get(src) ?? []), g]);
  }
  /** The open rows of the groups made from a source row. */
  const openRowsOf = (src: string): WaitingItem[] =>
    (groupsOf.get(src) ?? []).flatMap((g) => openByGroup.get(g) ?? []).sort().map((id) => ({ id, via: src }));

  /** The items one dependency waits on. */
  const waitingOn = (dep: string): WaitingItem[] => {
    if (/^(?:TSK|DOC)-/.test(dep)) return books.doneIds.has(dep) ? [] : [{ id: dep }];
    if (dep.startsWith("REQ-")) return books.pendingRequests.has(dep) ? [{ id: dep }] : openRowsOf(dep);
    if (dep.startsWith("QA-")) return open.has(dep) ? [{ id: dep }] : openRowsOf(dep);
    return [];
  };

  return (depends) => {
    const seen = new Set<string>();
    const out: WaitingItem[] = [];
    for (const dep of depends) {
      for (const it of waitingOn(dep.trim())) {
        if (seen.has(it.id)) continue;
        seen.add(it.id);
        out.push(it);
      }
    }
    return out;
  };
}
