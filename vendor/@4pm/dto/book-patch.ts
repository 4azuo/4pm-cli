/**
 * Row-level patches of a book (USER_TODO / USER_QA / AI_TODO / AI_DONE): the web sends only the rows it
 * added / changed / deleted, each with the hash of the row it started from, and the cli merges them by id onto
 * the current book — a row someone else changed meanwhile is a conflict, every other change merges. A book =
 * its first table with an `ID` column + the "rest" (the text before / after that table). Pure functions shared
 * by web (diff, rebase), server (sign approvals over the patched rows) and cli (apply).
 * @adr 0455
 */
import { z } from "zod";

/** One row operation: add (`prev` null), edit (`cells`), delete (`cells` null). */
export interface BookRowOp {
  id: string;
  /** Hash of the row in the editor's base; null = an added row. */
  prev: string | null;
  /** The row's cells by column name; null = delete. */
  cells: Record<string, string> | null;
  /** An added row goes after this id (absent / not found ⇒ at the end). */
  after?: string | null;
}

/** A save of one book as row operations. */
export interface BookPatch {
  v: 1;
  /** The draft's header, in order (a column missing from the book is added; none is ever removed). */
  columns: string[];
  rows: BookRowOp[];
  /** The text around the table, only when it changed (`prev` = hash of the base's text). */
  rest?: { prev: string; before: string; after: string };
}

/** Why a row (or the text around the table) could not be merged. */
export type BookConflictKind = "changed" | "deleted" | "duplicateId" | "rest";

/** One conflict of a patch against the current book. */
export interface BookConflict {
  /** The row id ("" for `rest`). */
  id: string;
  kind: BookConflictKind;
}

/** Outcome of applying a patch. */
export type BookPatchResult =
  | { ok: true; md: string; added: string[]; changed: string[]; deleted: string[] }
  | { ok: false; conflicts: BookConflict[] };

const cellsSchema = z.record(z.string().max(64), z.string().max(64 * 1024));

/** Zod schema of a `BookPatch` (request bodies). */
export const bookPatchSchema = z.object({
  v: z.literal(1),
  columns: z.array(z.string().max(64)).max(40),
  rows: z
    .array(
      z.object({
        id: z.string().min(1).max(64),
        prev: z.string().max(32).nullable(),
        cells: cellsSchema.nullable(),
        after: z.string().max(64).nullable().optional(),
      }),
    )
    .max(2000),
  rest: z.object({ prev: z.string().max(32), before: z.string().max(128 * 1024), after: z.string().max(128 * 1024) }).optional(),
});

// ── Table model ───────────────────────────────────────────────────────────────────────────────────

/** The book's table: line span, header, rows (cells + their original line). */
interface BookTable {
  lines: string[];
  start: number;
  end: number;
  header: string[];
  idCol: number;
  rows: { cells: string[]; line: string }[];
}

/** Split one table line into cells (`\|` is a literal pipe). */
function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

/** True for a GFM separator row. */
function isSeparator(line: string): boolean {
  const s = line.trim();
  return /^\|?[\s:|-]+\|?$/.test(s) && s.includes("-");
}

/** Escape a value for one cell. */
function esc(value: string): string {
  return value.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
}

/** Render one table line. */
function renderLine(cells: string[]): string {
  return `| ${cells.map(esc).join(" | ")} |`;
}

/** Locate the first table with an `ID` column; null when the document has none. */
function locate(md: string): BookTable | null {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  for (let i = 0; i < lines.length - 1; i++) {
    const h = lines[i]!;
    if (!h.trim().startsWith("|") || isSeparator(h) || !isSeparator(lines[i + 1]!)) continue;
    const header = splitRow(h);
    let j = i + 2;
    const rows: { cells: string[]; line: string }[] = [];
    while (j < lines.length && lines[j]!.trim().startsWith("|") && !isSeparator(lines[j]!)) {
      const cells = splitRow(lines[j]!);
      if (cells.some((c) => c.length > 0)) rows.push({ cells, line: lines[j]! });
      j++;
    }
    const idCol = header.findIndex((x) => x.trim().toLowerCase() === "id");
    if (idCol >= 0) return { lines, start: i, end: j, header, idCol, rows };
    i = j - 1;
  }
  return null;
}

/** A row as `lower-case column → cell`, empty cells dropped. */
function rowMap(header: string[], cells: string[]): Map<string, string> {
  const m = new Map<string, string>();
  header.forEach((h, k) => {
    const v = (cells[k] ?? "").replace(/\s+/g, " ").trim();
    if (v) m.set(h.trim().toLowerCase(), v);
  });
  return m;
}

