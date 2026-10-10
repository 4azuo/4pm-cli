/**
 * Autonomous books model (ADR-0371) — parse and rewrite the Markdown tables of the five book files the
 * cli now edits in code (claim, finish, release, question, split): `AI_TODO` tasks, the multi-row
 * `AI_PROGRESS` claims, `AI_DONE` (Done + Incidents), `USER_QA`, plus the `.autonomous.attempts.json`
 * sidecar. Cells are matched by header name, so a legacy 3-column `AI_PROGRESS` still parses. Rewrites
 * touch only the table rows — the prose around the table is kept byte-for-byte.
 */
import { readFileInRoot, writeFileInRoot } from "../utils/safe-path";
import { join } from "node:path";

/** A Markdown table found in a document: its line span, header and data rows (cells, unescaped). */
export interface MdTable {
  /** Index of the header line. */
  start: number;
  /** Index one past the last table line. */
  end: number;
  header: string[];
  rows: string[][];
}

/** Split one table line into cells (`\|` is a literal pipe inside a cell). */
function splitRow(line: string): string[] {
  const body = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return body.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

/** Escape a value for one table cell (collapse newlines, escape pipes). */
export function cell(value: string): string {
  return value.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
}

/** Every Markdown table of a document, in order. */
export function findTables(md: string): MdTable[] {
  const lines = md.split("\n");
  const out: MdTable[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!.trim();
    const next = lines[i + 1]?.trim() ?? "";
    if (l.startsWith("|") && /^\|[\s:|-]+\|?$/.test(next)) {
      const header = splitRow(l);
      let j = i + 2;
      const rows: string[][] = [];
      while (j < lines.length && lines[j]!.trim().startsWith("|")) {
        const cells = splitRow(lines[j]!);
        if (cells.some((c) => c.length > 0)) rows.push(cells);
        j++;
      }
      out.push({ start: i, end: j, header, rows });
      i = j;
    } else i++;
  }
  return out;
}

/** Replace a table's data rows (an empty list leaves header + separator only, like the templates). */
export function replaceRows(md: string, table: MdTable, rows: string[][]): string {
  const lines = md.split("\n");
  const width = table.header.length;
  const sep = `|${table.header.map(() => "---").join("|")}|`;
  const body = rows.map(
    (r) => `| ${Array.from({ length: width }, (_, k) => cell(r[k] ?? "")).join(" | ")} |`,
  );
  const head = `| ${table.header.join(" | ")} |`;
  lines.splice(table.start, table.end - table.start, head, sep, ...body);
  return lines.join("\n");
}

/** Column index of a header name (case-insensitive), or -1. */
function col(header: string[], name: string): number {
  return header.findIndex((h) => h.toLowerCase() === name.toLowerCase());
}

/** Read a cell by header name. */
function get(t: MdTable, row: string[], name: string): string {
  const i = col(t.header, name);
  return i >= 0 ? (row[i] ?? "") : "";
}

/** Build a row in the table's own column order from a name → value map. */
function build(header: string[], values: Record<string, string>): string[] {
  return header.map((h) => values[h.toLowerCase()] ?? "");
}

// ── AI_TODO ──────────────────────────────────────────────────────────────────────────────────────

/** One `AI_TODO` task. `depends` holds `TSK-…` and/or `QA-…` ids (ADR-0371). */
export interface TaskRow {
  id: string;
  priority: string;
  tag: string;
  depends: string[];
  group: string;
  desc: string;
  notes: string;
}

/** Split a Depends cell into ids. */
export function splitIds(v: string): string[] {
  return v
    .split(/[,\s]+/)
    .map((x) => x.trim())
    .filter((x) => /^(TSK|QA)-/.test(x));
}

/** Parse the `AI_TODO` task table. */
export function parseTasks(md: string): { table: MdTable | null; tasks: TaskRow[] } {
  const table = findTables(md).find((t) => col(t.header, "ID") >= 0 && col(t.header, "Depends") >= 0 && col(t.header, "Priority") >= 0) ?? null;
  if (!table) return { table: null, tasks: [] };
  const tasks = table.rows
    .map((r) => ({
      id: get(table, r, "ID"),
      priority: get(table, r, "Priority"),
      tag: get(table, r, "Tag"),
      depends: splitIds(get(table, r, "Depends")),
      group: get(table, r, "Group"),
      desc: get(table, r, "Task description"),
      notes: get(table, r, "Notes"),
    }))
    .filter((t) => /^TSK-/.test(t.id));
  return { table, tasks };
}

/** Rewrite the `AI_TODO` task table with `tasks`. */
export function writeTasks(md: string, tasks: TaskRow[]): string {
  const { table } = parseTasks(md);
  if (!table) return md;
  return replaceRows(
    md,
    table,
    tasks.map((t) =>
      build(table.header, {
        id: t.id,
        priority: t.priority,
        tag: t.tag,
        depends: t.depends.join(", "),
        group: t.group,
        "task description": t.desc,
        notes: t.notes,
      }),
    ),
  );
}

// ── AI_PROGRESS (multi-row claims) ───────────────────────────────────────────────────────────────

/** The multi-row `AI_PROGRESS` header (ADR-0371). */
export const PROGRESS_HEADER = ["Started", "ID", "Worker", "Claim", "Attempt", "Task description"];

/** One claimed task. */
export interface ClaimRow {
  started: string;
  id: string;
  worker: string;
  claim: string;
  attempt: number;
  desc: string;
}

/** Parse `AI_PROGRESS` (a legacy 3-column table yields claims with no worker/claim id). */
export function parseClaims(md: string): { table: MdTable | null; claims: ClaimRow[] } {
  const table = findTables(md).find((t) => col(t.header, "ID") >= 0 && col(t.header, "Started") >= 0) ?? null;
  if (!table) return { table: null, claims: [] };
  const claims = table.rows
    .map((r) => ({
      started: get(table, r, "Started"),
      id: get(table, r, "ID"),
      worker: get(table, r, "Worker"),
      claim: get(table, r, "Claim"),
      attempt: Number(get(table, r, "Attempt")) || 1,
      desc: get(table, r, "Task description"),
    }))
    .filter((c) => /^TSK-/.test(c.id));
  return { table, claims };
}

/** Rewrite `AI_PROGRESS` with `claims`, upgrading a legacy table to the multi-row header. */
export function writeClaims(md: string, claims: ClaimRow[]): string {
  const found = parseClaims(md).table;
  const table: MdTable = found
    ? { ...found, header: PROGRESS_HEADER }
    : { start: md.split("\n").length, end: md.split("\n").length, header: PROGRESS_HEADER, rows: [] };
  const src = found ? md : `${md.replace(/\n*$/, "")}\n\n`;
  return replaceRows(
    src,
    table,
    claims.map((c) => [c.started, c.id, c.worker, c.claim, String(c.attempt), c.desc]),
  );
}

// ── AI_DONE (Done + Incidents) ───────────────────────────────────────────────────────────────────

/** Insert `names` (those still missing) right after column `after`, giving old rows empty cells. */
function insertColumns(table: MdTable, after: string, names: string[]): MdTable {
  const missing = names.filter((h) => col(table.header, h) < 0);
  if (missing.length === 0) return table;
  const anchor = col(table.header, after);
  const at = anchor >= 0 ? anchor + 1 : table.header.length;
  const header = [...table.header.slice(0, at), ...missing, ...table.header.slice(at)];
  const rows = table.rows.map((r) => [...r.slice(0, at), ...missing.map(() => ""), ...r.slice(at)]);
  return { ...table, header, rows };
}

/**
 * Upgrade a Done table in place: `Group` + `Depends` after `ID` (ADR-0400) and `Evidence` after `Files`
 * (ADR-0404), keeping every other column (e.g. the web's `AI verify`).
 */
function withDoneColumns(table: MdTable): MdTable {
  return insertColumns(insertColumns(table, "ID", ["Group", "Depends"]), "Files", ["Evidence"]);
}

/** Append a Done row (`Timestamp | ID | Group | Depends | Task description | Files | Evidence | Notes`). */
export function appendDone(
  md: string,
  row: { id: string; group: string; depends: string[]; desc: string; files: string; evidence: string; notes: string },
): string {
  const found = findTables(md).find((t) => col(t.header, "ID") >= 0 && col(t.header, "Timestamp") >= 0);
  if (!found) return md;
  const table = withDoneColumns(found);
  const values = {
    timestamp: stamp(),
    id: row.id,
    group: row.group,
    depends: row.depends.join(", "),
    "task description": row.desc,
    files: row.files,
    evidence: row.evidence,
    notes: row.notes,
  };
  return replaceRows(md, table, [...table.rows, build(table.header, values)]);
}

/** Append an Incident row (`Timestamp | Note`). */
export function appendIncident(md: string, note: string): string {
  const table = findTables(md).find((t) => col(t.header, "Note") >= 0 && col(t.header, "Timestamp") >= 0 && col(t.header, "ID") < 0);
  if (!table) return md;
  return replaceRows(md, table, [...table.rows, build(table.header, { timestamp: stamp(), note })]);
}

/** Done rows by id (with their Notes — `branch: …` / `PR: …`). */
export function doneRows(md: string): Map<string, string> {
  const table = findTables(md).find((t) => col(t.header, "ID") >= 0 && col(t.header, "Timestamp") >= 0);
  const out = new Map<string, string>();
  if (table) for (const r of table.rows) out.set(get(table, r, "ID"), get(table, r, "Notes"));
  return out;
}

// ── USER_QA ──────────────────────────────────────────────────────────────────────────────────────

/** One `USER_QA` row. */
export interface QaRow {
  id: string;
  group: string;
  depends: string;
  original: string;
  question: string;
  answer: string;
}

/** Parse the `USER_QA` table. */
export function parseQa(md: string): { table: MdTable | null; rows: QaRow[] } {
  const table = findTables(md).find((t) => col(t.header, "ID") >= 0 && col(t.header, "Answer") >= 0) ?? null;
  if (!table) return { table: null, rows: [] };
  const rows = table.rows
    .map((r) => ({
      id: get(table, r, "ID"),
      group: get(table, r, "Group"),
      depends: get(table, r, "Depends"),
      original: get(table, r, "Original request"),
      question: get(table, r, "Question / options"),
      answer: get(table, r, "Answer"),
    }))
    .filter((q) => /^QA-/.test(q.id));
  return { table, rows };
}

/** Rewrite the `USER_QA` table. */
export function writeQa(md: string, rows: QaRow[]): string {
  const { table } = parseQa(md);
  if (!table) return md;
  return replaceRows(
    md,
    table,
    rows.map((q) =>
      build(table.header, {
        id: q.id,
        group: q.group,
        depends: q.depends,
        "original request": q.original,
        "question / options": q.question,
        answer: q.answer,
      }),
    ),
  );
}

// ── Attempts sidecar ─────────────────────────────────────────────────────────────────────────────

/** Relative path of the attempts sidecar (committed on `<base>` with the books — ADR-0371). */
export const ATTEMPTS_REL = ".claude/.autonomous.attempts.json";

/** One task's attempt record. */
export interface AttemptEntry {
  count: number;
  last: string;
  at: string;
  /** Reached `maxTaskAttempts` — waiting for the split (never eligible). */
  splitPending?: boolean;
  /** The task row as claimed — restored on release / take-over (the row leaves `AI_TODO` while claimed). */
  task?: TaskRow;
}

/** Read the attempts map (`{}` on any error). */
export async function readAttempts(root: string): Promise<Record<string, AttemptEntry>> {
  try {
    return JSON.parse(await readFileInRoot(root, join(root, ATTEMPTS_REL), "utf8")) as Record<string, AttemptEntry>;
  } catch {
    return {};
  }
}

/** Write the attempts map (sorted, pretty). */
export async function writeAttempts(root: string, map: Record<string, AttemptEntry>): Promise<void> {
  const sorted = Object.fromEntries(Object.entries(map).sort(([a], [b]) => a.localeCompare(b)));
  await writeFileInRoot(root, join(root, ATTEMPTS_REL), `${JSON.stringify(sorted, null, 2)}\n`);
}

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────

/** `YYYY-MM-DD HH:mm:ss` UTC — the books' timestamp format. */
export function stamp(d = new Date()): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

/** Parse a books timestamp (UTC) → epoch ms (NaN when unparsable). */
export function parseStamp(v: string): number {
  const iso = v.trim().replace(" ", "T");
  return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`);
}

/** Read a root-relative file ("" when missing or — ADR-0430 — a link leading outside the root). */
export async function readBook(root: string, rel: string): Promise<string> {
  try {
    return await readFileInRoot(root, join(root, rel), "utf8");
  } catch {
    return "";
  }
}

/** Write a root-relative file — symlink-safe (ADR-0430). */
export async function writeBook(root: string, rel: string, text: string): Promise<void> {
  await writeFileInRoot(root, join(root, rel), text);
}
