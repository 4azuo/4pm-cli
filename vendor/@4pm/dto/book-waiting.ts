/**
 * Book "waiting for" — which of a row's `Depends` the autonomous cycle still waits on, shared by the cli (intake skips
 * a request that waits) and the web (the red *Waiting for* line). A dependency waits while:
 * - a `REQ-…`: it still waits for intake, or, once taken in, its book groups (lineage) still hold open rows — tasks / docs
 *   not in AI_DONE yet or open questions (those rows are reported, `via` the request);
 * - a `QA-…`: it is still an open question, or its own groups still hold open rows;
 * - a `TSK-…` / `DOC-…`: it is not in AI_DONE.
 * Since ADR-0563 a DOC / task row also waits for its group's request PR, and a task for the PR of each accepted DOC row
 * it depends on, to merge into `<base>` (`mergeWait`).
 * @adr 0561 @adr 0563
 */
import { bookGroupOf } from "./book-ids";
import { deliveryLanded } from "./autonomous-books-set";
import type { DocsSidecar, LineageSidecar } from "./autonomous-docs";

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

/** What a row of a group waits for before it may start: its request PR, or a DOC dependency's PR, into `<base>`. */
export interface MergeWait {
  /** The request / DOC row whose PR is not merged. */
  id: string;
  url?: string;
  /** `closed` = the PR was closed without merge (blocked until Retry). */
  state: "open" | "closed";
}

/**
 * The merge gate of a DOC / task row (null = free to start): the group's request PR (mockups / sequences — lineage
 * `delivery`) must be merged into `<base>`, and for a task every accepted `DOC-…` dependency's PR (docs `pr`; an
 * accepted DOC row whose PR is not opened yet waits too).
 * @adr 0563
 */
export function mergeWait(row: { id: string; depends: readonly string[] }, lineage: LineageSidecar, docs: DocsSidecar): MergeWait | null {
  const g = /^(?:TSK|DOC)-(\d{6})-/.exec(row.id)?.[1];
  const lin = g ? lineage[g] : undefined;
  if (lin?.delivery && !deliveryLanded(lin.delivery)) {
    return { id: lin.source, ...(lin.delivery.url ? { url: lin.delivery.url } : {}), state: lin.delivery.state === "closed" ? "closed" : "open" };
  }
  if (row.id.startsWith("DOC-")) return null;
  for (const d of row.depends.filter((x) => x.startsWith("DOC-"))) {
    const e = docs[d];
    if (!e || e.state !== "accepted") continue; // not accepted yet — the AI Done dependency rule waits for it
    if (!deliveryLanded(e.pr)) return { id: d, ...(e.pr?.url ? { url: e.pr.url } : {}), state: e.pr?.state === "closed" ? "closed" : "open" };
  }
  return null;
}
