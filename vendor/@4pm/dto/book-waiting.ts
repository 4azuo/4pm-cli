/**
 * Vendored from @4pm/dto (book-waiting.ts) by scripts/vendor-shared.mjs — do not edit.
 */
import { bookGroupOf, isRoundRowId } from "./book-ids";
import { deliveryLanded } from "./autonomous-books-set";
import type { DocsSidecar, LineageSidecar } from "./autonomous-docs";
export interface WaitingBooks {
    pendingRequests: ReadonlySet<string>;
    openIds: Iterable<string>;
    doneIds: ReadonlySet<string>;
    lineage: LineageSidecar;
}
export interface WaitingItem {
    id: string;
    via?: string;
}
export function buildDependsWaiting(books: WaitingBooks): (depends: readonly string[]) => WaitingItem[] {
    const open = new Set(books.openIds);
    const openByGroup = new Map<string, string[]>();
    for (const id of open) {
        const g = bookGroupOf(id);
        if (g)
            openByGroup.set(g, [...(openByGroup.get(g) ?? []), id]);
    }
    const groupsOf = new Map<string, string[]>();
    for (const [g, e] of Object.entries(books.lineage)) {
        for (const src of new Set([e.source, e.root].filter((s): s is string => Boolean(s))))
            groupsOf.set(src, [...(groupsOf.get(src) ?? []), g]);
    }
    const openRowsOf = (src: string): WaitingItem[] => (groupsOf.get(src) ?? []).flatMap((g) => openByGroup.get(g) ?? []).sort().map((id) => ({ id, via: src }));
    const waitingOn = (dep: string): WaitingItem[] => {
        if (/^(?:TSK|DOC|AST)-/.test(dep))
            return books.doneIds.has(dep) ? [] : [{ id: dep }];
        if (dep.startsWith("REQ-"))
            return books.pendingRequests.has(dep) ? [{ id: dep }] : openRowsOf(dep);
        if (dep.startsWith("QA-"))
            return open.has(dep) ? [{ id: dep }] : openRowsOf(dep);
        return [];
    };
    return (depends) => {
        const seen = new Set<string>();
        const out: WaitingItem[] = [];
        for (const dep of depends) {
            for (const it of waitingOn(dep.trim())) {
                if (seen.has(it.id))
                    continue;
                seen.add(it.id);
                out.push(it);
            }
        }
        return out;
    };
}
export interface MergeWait {
    id: string;
    url?: string;
    state: "open" | "closed";
}
export function mergeWait(row: {
    id: string;
    depends: readonly string[];
}, lineage: LineageSidecar, docs: DocsSidecar): MergeWait | null {
    const g = /^(?:TSK|DOC|AST)-(\d{6})-/.exec(row.id)?.[1];
    const lin = g ? lineage[g] : undefined;
    if (lin?.delivery && !deliveryLanded(lin.delivery)) {
        return { id: lin.source, ...(lin.delivery.url ? { url: lin.delivery.url } : {}), state: lin.delivery.state === "closed" ? "closed" : "open" };
    }
    if (isRoundRowId(row.id))
        return null;
    for (const d of row.depends.filter((x) => isRoundRowId(x))) {
        const e = docs[d];
        if (!e || e.state !== "accepted")
            continue;
        if (!deliveryLanded(e.pr))
            return { id: d, ...(e.pr?.url ? { url: e.pr.url } : {}), state: e.pr?.state === "closed" ? "closed" : "open" };
    }
    return null;
}
