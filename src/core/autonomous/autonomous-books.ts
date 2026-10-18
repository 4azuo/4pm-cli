/**
 * Autonomous books model — parse and rewrite the Markdown tables of the five book files the
 * cli now edits in code (claim, finish, release, question, split): `AI_TODO` tasks, the multi-row
 * `AI_PROGRESS` claims, `AI_DONE` (Done + Incidents), `USER_QA`, plus the `.autonomous.attempts.json`
 * sidecar. Cells are matched by header name, so a legacy 3-column `AI_PROGRESS` still parses. Rewrites
 * touch only the table rows — the prose around the table is kept byte-for-byte. Every book may carry a
 * `Team` column (a team code, ADR-0450): it is read when present and added (after `ID`) the first time a
 * row with a team is written. Likewise the metadata columns `Tags` / `Due`, added after `Team` (else `Title` / `ID`),
 * and the row `Title`, added right after `ID` and clamped to `BOOK_TITLE_MAX` on every write.
 * AI_TODO's approval-action column is `Actions`; a legacy `Tag` header is renamed in place on every rewrite.
 * @adr 0371 @adr 0450 @adr 0543 @adr 0549
 */
import { clampBookTitle } from "@4pm/dto";
import { readFileInRoot, writeFileInRoot } from "../../utils/safe-path";
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

/** Add a `Team` column right after `Title` (else `ID`) when `needed` and the table has none (old rows get ""). */
function withTeamColumn(table: MdTable, needed: boolean): MdTable {
  if (!needed || col(table.header, "Team") >= 0) return table;
  const at = (col(table.header, "Title") >= 0 ? col(table.header, "Title") : col(table.header, "ID")) + 1;
  return {
    ...table,
    header: [...table.header.slice(0, at), "Team", ...table.header.slice(at)],
    rows: table.rows.map((r) => [...r.slice(0, at), "", ...r.slice(at)]),
  };
}

/** Add the `Tags` / `Due` columns after `Team` (else `Title`, else `ID`) when `needed` and the table lacks them. @adr 0543 */
function withMetaColumns(table: MdTable, needed: boolean): MdTable {
  if (!needed) return table;
  return insertColumns(table, metaAnchor(table), ["Tags", "Due"]);
}

/** The column the `Tags` / `Due` columns follow: `Team`, else `Title`, else `ID`. */
function metaAnchor(table: MdTable): string {
  return col(table.header, "Team") >= 0 ? "Team" : col(table.header, "Title") >= 0 ? "Title" : "ID";
}

/** Add a `Title` column right after `ID` when `needed` and the table has none (old rows get ""). @adr 0549 */
function withTitleColumn(table: MdTable, needed: boolean): MdTable {
  return needed ? insertColumns(table, "ID", ["Title"]) : table;
}

/**
 * Give the AI_TODO and USER_QA tables a `Title` column (before intake, so the agent fills an existing cell);
 * rows are unchanged. @adr 0549
 */
export function withTitleColumns(md: string): string {
  const t = parseTasks(md).table ?? parseQa(md).table;
  if (!t || col(t.header, "Title") >= 0) return md;
  return replaceRows(md, withTitleColumn(t, true), withTitleColumn(t, true).rows);
}

/** Clamp every `Title` cell of every table to one line of `BOOK_TITLE_MAX` chars (after an agent edit). @adr 0549 */
export function clampTitles(md: string): string {
  let out = md;
  // Rewriting a table keeps the line count of the others, so re-find tables after each rewrite.
  for (let k = 0; ; k++) {
    const t = findTables(out)[k];
    if (!t) return out;
    const i = col(t.header, "Title");
    if (i < 0) continue;
    const rows = t.rows.map((r) => r.map((c, j) => (j === i ? clampBookTitle(c) : c)));
    if (rows.some((r, n) => r[i] !== t.rows[n]![i])) out = replaceRows(out, t, rows);
  }
}

/** The AI_TODO approval-action column name (formerly `Tag`). @adr 0543 */
export const ACTIONS_HEADER = "Actions";

/** Rename a legacy AI_TODO `Tag` header to `Actions` (no-op when already renamed). @adr 0543 */
function withActionsHeader(table: MdTable): MdTable {
  const i = col(table.header, "Tag");
  if (i < 0 || col(table.header, ACTIONS_HEADER) >= 0) return table;
  return { ...table, header: table.header.map((h, k) => (k === i ? ACTIONS_HEADER : h)) };
}

