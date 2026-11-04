/**
 * Vendored from @4pm/dto (book-patch.ts) by scripts/vendor-shared.mjs — do not edit.
 */
import { z } from "zod";
export interface BookRowOp {
    id: string;
    prev: string | null;
    cells: Record<string, string> | null;
    after?: string | null;
}
export interface BookPatch {
    v: 1;
    columns: string[];
    rows: BookRowOp[];
    rest?: {
        prev: string;
        before: string;
        after: string;
    };
}
export type BookConflictKind = "changed" | "deleted" | "duplicateId" | "rest";
export interface BookConflict {
    id: string;
    kind: BookConflictKind;
}
export type BookPatchResult = {
    ok: true;
    md: string;
    added: string[];
    changed: string[];
    deleted: string[];
} | {
    ok: false;
    conflicts: BookConflict[];
};
const cellsSchema = z.record(z.string().max(64), z.string().max(64 * 1024));
export const bookPatchSchema = z.object({
    v: z.literal(1),
    columns: z.array(z.string().max(64)).max(40),
    rows: z
        .array(z.object({
        id: z.string().min(1).max(64),
        prev: z.string().max(32).nullable(),
        cells: cellsSchema.nullable(),
        after: z.string().max(64).nullable().optional(),
    }))
        .max(2000),
    rest: z.object({ prev: z.string().max(32), before: z.string().max(128 * 1024), after: z.string().max(128 * 1024) }).optional(),
});
interface BookTable {
    lines: string[];
    start: number;
    end: number;
    header: string[];
    idCol: number;
    rows: {
        cells: string[];
        line: string;
        at: number;
    }[];
}
function splitRow(line: string): string[] {
    let s = line.trim();
    if (s.startsWith("|"))
        s = s.slice(1);
    if (s.endsWith("|") && !s.endsWith("\\|"))
        s = s.slice(0, -1);
    return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}