/** The canonical text of a row (sorted non-empty `column=value` pairs). */
function canonical(m: Map<string, string>): string {
  return [...m.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("\u0001");
}

/** A record of cells as a canonical map. */
function recordMap(cells: Record<string, string>): Map<string, string> {
  const m = new Map<string, string>();
  for (const [k, v] of Object.entries(cells)) {
    const val = v.replace(/\s+/g, " ").trim();
    if (val) m.set(k.trim().toLowerCase(), val);
  }
  return m;
}

/** FNV-1a 32-bit over a string with a seed. */
function fnv(text: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** A 64-bit hex digest (two seeded FNV-1a passes) — a change detector, not a security hash. */
export function bookHash(text: string): string {
  return fnv(text, 0x811c9dc5).toString(16).padStart(8, "0") + fnv(text, 0x01234567).toString(16).padStart(8, "0");
}

/** The hash of a row given by header + cells (empty cells and absent columns alike). */
export function bookRowHash(header: string[], cells: string[]): string {
  return bookHash(canonical(rowMap(header, cells)));
}

/** The text around the table (before / after, trimmed). */
function restOf(t: BookTable | null, md: string): { before: string; after: string } {
  if (!t) return { before: md.trim(), after: "" };
  return { before: t.lines.slice(0, t.start).join("\n").trim(), after: t.lines.slice(t.end).join("\n").trim() };
}

/** Hash of the text around the table. */
function restHash(r: { before: string; after: string }): string {
  return bookHash(`${r.before}\u0000${r.after}`);
}

/** Hash of a whole book (the `baseHash` of a whole-file save). */
export function bookContentHash(md: string): string {
  return bookHash(md.replace(/\r\n/g, "\n").replace(/\s+$/, ""));
}

/** The book's rows as `id → hash` (for a conflict view / re-basing). */
export function bookRowHashes(md: string): Map<string, string> {
  const t = locate(md);
  const out = new Map<string, string>();
  if (!t) return out;
  for (const r of t.rows) out.set((r.cells[t.idCol] ?? "").trim(), bookRowHash(t.header, r.cells));
  return out;
}

/** One row of a book as `column → cell` (header order), or null. */
export function bookRowCells(md: string, id: string): Record<string, string> | null {
  const t = locate(md);
  const row = t?.rows.find((r) => (r.cells[t.idCol] ?? "").trim() === id);
  if (!t || !row) return null;
  return Object.fromEntries(t.header.map((h, k) => [h, row.cells[k] ?? ""]));
}

// ── Diff ──────────────────────────────────────────────────────────────────────────────────────────

/**
 * The patch turning `base` into `draft`, by row id; null when either has no id table, an id is blank or
 * duplicated, or the draft removes a column — the caller then saves the whole file with `baseHash`.
 */
export function diffBook(base: string, draft: string): BookPatch | null {
  const tb = locate(base);
  const td = locate(draft);
  if (!tb || !td) return null;
  const ids = (t: BookTable): string[] => t.rows.map((r) => (r.cells[t.idCol] ?? "").trim());
  const baseIds = ids(tb);
  const draftIds = ids(td);
  if ([...baseIds, ...draftIds].some((id) => !id)) return null;
  if (new Set(baseIds).size !== baseIds.length || new Set(draftIds).size !== draftIds.length) return null;
  const draftCols = new Set(td.header.map((h) => h.trim().toLowerCase()));
  if (tb.header.some((h) => h.trim() && !draftCols.has(h.trim().toLowerCase()))) return null;

  const baseRows = new Map(tb.rows.map((r, k) => [baseIds[k]!, r.cells]));
  const ops: BookRowOp[] = [];
  let prevId: string | null = null;
  td.rows.forEach((r, k) => {
    const id = draftIds[k]!;
    const old = baseRows.get(id);
    const cells = Object.fromEntries(td.header.map((h, c) => [h, r.cells[c] ?? ""]));
    if (!old) ops.push({ id, prev: null, cells, after: prevId });
    else if (canonical(rowMap(tb.header, old)) !== canonical(rowMap(td.header, r.cells))) {
      ops.push({ id, prev: bookRowHash(tb.header, old), cells });
    }
    prevId = id;
  });
  const kept = new Set(draftIds);
  for (const [id, cells] of baseRows) if (!kept.has(id)) ops.push({ id, prev: bookRowHash(tb.header, cells), cells: null });

  const patch: BookPatch = { v: 1, columns: td.header, rows: ops };
  const rb = restOf(tb, base);
  const rd = restOf(td, draft);
  if (rb.before !== rd.before || rb.after !== rd.after) patch.rest = { prev: restHash(rb), ...rd };
  return patch;
}

/** True when the patch changes nothing. */
export function isEmptyPatch(p: BookPatch): boolean {
  return p.rows.length === 0 && !p.rest;
}

// ── Apply ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * Apply a patch to the current book: an edit / delete needs the current row to still hash to `prev` (or to
 * already equal the target); an add needs a free id (or an identical row); the text around the table needs
 * the same base. Any conflict ⇒ nothing changes. Untouched rows keep their exact line.
 */
export function applyBookPatch(current: string, patch: BookPatch): BookPatchResult {
  const t = locate(current);
  const conflicts: BookConflict[] = [];
  if (!t) return { ok: false, conflicts: [{ id: "", kind: "rest" }] };

  // Columns: append the draft's columns the book lacks.
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
  /** Cells of a patch row laid out on the (widened) header. */
  const layout = (cells: Record<string, string>): string[] => {
    const out = header.map(() => "");
    for (const [k, v] of Object.entries(cells)) {
      const c = colIdx.get(k.trim().toLowerCase());
      if (c !== undefined) out[c] = v;
    }
    return out;
  };

  type Row = { id: string; cells: string[]; line: string | null };
  const rows: Row[] = t.rows.map((r) => ({ id: (r.cells[t.idCol] ?? "").trim(), cells: r.cells, line: widened ? null : r.line }));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const added: string[] = [];
  const changed: string[] = [];
  const deleted: string[] = [];
  const adds: { op: BookRowOp; cells: string[] }[] = [];

  for (const op of patch.rows) {
    const cur = byId.get(op.id);
    const curCanon = cur ? canonical(rowMap(t.header, cur.cells)) : "";
    if (op.prev === null) {
      if (!op.cells) continue;
      if (!cur) adds.push({ op, cells: layout(op.cells) });
      else if (curCanon !== canonical(recordMap(op.cells))) conflicts.push({ id: op.id, kind: "duplicateId" });
    } else if (op.cells === null) {
      if (!cur) continue;
      if (bookHash(curCanon) === op.prev) {
        deleted.push(op.id);
        byId.delete(op.id);
      } else conflicts.push({ id: op.id, kind: "changed" });
    } else {
      const target = canonical(recordMap(op.cells));
      if (!cur) conflicts.push({ id: op.id, kind: "deleted" });
      else if (curCanon === target) continue;
      else if (bookHash(curCanon) === op.prev) {
        // Columns the patch does not carry keep their current value.
        const now = new Map(t.header.map((h, k) => [h.trim().toLowerCase(), cur.cells[k] ?? ""]));
        const given = new Map(Object.entries(op.cells).map(([k, v]) => [k.trim().toLowerCase(), v]));
        cur.cells = header.map((h) => {
          const key = h.trim().toLowerCase();
          return given.get(key) ?? now.get(key) ?? "";
        });
        cur.line = null;
        changed.push(op.id);
      } else conflicts.push({ id: op.id, kind: "changed" });
    }
  }

  let rest = restOf(t, current);
  if (patch.rest) {
    const same = rest.before === patch.rest.before && rest.after === patch.rest.after;
    if (!same && restHash(rest) !== patch.rest.prev) conflicts.push({ id: "", kind: "rest" });
    else rest = { before: patch.rest.before, after: patch.rest.after };
  }
  if (conflicts.length) return { ok: false, conflicts };

  // Rows: current order minus deletions, the adds placed after their anchor (in patch order).
  const out: Row[] = rows.filter((r) => byId.has(r.id));
  for (const { op, cells } of adds) {
    const at = op.after ? out.findIndex((r) => r.id === op.after) : -1;
    const row: Row = { id: op.id, cells, line: null };
    if (at >= 0) out.splice(at + 1, 0, row);
    else out.push(row);
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
  if (rest.before) parts.push(rest.before, "");
  parts.push(...tableLines);
  if (rest.after) parts.push("", rest.after);
  return { ok: true, md: `${parts.join("\n")}\n`, added, changed, deleted };
}

/**
 * Re-base a draft after a conflict: apply the edits of `patch` to `fresh`, resolving each conflicting row by
 * `keep` — `"theirs"` drops my operation, `"mine"` re-targets it onto the fresh row (an edit of a row they
 * deleted becomes an add; my delete of a row they changed deletes it); rows without an entry are applied as
 * they are. `keepRest` resolves a conflict on the text around the table (absent = it did not conflict).
 * Returns the new draft (its base is `fresh`); null when a conflict is left unresolved.
 */
export function rebaseBookDraft(
  fresh: string,
  patch: BookPatch,
  keep: Record<string, "mine" | "theirs">,
  keepRest?: "mine" | "theirs",
): string | null {
  const hashes = bookRowHashes(fresh);
  const rows: BookRowOp[] = [];
  for (const op of patch.rows) {
    const k = keep[op.id];
    const now = hashes.get(op.id);
    if (k === "theirs") continue;
    if (k === "mine") {
      if (op.cells === null) rows.push({ ...op, prev: now ?? op.prev });
      else rows.push({ ...op, prev: now ?? null });
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