/** True when the AI_TODO table still has the legacy `Tag` header. @adr 0543 */
export function hasLegacyTagHeader(md: string): boolean {
  const t = parseTasks(md).table;
  return Boolean(t && col(t.header, "Tag") >= 0 && col(t.header, ACTIONS_HEADER) < 0);
}

/** Rewrite AI_TODO with its legacy `Tag` header renamed to `Actions` (rows unchanged). @adr 0543 */
export function upgradeTasksHeader(md: string): string {
  const t = parseTasks(md).table;
  if (!t || !hasLegacyTagHeader(md)) return md;
  return replaceRows(md, withActionsHeader(t), t.rows);
}

/** Rename AI_TODO's legacy `Tag` header to `Actions` in `root`; true when the book changed. @adr 0543 */
export async function upgradeActionsHeader(root: string): Promise<boolean> {
  const todo = await readBook(root, "AI_TODO.md");
  if (!hasLegacyTagHeader(todo)) return false;
  await writeBook(root, "AI_TODO.md", upgradeTasksHeader(todo));
  return true;
}

/** Give AI_TODO and USER_QA in `root` a `Title` column (before the intake agent edits them). @adr 0549 */
export async function addTitleColumns(root: string): Promise<void> {
  for (const book of ["AI_TODO.md", "USER_QA.md"]) {
    const md = await readBook(root, book);
    const next = withTitleColumns(md);
    if (next !== md) await writeBook(root, book, next);
  }
}

/** Clamp the `Title` cells of AI_TODO and USER_QA in `root` (after the intake agent edited them). @adr 0549 */
export async function clampBookTitles(root: string): Promise<void> {
  for (const book of ["AI_TODO.md", "USER_QA.md"]) {
    const md = await readBook(root, book);
    const next = clampTitles(md);
    if (next !== md) await writeBook(root, book, next);
  }
}

/** Build a row in the table's own column order from a name → value map. */
function build(header: string[], values: Record<string, string>): string[] {
  return header.map((h) => values[h.toLowerCase()] ?? "");
}

// ── AI_TODO ──────────────────────────────────────────────────────────────────────────────────────

/** One `AI_TODO` row — a task or a docs row (`DOC-…`, ADR-0536). `depends` holds `TSK-…` / `DOC-…` / `QA-…` ids. */
export interface TaskRow {
  id: string;
  priority: string;
  /** The `Actions` cell (approval actions — ADR-0311; the column was `Tag`). */
  tag: string;
  depends: string[];
  group: string;
  desc: string;
  notes: string;
  /** Team code ("" = untagged — ADR-0450). Optional on rows built before teams existed. */
  team?: string;
  /** `Title` cell — the row's short name. */
  title?: string;
  /** `Tags` cell — tag codes. */
  tags?: string;
  /** `Due` cell — `YYYY-MM-DD`. */
  due?: string;
}

/** Split a Depends cell into ids. */
export function splitIds(v: string): string[] {
  return v
    .split(/[,\s]+/)
    .map((x) => x.trim())
    .filter((x) => /^(TSK|DOC|QA)-/.test(x));
}

/** Parse the `AI_TODO` task table (task + docs rows). */
export function parseTasks(md: string): { table: MdTable | null; tasks: TaskRow[] } {
  const table = findTables(md).find((t) => col(t.header, "ID") >= 0 && col(t.header, "Depends") >= 0 && col(t.header, "Priority") >= 0) ?? null;
  if (!table) return { table: null, tasks: [] };
  const tasks = table.rows
    .map((r) => ({
      id: get(table, r, "ID"),
      priority: get(table, r, "Priority"),
      // `Actions` — a legacy `Tag` header is the same column until the next rewrite renames it.
      tag: col(table.header, ACTIONS_HEADER) >= 0 ? get(table, r, ACTIONS_HEADER) : get(table, r, "Tag"),
      depends: splitIds(get(table, r, "Depends")),
      group: get(table, r, "Group"),
      desc: get(table, r, "Task description"),
      notes: get(table, r, "Notes"),
      team: get(table, r, "Team"),
      title: get(table, r, "Title"),
      tags: get(table, r, "Tags"),
      due: get(table, r, "Due"),
    }))
    .filter((t) => /^(?:TSK|DOC)-/.test(t.id));
  return { table, tasks };
}