function isSeparator(line: string): boolean {
    const s = line.trim();
    return /^\|?[\s:|-]+\|?$/.test(s) && s.includes("-");
}
function esc(value: string): string {
    return value.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
}
function renderLine(cells: string[]): string {
    return `| ${cells.map(esc).join(" | ")} |`;
}
function locate(md: string): BookTable | null {
    const lines = md.replace(/\r\n/g, "\n").split("\n");
    for (let i = 0; i < lines.length - 1; i++) {
        const h = lines[i]!;
        if (!h.trim().startsWith("|") || isSeparator(h) || !isSeparator(lines[i + 1]!))
            continue;
        const header = splitRow(h);
        let j = i + 2;
        const rows: {
            cells: string[];
            line: string;
            at: number;
        }[] = [];
        while (j < lines.length && lines[j]!.trim().startsWith("|") && !isSeparator(lines[j]!)) {
            const cells = splitRow(lines[j]!);
            if (cells.some((c) => c.length > 0))
                rows.push({ cells, line: lines[j]!, at: j });
            j++;
        }
        const idCol = header.findIndex((x) => x.trim().toLowerCase() === "id");
        if (idCol >= 0)
            return { lines, start: i, end: j, header, idCol, rows };
        i = j - 1;
    }
    return null;
}
function rowMap(header: string[], cells: string[]): Map<string, string> {
    const m = new Map<string, string>();
    header.forEach((h, k) => {
        const v = (cells[k] ?? "").replace(/\s+/g, " ").trim();
        if (v)
            m.set(h.trim().toLowerCase(), v);
    });
    return m;
}
function canonical(m: Map<string, string>): string {
    return [...m.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => `${k}=${v}`)
        .join("\u0001");
}
function recordMap(cells: Record<string, string>): Map<string, string> {
    const m = new Map<string, string>();
    for (const [k, v] of Object.entries(cells)) {
        const val = v.replace(/\s+/g, " ").trim();
        if (val)
            m.set(k.trim().toLowerCase(), val);
    }
    return m;
}
function fnv(text: string, seed: number): number {
    let h = seed >>> 0;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
}
export function bookHash(text: string): string {
    return fnv(text, 0x811c9dc5).toString(16).padStart(8, "0") + fnv(text, 0x01234567).toString(16).padStart(8, "0");
}
export function bookRowHash(header: string[], cells: string[]): string {
    return bookHash(canonical(rowMap(header, cells)));
}
function restOf(t: BookTable | null, md: string): {
    before: string;
    after: string;
} {
    if (!t)
        return { before: md.trim(), after: "" };
    return { before: t.lines.slice(0, t.start).join("\n").trim(), after: t.lines.slice(t.end).join("\n").trim() };
}
function restHash(r: {
    before: string;
    after: string;
}): string {
    return bookHash(`${r.before}\u0000${r.after}`);
}
export function bookContentHash(md: string): string {
    return bookHash(md.replace(/\r\n/g, "\n").replace(/\s+$/, ""));
}
export function bookRowHashes(md: string): Map<string, string> {
    const t = locate(md);
    const out = new Map<string, string>();
    if (!t)
        return out;
    for (const r of t.rows)
        out.set((r.cells[t.idCol] ?? "").trim(), bookRowHash(t.header, r.cells));
    return out;
}
export interface BookTableView {
    header: string[];
    idCol: number;
    rows: {
        id: string;
        cells: string[];
        line: number;
    }[];
}
export function bookTable(md: string): BookTableView | null {
    const t = locate(md);
    if (!t)
        return null;
    return {
        header: t.header,
        idCol: t.idCol,
        rows: t.rows.map((r) => ({ id: (r.cells[t.idCol] ?? "").trim(), cells: r.cells, line: r.at })),
    };
}
export function bookRowCells(md: string, id: string): Record<string, string> | null {
    const t = locate(md);
    const row = t?.rows.find((r) => (r.cells[t.idCol] ?? "").trim() === id);
    if (!t || !row)
        return null;
    return Object.fromEntries(t.header.map((h, k) => [h, row.cells[k] ?? ""]));
}
export function diffBook(base: string, draft: string): BookPatch | null {
    const tb = locate(base);
    const td = locate(draft);
    if (!tb || !td)
        return null;
    const ids = (t: BookTable): string[] => t.rows.map((r) => (r.cells[t.idCol] ?? "").trim());
    const baseIds = ids(tb);
    const draftIds = ids(td);
    if ([...baseIds, ...draftIds].some((id) => !id))
        return null;
    if (new Set(baseIds).size !== baseIds.length || new Set(draftIds).size !== draftIds.length)
        return null;
    const draftCols = new Set(td.header.map((h) => h.trim().toLowerCase()));
    if (tb.header.some((h) => h.trim() && !draftCols.has(h.trim().toLowerCase())))
        return null;
    const baseRows = new Map(tb.rows.map((r, k) => [baseIds[k]!, r.cells]));
    const ops: BookRowOp[] = [];
    let prevId: string | null = null;
    td.rows.forEach((r, k) => {
        const id = draftIds[k]!;
        const old = baseRows.get(id);
        const cells = Object.fromEntries(td.header.map((h, c) => [h, r.cells[c] ?? ""]));
        if (!old)
            ops.push({ id, prev: null, cells, after: prevId });
        else if (canonical(rowMap(tb.header, old)) !== canonical(rowMap(td.header, r.cells))) {
            ops.push({ id, prev: bookRowHash(tb.header, old), cells });
        }
        prevId = id;
    });
    const kept = new Set(draftIds);
    for (const [id, cells] of baseRows)
        if (!kept.has(id))
            ops.push({ id, prev: bookRowHash(tb.header, cells), cells: null });
    const patch: BookPatch = { v: 1, columns: td.header, rows: ops };
    const rb = restOf(tb, base);
    const rd = restOf(td, draft);
    if (rb.before !== rd.before || rb.after !== rd.after)
        patch.rest = { prev: restHash(rb), ...rd };
    return patch;
}
export function isEmptyPatch(p: BookPatch): boolean {
    return p.rows.length === 0 && !p.rest;
}
export function applyBookPatch(current: string, patch: BookPatch): BookPatchResult {
    const t = locate(current);
    const conflicts: BookConflict[] = [];
    if (!t)
        return { ok: false, conflicts: [{ id: "", kind: "rest" }] };
    const header = [...t.header];
    const lower = new Set(header.map((h) => h.trim().toLowerCase()));
    for (const c of patch.columns) {
        if (c.trim() && !lower.has(c.trim().toLowerCase())) {
            header.push(c.trim());
            lower.add(c.trim().toLowerCase());
        }
    }
    const widened = header.length !== t.header.length;
    const colIdx = new Map(header.map((h, k) => [h.trim().toLowerCase(), k]));
    const layout = (cells: Record<string, string>): string[] => {
        const out = header.map(() => "");
        for (const [k, v] of Object.entries(cells)) {
            const c = colIdx.get(k.trim().toLowerCase());
            if (c !== undefined)
                out[c] = v;
        }
        return out;
    };
    type Row = {
        id: string;
        cells: string[];
        line: string | null;
    };
    const rows: Row[] = t.rows.map((r) => ({ id: (r.cells[t.idCol] ?? "").trim(), cells: r.cells, line: widened ? null : r.line }));
    const byId = new Map(rows.map((r) => [r.id, r]));
    const added: string[] = [];
    const changed: string[] = [];
    const deleted: string[] = [];
    const adds: {
        op: BookRowOp;
        cells: string[];
    }[] = [];
    for (const op of patch.rows) {
        const cur = byId.get(op.id);
        const curCanon = cur ? canonical(rowMap(t.header, cur.cells)) : "";
        if (op.prev === null) {
            if (!op.cells)
                continue;
            if (!cur)
                adds.push({ op, cells: layout(op.cells) });
            else if (curCanon !== canonical(recordMap(op.cells)))
                conflicts.push({ id: op.id, kind: "duplicateId" });
        }
        else if (op.cells === null) {
            if (!cur)
                continue;
            if (bookHash(curCanon) === op.prev) {
                deleted.push(op.id);
                byId.delete(op.id);
            }
            else
                conflicts.push({ id: op.id, kind: "changed" });
        }
        else {
            const target = canonical(recordMap(op.cells));
            if (!cur)
                conflicts.push({ id: op.id, kind: "deleted" });
            else if (curCanon === target)
                continue;
            else if (bookHash(curCanon) === op.prev) {
                const now = new Map(t.header.map((h, k) => [h.trim().toLowerCase(), cur.cells[k] ?? ""]));
                const given = new Map(Object.entries(op.cells).map(([k, v]) => [k.trim().toLowerCase(), v]));
                cur.cells = header.map((h) => {
                    const key = h.trim().toLowerCase();
                    return given.get(key) ?? now.get(key) ?? "";
                });
                cur.line = null;
                changed.push(op.id);
            }
            else
                conflicts.push({ id: op.id, kind: "changed" });
        }
    }
    let rest = restOf(t, current);
    if (patch.rest) {
        const same = rest.before === patch.rest.before && rest.after === patch.rest.after;
        if (!same && restHash(rest) !== patch.rest.prev)
            conflicts.push({ id: "", kind: "rest" });
        else
            rest = { before: patch.rest.before, after: patch.rest.after };
    }
    if (conflicts.length)
        return { ok: false, conflicts };
    const out: Row[] = rows.filter((r) => byId.has(r.id));
    for (const { op, cells } of adds) {
        const at = op.after ? out.findIndex((r) => r.id === op.after) : -1;
        const row: Row = { id: op.id, cells, line: null };
        if (at >= 0)
            out.splice(at + 1, 0, row);
        else
            out.push(row);
        byId.set(op.id, row);
        added.push(op.id);
    }
    const width = header.length;
    const tableLines = [
        widened ? renderLine(header) : t.lines[t.start]!,
        widened ? `|${header.map(() => "---").join("|")}|` : t.lines[t.start + 1]!,
        ...out.map((r) => r.line ?? renderLine(Array.from({ length: width }, (_, k) => r.cells[k] ?? ""))),
    ];
    const parts: string[] = [];
    if (rest.before)
        parts.push(rest.before, "");
    parts.push(...tableLines);
    if (rest.after)
        parts.push("", rest.after);
    return { ok: true, md: `${parts.join("\n")}\n`, added, changed, deleted };
}
export function rebaseBookDraft(fresh: string, patch: BookPatch, keep: Record<string, "mine" | "theirs">, keepRest?: "mine" | "theirs"): string | null {
    const hashes = bookRowHashes(fresh);
    const rows: BookRowOp[] = [];
    for (const op of patch.rows) {
        const k = keep[op.id];
        const now = hashes.get(op.id);
        if (k === "theirs")
            continue;
        if (k === "mine") {
            if (op.cells === null)
                rows.push({ ...op, prev: now ?? op.prev });
            else
                rows.push({ ...op, prev: now ?? null });
            continue;
        }
        rows.push(op);
    }
    const next: BookPatch = { v: 1, columns: patch.columns, rows };
    if (patch.rest && keepRest !== "theirs") {
        next.rest = keepRest === "mine" ? { ...patch.rest, prev: restHash(restOf(locate(fresh), fresh)) } : patch.rest;
    }
    const res = applyBookPatch(fresh, next);
    return res.ok ? res.md : null;
}
