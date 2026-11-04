/**
 * Vendored from @4pm/dto (book-guards.ts) by scripts/vendor-shared.mjs — do not edit.
 */
import { bookRowsById } from "./autonomous-approval";
export function dependsIds(cell: string): string[] {
    return cell
        .split(/[,\s]+/)
        .map((x) => x.trim())
        .filter((x) => /^[A-Z]+-\d/.test(x));
}
export function bookDependents(books: readonly string[], ids: readonly string[]): Map<string, string[]> {
    const deleting = new Set(ids);
    const out = new Map<string, string[]>();
    for (const md of books) {
        for (const [rowId, row] of bookRowsById(md)) {
            if (deleting.has(rowId))
                continue;
            for (const dep of dependsIds(row.cells.depends ?? "")) {
                if (!deleting.has(dep))
                    continue;
                const list = out.get(dep) ?? [];
                if (!list.includes(rowId))
                    list.push(rowId);
                out.set(dep, list);
            }
        }
    }
    return out;
}
export function bookDependsGraph(books: readonly string[]): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const md of books)
        for (const [id, row] of bookRowsById(md))
            out.set(id, dependsIds(row.cells.depends ?? ""));
    return out;
}
export function findDependsCycle(edges: ReadonlyMap<string, readonly string[]>, from?: readonly string[]): string[] | null {
    const done = new Set<string>();
    const path: string[] = [];
    const onPath = new Set<string>();
    const visit = (id: string): string[] | null => {
        if (onPath.has(id))
            return [...path.slice(path.indexOf(id)), id];
        if (done.has(id))
            return null;
        onPath.add(id);
        path.push(id);
        for (const next of edges.get(id) ?? []) {
            const c = visit(next);
            if (c)
                return c;
        }
        path.pop();
        onPath.delete(id);
        done.add(id);
        return null;
    };
    for (const id of from ?? [...edges.keys()]) {
        const c = visit(id);
        if (c)
            return c;
    }
    return null;
}
export interface BookClaimRow {
    kind: "task" | "intake";
    id: string;
    worker: string;
    started: string;
}
export function parseBookClaims(progress: string): BookClaimRow[] {
    const out: BookClaimRow[] = [];
    for (const [id, row] of bookRowsById(progress)) {
        const kind = id.startsWith("TSK-") ? "task" : /^(REQ|QA)-/.test(id) ? "intake" : null;
        if (!kind || !row.cells.started)
            continue;
        out.push({ kind, id, worker: row.cells.worker ?? "", started: row.cells.started });
    }
    return out;
}
export function bookStampMs(stamp: string): number {
    const iso = stamp.trim().replace(" ", "T");
    return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`);
}
export const INTAKE_CLAIM_GRACE_MINUTES = 15;
export function liveClaimedIds(progress: string, ttl: {
    claimTtlHours: number;
    runTimeoutMinutes: number;
}, now = Date.now()): Map<string, string> {
    const out = new Map<string, string>();
    for (const c of parseBookClaims(progress)) {
        const age = now - bookStampMs(c.started);
        const limit = c.kind === "task" ? ttl.claimTtlHours * 3600000 : (ttl.runTimeoutMinutes + INTAKE_CLAIM_GRACE_MINUTES) * 60000;
        if (Number.isFinite(age) && age < limit)
            out.set(c.id, c.worker);
    }
    return out;
}