/** Rewrite the `AI_TODO` task table with `tasks`. */
export function writeTasks(md: string, tasks: TaskRow[]): string {
  const found = parseTasks(md).table;
  if (!found) return md;
  const table = withMetaColumns(
    withTeamColumn(withTitleColumn(withActionsHeader(found), tasks.some((t) => Boolean(t.title))), tasks.some((t) => Boolean(t.team))),
    tasks.some((t) => Boolean(t.tags || t.due)),
  );
  return replaceRows(
    md,
    table,
    tasks.map((t) =>
      build(table.header, {
        id: t.id,
        title: clampBookTitle(t.title ?? ""),
        priority: t.priority,
        actions: t.tag,
        tags: t.tags ?? "",
        due: t.due ?? "",
        depends: t.depends.join(", "),
        group: t.group,
        "task description": t.desc,
        notes: t.notes,
        team: t.team ?? "",
      }),
    ),
  );
}

// ── AI_PROGRESS (multi-row claims) ───────────────────────────────────────────────────────────────

/** The multi-row `AI_PROGRESS` header (`Team` — ADR-0450). */
export const PROGRESS_HEADER = ["Started", "ID", "Team", "Worker", "Claim", "Attempt", "Task description"];

/** One claimed task. */
export interface ClaimRow {
  started: string;
  id: string;
  /** Team code ("" = untagged). */
  team?: string;
  worker: string;
  claim: string;
  attempt: number;
  desc: string;
}

/** An intake claim id: an approved request or an answered intake question. @adr 0529 */
export function isIntakeClaimId(id: string): boolean {
  return /^(REQ|QA)-/.test(id);
}

/**
 * Parse `AI_PROGRESS` (a legacy 3-column table yields claims with no worker/claim id): `claims` = the task
 * claims (`TSK-…`, and `DOC-…` docs rounds — ADR-0536), `intake` = the intake claims (`REQ-…` / `QA-…` being taken in).
 * @adr 0529
 */
export function parseClaims(md: string): { table: MdTable | null; claims: ClaimRow[]; intake: ClaimRow[] } {
  const table = findTables(md).find((t) => col(t.header, "ID") >= 0 && col(t.header, "Started") >= 0) ?? null;
  if (!table) return { table: null, claims: [], intake: [] };
  const rows = table.rows.map((r) => ({
    started: get(table, r, "Started"),
    id: get(table, r, "ID"),
    team: get(table, r, "Team"),
    worker: get(table, r, "Worker"),
    claim: get(table, r, "Claim"),
    attempt: Number(get(table, r, "Attempt")) || 1,
    desc: get(table, r, "Task description"),
  }));
  return { table, claims: rows.filter((c) => /^(?:TSK|DOC)-/.test(c.id)), intake: rows.filter((c) => isIntakeClaimId(c.id)) };
}

/**
 * Rewrite `AI_PROGRESS` with `claims` (task claims) and `intake` (intake claims — omitted ⇒ the current
 * ones are kept, so a task-claim write never drops an intake row), upgrading a legacy table to the
 * multi-row header.
 * @adr 0529
 */
export function writeClaims(md: string, claims: ClaimRow[], intake?: ClaimRow[]): string {
  const parsed = parseClaims(md);
  const found = parsed.table;
  const table: MdTable = found
    ? { ...found, header: PROGRESS_HEADER }
    : { start: md.split("\n").length, end: md.split("\n").length, header: PROGRESS_HEADER, rows: [] };
  const src = found ? md : `${md.replace(/\n*$/, "")}\n\n`;
  return replaceRows(
    src,
    table,
    [...(intake ?? parsed.intake), ...claims].map((c) => [c.started, c.id, c.team ?? "", c.worker, c.claim, String(c.attempt), c.desc]),
  );
}

/** The ids (`ID` column) of every table row starting with `prefix`, in order. @adr 0529 */
export function rowIds(md: string, prefix: string): string[] {
  const out: string[] = [];
  for (const t of findTables(md)) {
    if (col(t.header, "ID") < 0) continue;
    for (const r of t.rows) {
      const id = get(t, r, "ID");
      if (id.startsWith(prefix)) out.push(id);
    }
  }
  return out;
}

/** The `Request` text of a `USER_TODO` row ("" when absent). @adr 0529 */
export function requestText(md: string, id: string): string {
  for (const t of findTables(md)) {
    if (col(t.header, "ID") < 0 || col(t.header, "Request") < 0) continue;
    const row = t.rows.find((r) => get(t, r, "ID") === id);
    if (row) return get(t, row, "Request");
  }
  return "";
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
 * Upgrade a Done table in place: `Group` + `Depends` after `ID` and `Evidence` after `Files`,
 * keeping every other column (e.g. the web's `AI verify`).
 * @adr 0400 @adr 0404
 */
function withDoneColumns(table: MdTable, team = false, meta = false, title = false): MdTable {
  const base = withTitleColumn(insertColumns(insertColumns(table, "ID", ["Group", "Depends"]), "Files", ["Evidence"]), title);
  const teamed = team ? insertColumns(base, "Group", ["Team"]) : base;
  return meta ? insertColumns(teamed, col(teamed.header, "Team") >= 0 ? "Team" : "Group", ["Tags", "Due"]) : teamed;
}

/** Append a Done row (`Timestamp | ID | Title | Group | Depends | Task description | Files | Evidence | Notes`). */
export function appendDone(
  md: string,
  row: {
    id: string;
    group: string;
    depends: string[];
    desc: string;
    files: string;
    evidence: string;
    notes: string;
    team?: string;
    tags?: string;
    due?: string;
    title?: string;
  },
): string {
  const found = findTables(md).find((t) => col(t.header, "ID") >= 0 && col(t.header, "Timestamp") >= 0);
  if (!found) return md;
  const table = withDoneColumns(found, Boolean(row.team), Boolean(row.tags || row.due), Boolean(row.title));
  const values = {
    timestamp: stamp(),
    id: row.id,
    title: clampBookTitle(row.title ?? ""),
    team: row.team ?? "",
    tags: row.tags ?? "",
    due: row.due ?? "",
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
  /** Team code ("" = untagged). */
  team?: string;
  group: string;
  depends: string;
  original: string;
  question: string;
  answer: string;
  /** `Title` cell — the question's short name. */
  title?: string;
  /** `Tags` / `Due` cells. */
  tags?: string;
  due?: string;
}

/** Parse the `USER_QA` table. */
export function parseQa(md: string): { table: MdTable | null; rows: QaRow[] } {
  const table = findTables(md).find((t) => col(t.header, "ID") >= 0 && col(t.header, "Answer") >= 0) ?? null;
  if (!table) return { table: null, rows: [] };
  const rows = table.rows
    .map((r) => ({
      id: get(table, r, "ID"),
      team: get(table, r, "Team"),
      group: get(table, r, "Group"),
      depends: get(table, r, "Depends"),
      original: get(table, r, "Original request"),
      question: get(table, r, "Question / options"),
      answer: get(table, r, "Answer"),
      title: get(table, r, "Title"),
      tags: get(table, r, "Tags"),
      due: get(table, r, "Due"),
    }))
    .filter((q) => /^QA-/.test(q.id));
  return { table, rows };
}

/** Rewrite the `USER_QA` table. */
export function writeQa(md: string, rows: QaRow[]): string {
  const found = parseQa(md).table;
  if (!found) return md;
  const table = withMetaColumns(
    withTeamColumn(withTitleColumn(found, rows.some((q) => Boolean(q.title))), rows.some((q) => Boolean(q.team))),
    rows.some((q) => Boolean(q.tags || q.due)),
  );
  return replaceRows(
    md,
    table,
    rows.map((q) =>
      build(table.header, {
        id: q.id,
        title: clampBookTitle(q.title ?? ""),
        team: q.team ?? "",
        tags: q.tags ?? "",
        due: q.due ?? "",
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

/** Relative path of the attempts sidecar (committed on `<base>` with the books). */
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
  /**
   * The task's branch conflicts with `<base>` and the agent could not resolve it: never picked until a person
   * presses Retry or the branch merges cleanly again (`base` / `head` = the shas it was blocked at). @adr 0539
   */
  blocked?: { reason: "merge-conflict"; at: string; base: string; head: string };
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

/** Write a root-relative file — symlink-safe. @adr 0430 */
export async function writeBook(root: string, rel: string, text: string): Promise<void> {
  await writeFileInRoot(root, join(root, rel), text);
}
