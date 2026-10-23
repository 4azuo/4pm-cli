/**
 * The autonomous archive — finished work leaves the live books (they stay small for the web and the agents) and
 * moves, still in git, to `.4pm/archive/<YYYY-MM>/` under the live file names: a request `Done` for more than
 * `archiveAfterDays` takes its USER_TODO row, the USER_QA rows and AI_DONE rows of its lineage groups and their
 * sidecar entries (approvals, authors, docs, lineage) to the month it finished — only when none of its groups has a
 * live row (to do, trashed, claimed, an open question) and every PR of them is merged (or merged directly). A request
 * with no groups finishes when its row was last written; an AI_DONE group no request produced archives on its own; old AI_DONE incidents, ER / diagram
 * history beyond the newest 100 entries and branch-deletion entries older than 90 days follow. Every archived row id is
 * listed in `.4pm/archive/ids.json` (id → month), so an archived task still counts as done for a live `Depends` and the
 * row is found from its id. Runs inside the books publish at most once a UTC day (`.4pm/archive/LAST`). `readArchive` serves the web's archive search
 * from the books branch.
 * @adr 0563 @api machine-0096
 */
import {
  APPROVALS_SIDECAR_REL,
  ARCHIVE_DIR,
  ARCHIVE_INDEX_REL,
  parseArchiveIndex,
  AUTHORS_SIDECAR_REL,
  BOOK_STATE,
  BRANCH_DELETIONS_REL,
  DELIVERY_SIDECAR_REL,
  DIAGRAM_SIDECAR_REL,
  DOCS_SIDECAR_REL,
  DONE_REVIEWS_SIDECAR_REL,
  ER_SIDECAR_REL,
  LINEAGE_SIDECAR_REL,
  archiveMonthDir,
  bookGroupOf,
  bookRowStates,
  deliveryLanded,
  deliveryOfCell,
  parseDocsSidecar,
  parseLineage,
} from "@4pm/dto";
import type { AutonomousArchiveReply, AutonomousArchiveRequest, AutonomousArchiveRow } from "@4pm/ws";
import * as B from "./autonomous-books";
import { gitQuiet } from "./autonomous-git";

/** The day mark of the last archive run. */
const LAST_REL = `${ARCHIVE_DIR}/LAST`;
/** ER / diagram history entries kept live. */
const HISTORY_KEEP = 100;
/** Branch-deletion entries kept live (days). */
const DELETIONS_KEEP_DAYS = 90;
/** The column the archive adds to USER_TODO / USER_QA rows: when the request finished. */
const FINISHED = "Finished";

/** Read a JSON sidecar of a books checkout (`{}` on anything invalid). */
async function readJson(dir: string, rel: string): Promise<Record<string, unknown>> {
  try {
    const o = JSON.parse((await B.readBook(dir, rel)) || "{}") as unknown;
    return o && typeof o === "object" && !Array.isArray(o) ? (o as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Write a JSON sidecar (sorted keys at the top level, pretty). */
async function writeJson(dir: string, rel: string, map: Record<string, unknown>): Promise<void> {
  await B.writeBook(dir, rel, `${JSON.stringify(Object.fromEntries(Object.entries(map).sort(([a], [b]) => a.localeCompare(b))), null, 2)}\n`);
}

/** Column index (case-insensitive) or -1. */
function colOf(header: readonly string[], name: string): number {
  return header.findIndex((h) => h.trim().toLowerCase() === name.toLowerCase());
}

/** The id table of a book (has `ID`; AI_DONE's Done table also has `Timestamp`). */
function idTable(md: string, done = false): B.MdTable | undefined {
  return B.findTables(md).find((t) => colOf(t.header, "ID") >= 0 && (!done || colOf(t.header, "Timestamp") >= 0));
}

/** AI_DONE's incident table (`Timestamp | Note`, no ID). */
function incidentTable(md: string): B.MdTable | undefined {
  return B.findTables(md).find((t) => colOf(t.header, "Note") >= 0 && colOf(t.header, "Timestamp") >= 0 && colOf(t.header, "ID") < 0);
}

/** One row as `header name → cell`. */
function rowMap(header: readonly string[], row: readonly string[]): Record<string, string> {
  return Object.fromEntries(header.map((h, i) => [h, row[i] ?? ""]));
}

/**
 * Append rows (by header name) to the matching table of an archive file, creating the file / table with the live
 * header when missing and widening an older header with new columns.
 */
function appendArchiveRows(md: string, title: string, header: readonly string[], rows: Record<string, string>[], pick: (md: string) => B.MdTable | undefined): string {
  if (rows.length === 0) return md;
  const base = md.trim() ? md : `# ${title}\n`;
  const found = pick(base);
  const names = found ? [...found.header, ...header.filter((h) => colOf(found.header, h) < 0)] : [...header];
  const table: B.MdTable = found
    ? { ...found, header: names, rows: found.rows.map((r) => names.map((_, i) => r[i] ?? "")) }
    : { start: base.split("\n").length + 1, end: base.split("\n").length + 1, header: names, rows: [] };
  const src = found ? base : `${base.replace(/\n*$/, "")}\n\n`;
  const add = rows.map((r) => names.map((h) => r[h] ?? r[Object.keys(r).find((k) => k.toLowerCase() === h.toLowerCase()) ?? ""] ?? ""));
  return B.replaceRows(src, table, [...table.rows, ...add]);
}

/** `YYYY-MM` of a books timestamp (UTC). */
function monthOf(stamp: string): string {
  const t = B.parseStamp(stamp);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 7) : new Date().toISOString().slice(0, 7);
}

/** The `at` of a row's authors entry as a books timestamp, or undefined. */
function authorAt(authors: Record<string, unknown>, id: string): string | undefined {
  const at = (authors[id] as { at?: unknown } | undefined)?.at;
  return typeof at === "string" && Number.isFinite(Date.parse(at)) ? B.stamp(new Date(at)) : undefined;
}

/** The groups (6-digit codes) a request produced, through the lineage (`source` or `root`). */
function groupsOfRequest(lineage: ReturnType<typeof parseLineage>, id: string): string[] {
  return Object.entries(lineage)
    .filter(([, e]) => e.source === id || e.root === id)
    .map(([g]) => g);
}

/** One request ready for the archive: its id, groups, finish time and month. */
interface ArchiveUnit {
  id: string;
  groups: Set<string>;
  finished: string;
  month: string;
}

/**
 * Archive finished work in the books checkout `dir` (inside `publishBooks`): at most once per UTC day. True when
 * anything moved (the books changed).
 * @adr 0563
 */
export async function archiveBooks(dir: string, archiveAfterDays: number, now = new Date()): Promise<boolean> {
  const today = now.toISOString().slice(0, 10);
  if ((await B.readBook(dir, LAST_REL)).trim() === today) return false;
  const cutoff = now.getTime() - archiveAfterDays * 86_400_000;
  const [userTodo, userQa, aiDone, aiTodo, aiProgress, lineageText, docsText, authors] = await Promise.all([
    B.readBook(dir, "USER_TODO.md"),
    B.readBook(dir, "USER_QA.md"),
    B.readBook(dir, "AI_DONE.md"),
    B.readBook(dir, "AI_TODO.md"),
    B.readBook(dir, "AI_PROGRESS.md"),
    B.readBook(dir, LINEAGE_SIDECAR_REL),
    B.readBook(dir, DOCS_SIDECAR_REL),
    readJson(dir, AUTHORS_SIDECAR_REL),
  ]);
  const lineage = parseLineage(lineageText);
  const docs = parseDocsSidecar(docsText);
  const doneTable = idTable(aiDone, true);
  const tsCol = doneTable ? colOf(doneTable.header, "Timestamp") : -1;
  const idCol = doneTable ? colOf(doneTable.header, "ID") : -1;
  const delCol = doneTable ? colOf(doneTable.header, "Delivery") : -1;
  // Finish time of a group = its newest AI_DONE row; a group with a PR still open / closed is not finished.
  const groupFinish = new Map<string, string>();
  const unlanded = new Set<string>();
  for (const r of doneTable?.rows ?? []) {
    const g = bookGroupOf(r[idCol] ?? "");
    if (!g) continue;
    const ts = r[tsCol] ?? "";
    if (!groupFinish.has(g) || B.parseStamp(ts) > B.parseStamp(groupFinish.get(g)!)) groupFinish.set(g, ts);
    const d = delCol >= 0 ? deliveryOfCell(r[delCol] ?? "") : null;
    if (d === "open" || d === "closed") unlanded.add(g);
  }
  for (const [g, e] of Object.entries(lineage)) if (e.delivery && !deliveryLanded(e.delivery)) unlanded.add(g);
  for (const [id, e] of Object.entries(docs)) if (e.pr && !deliveryLanded(e.pr)) unlanded.add(bookGroupOf(id) ?? "");
  // Groups with a live row (to do, in the trash, claimed, an open question) stay — whatever their request's state.
  const openGroups = new Set(
    [
      ...B.parseTasks(aiTodo).tasks.map((t) => t.id),
      ...B.trashedIds(aiTodo, now.getTime()),
      ...B.parseClaims(aiProgress).claims.map((c) => c.id),
      ...B.parseQa(userQa).rows.filter(B.qaOpen).map((q) => q.id),
    ].map((id) => bookGroupOf(id) ?? ""),
  );
  const ready = (g: string): boolean => !openGroups.has(g) && !unlanded.has(g);
  const old = (stamp: string | undefined): stamp is string => !!stamp && B.parseStamp(stamp) <= cutoff;
  const units: ArchiveUnit[] = [];
  for (const [id, state] of bookRowStates(userTodo)) {
    if (state !== BOOK_STATE.done) continue;
    const groups = groupsOfRequest(lineage, id);
    if (!groups.every(ready)) continue;
    // A request intake turned into no rows finishes when its row was last written (authors sidecar).
    const finished = groups.length
      ? groups.map((g) => groupFinish.get(g) ?? "").filter(Boolean).sort((a, b) => B.parseStamp(b) - B.parseStamp(a))[0]
      : authorAt(authors, id);
    if (!old(finished)) continue;
    units.push({ id, groups: new Set(groups), finished, month: monthOf(finished) });
  }
  // AI_DONE groups no request produced (rows added by hand) archive on their own finish time.
  for (const [g, finished] of groupFinish) {
    if (lineage[g] || !ready(g) || !old(finished)) continue;
    units.push({ id: `GRP-${g}`, groups: new Set([g]), finished, month: monthOf(finished) });
  }
  let changed = await archiveSidecarHistories(dir, now);
  if (units.length) {
    await archiveUnits(dir, units, { userTodo, userQa, aiDone });
    changed = true;
  }
  changed = (await archiveIncidents(dir, cutoff)) || changed;
  await B.writeBook(dir, LAST_REL, `${today}\n`);
  return changed;
}

/** Move the rows + sidecar entries of the archive units, month by month. */
async function archiveUnits(dir: string, units: readonly ArchiveUnit[], books: { userTodo: string; userQa: string; aiDone: string }): Promise<void> {
  const groupMonth = new Map<string, ArchiveUnit>();
  for (const u of units) for (const g of u.groups) groupMonth.set(g, u);
  const reqUnit = new Map(units.map((u) => [u.id, u]));
  const unitOf = (id: string): ArchiveUnit | undefined => reqUnit.get(id) ?? groupMonth.get(bookGroupOf(id) ?? "");
  const moved = new Map<string, ArchiveUnit>();
  for (const [rel, done] of [
    ["USER_TODO.md", false],
    ["USER_QA.md", false],
    ["AI_DONE.md", true],
  ] as const) {
    const md = rel === "USER_TODO.md" ? books.userTodo : rel === "USER_QA.md" ? books.userQa : books.aiDone;
    const t = idTable(md, done);
    if (!t) continue;
    const idc = colOf(t.header, "ID");
    const keep: string[][] = [];
    const out = new Map<string, Record<string, string>[]>();
    for (const r of t.rows) {
      const id = r[idc] ?? "";
      const u = unitOf(id);
      // USER_QA rows go only once answered and done; a row still open stays live.
      const qaOpen = rel === "USER_QA.md" && bookRowStates(md).get(id) !== BOOK_STATE.done;
      if (!u || qaOpen) {
        keep.push(r);
        continue;
      }
      moved.set(id, u);
      const row = rowMap(t.header, r);
      if (!done) row[FINISHED] = u.finished;
      out.set(u.month, [...(out.get(u.month) ?? []), row]);
    }
    if (out.size === 0) continue;
    await B.writeBook(dir, rel, B.replaceRows(md, t, keep));
    const index = parseArchiveIndex(await B.readBook(dir, ARCHIVE_INDEX_REL));
    for (const [month, rs] of out) for (const r of rs) index[r["ID"] ?? r["Id"] ?? r["id"] ?? ""] = month;
    delete index[""];
    await B.writeBook(dir, ARCHIVE_INDEX_REL, `${JSON.stringify(Object.fromEntries(Object.entries(index).sort(([a], [b]) => a.localeCompare(b))), null, 2)}\n`);
    const header = done ? t.header : [...t.header, FINISHED];
    for (const [month, rows] of out) {
      const target = `${archiveMonthDir(month)}/${rel}`;
      const cur = await B.readBook(dir, target);
      await B.writeBook(dir, target, appendArchiveRows(cur, `Archive ${month} — ${rel.replace(/\.md$/, "")}`, header, rows, (m) => idTable(m, done)));
    }
  }
  // Sidecar entries keyed by row id, and the lineage keyed by group.
  // The AI Done delivery records ride with their rows (ADR-0582).
  // The follow-up reviews of AI Done rows too (ADR-0616).
  for (const rel of [APPROVALS_SIDECAR_REL, AUTHORS_SIDECAR_REL, DOCS_SIDECAR_REL, DELIVERY_SIDECAR_REL, DONE_REVIEWS_SIDECAR_REL]) {
    const live = await readJson(dir, rel);
    const byMonth = new Map<string, Record<string, unknown>>();
    for (const [id, v] of Object.entries(live)) {
      const u = moved.get(id) ?? (rel === DOCS_SIDECAR_REL ? unitOf(id) : undefined);
      if (!u) continue;
      byMonth.set(u.month, { ...(byMonth.get(u.month) ?? {}), [id]: v });
      delete live[id];
    }
    if (byMonth.size === 0) continue;
    await writeJson(dir, rel, live);
    for (const [month, add] of byMonth) {
      const target = `${archiveMonthDir(month)}/${rel.split("/").pop()}`;
      await writeJson(dir, target, { ...(await readJson(dir, target)), ...add });
    }
  }
  const lin = await readJson(dir, LINEAGE_SIDECAR_REL);
  const linMonth = new Map<string, Record<string, unknown>>();
  for (const [g, v] of Object.entries(lin)) {
    const u = groupMonth.get(g);
    if (!u) continue;
    linMonth.set(u.month, { ...(linMonth.get(u.month) ?? {}), [g]: v });
    delete lin[g];
  }
  if (linMonth.size) {
    await writeJson(dir, LINEAGE_SIDECAR_REL, lin);
    for (const [month, add] of linMonth) {
      const target = `${archiveMonthDir(month)}/${LINEAGE_SIDECAR_REL.split("/").pop()}`;
      await writeJson(dir, target, { ...(await readJson(dir, target)), ...add });
    }
  }
}

/** The ids the archive holds (`.4pm/archive/ids.json`) — an archived task / doc is done. @adr 0563 */
export async function archivedIds(dir: string): Promise<Set<string>> {
  return new Set(Object.keys(parseArchiveIndex(await B.readBook(dir, ARCHIVE_INDEX_REL))));
}

/** Move AI_DONE incidents older than the cutoff to the archive of their month. */
async function archiveIncidents(dir: string, cutoff: number): Promise<boolean> {
  const md = await B.readBook(dir, "AI_DONE.md");
  const t = incidentTable(md);
  if (!t) return false;
  const ts = colOf(t.header, "Timestamp");
  const keep: string[][] = [];
  const out = new Map<string, Record<string, string>[]>();
  for (const r of t.rows) {
    const at = B.parseStamp(r[ts] ?? "");
    if (!Number.isFinite(at) || at > cutoff) {
      keep.push(r);
      continue;
    }
    const month = monthOf(r[ts] ?? "");
    out.set(month, [...(out.get(month) ?? []), rowMap(t.header, r)]);
  }
  if (out.size === 0) return false;
  await B.writeBook(dir, "AI_DONE.md", B.replaceRows(md, t, keep));
  for (const [month, rows] of out) {
    const target = `${archiveMonthDir(month)}/AI_DONE.md`;
    const cur = await B.readBook(dir, target);
    await B.writeBook(dir, target, appendArchiveRows(cur, `Archive ${month} — AI_DONE`, t.header, rows, incidentTable));
  }
  return true;
}

/** ER / diagram history beyond the newest entries and old branch deletions → this month's archive. */
async function archiveSidecarHistories(dir: string, now: Date): Promise<boolean> {
  const month = now.toISOString().slice(0, 7);
  let changed = false;
  for (const rel of [ER_SIDECAR_REL, DIAGRAM_SIDECAR_REL]) {
    const live = await readJson(dir, rel);
    const history = Array.isArray(live.history) ? (live.history as unknown[]) : [];
    if (history.length <= HISTORY_KEEP) continue;
    const old = history.slice(0, history.length - HISTORY_KEEP);
    live.history = history.slice(-HISTORY_KEEP);
    await B.writeBook(dir, rel, `${JSON.stringify(live, null, 2)}\n`);
    const target = `${archiveMonthDir(month)}/${rel.split("/").pop()}`;
    const arc = await readJson(dir, target);
    await B.writeBook(dir, target, `${JSON.stringify({ history: [...(Array.isArray(arc.history) ? arc.history : []), ...old] }, null, 2)}\n`);
    changed = true;
  }
  const log = await readJson(dir, BRANCH_DELETIONS_REL);
  const entries = Array.isArray(log.entries) ? (log.entries as { at?: string }[]) : [];
  const limit = now.getTime() - DELETIONS_KEEP_DAYS * 86_400_000;
  const old = entries.filter((e) => Date.parse(e.at ?? "") < limit);
  if (old.length) {
    log.entries = entries.filter((e) => !old.includes(e));
    await B.writeBook(dir, BRANCH_DELETIONS_REL, `${JSON.stringify(log, null, 2)}\n`);
    const target = `${archiveMonthDir(month)}/${BRANCH_DELETIONS_REL.split("/").pop()}`;
    const arc = await readJson(dir, target);
    await B.writeBook(dir, target, `${JSON.stringify({ entries: [...(Array.isArray(arc.entries) ? arc.entries : []), ...old] }, null, 2)}\n`);
    changed = true;
  }
  return changed;
}

// ── Read (machine-0096) ───────────────────────────────────────────────────────────────────────────

/** `git show <ref>:<path>` text ("" when missing). */
async function show(root: string, ref: string, path: string): Promise<string> {
  return gitQuiet(root, ["show", `${ref}:${path}`]);
}

/** A JSON map at `<ref>:<path>` (`{}` when missing / invalid). */
async function showJson(root: string, ref: string, path: string): Promise<Record<string, unknown>> {
  try {
    const o = JSON.parse((await show(root, ref, path)) || "{}") as unknown;
    return o && typeof o === "object" && !Array.isArray(o) ? (o as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** A cell by header name (case-insensitive). */
function cellOf(cells: Record<string, string>, name: string): string {
  const k = Object.keys(cells).find((h) => h.toLowerCase() === name.toLowerCase());
  return k ? (cells[k] ?? "") : "";
}

/**
 * Search the archive on `ref` (the books branch): month folders within From–To, the three books' rows filtered by
 * book, id prefix, text, team, tag, requester (through the lineage `by` the books do not keep — the requester is the
 * request's author entry), state and delivery; newest first; one page.
 * @api machine-0096 @adr 0563
 */
export async function readArchive(root: string, ref: string, req: AutonomousArchiveRequest): Promise<AutonomousArchiveReply> {
  const months = (await gitQuiet(root, ["ls-tree", "--name-only", `${ref}:${ARCHIVE_DIR}`]))
    .split("\n")
    .map((l) => l.trim())
    .filter((m) => /^\d{4}-\d{2}$/.test(m))
    .filter((m) => (!req.from || m >= req.from.slice(0, 7)) && (!req.to || m <= req.to.slice(0, 7)))
    .sort()
    .reverse();
  const books = req.book ? [req.book] : (["USER_TODO", "USER_QA", "AI_DONE"] as const);
  const q = (req.q ?? "").trim().toLowerCase();
  const rows: AutonomousArchiveRow[] = [];
  for (const month of months) {
    const dir = archiveMonthDir(month);
    const [approvals, authors, lineageMap] = await Promise.all([
      showJson(root, ref, `${dir}/${APPROVALS_SIDECAR_REL.split("/").pop()}`),
      showJson(root, ref, `${dir}/${AUTHORS_SIDECAR_REL.split("/").pop()}`),
      showJson(root, ref, `${dir}/${LINEAGE_SIDECAR_REL.split("/").pop()}`),
    ]);
    for (const book of books) {
      const md = await show(root, ref, `${dir}/${book}.md`);
      const t = idTable(md, book === "AI_DONE");
      if (!t) continue;
      for (const r of t.rows) {
        const cells = rowMap(t.header, r);
        const id = cellOf(cells, "ID");
        const finishedAt = book === "AI_DONE" ? cellOf(cells, "Timestamp") : cellOf(cells, FINISHED);
        const day = finishedAt.slice(0, 10);
        if (req.from && day && day < req.from) continue;
        if (req.to && day && day > req.to) continue;
        if (req.id && !id.startsWith(req.id)) continue;
        if (req.team && cellOf(cells, "Team") !== req.team) continue;
        if (req.tag && !cellOf(cells, "Tags").split(/[,\s]+/).includes(req.tag)) continue;
        if (req.state && cellOf(cells, "State") !== req.state) continue;
        const delivery = book === "AI_DONE" ? deliveryOfCell(cellOf(cells, "Delivery")) : null;
        if (req.delivery && delivery !== req.delivery) continue;
        const author = authors[id] as { by?: string } | undefined;
        if (req.requester && author?.by !== req.requester) continue;
        if (q && !Object.values(cells).some((v) => v.toLowerCase().includes(q))) continue;
        const g = bookGroupOf(id) ?? "";
        rows.push({
          book,
          month,
          id,
          title: cellOf(cells, "Title"),
          finishedAt,
          cells,
          ...(cellOf(cells, "Team") ? { team: cellOf(cells, "Team") } : {}),
          ...(cellOf(cells, "Tags") ? { tags: cellOf(cells, "Tags") } : {}),
          ...(cellOf(cells, "State") ? { state: cellOf(cells, "State") } : {}),
          ...(delivery ? { delivery } : {}),
          ...(approvals[id] ? { approval: approvals[id] } : {}),
          ...(authors[id] ? { author: authors[id] } : {}),
          ...(lineageMap[g] ? { lineage: lineageMap[g] } : {}),
        });
      }
    }
  }
  rows.sort((a, b) => B.parseStamp(b.finishedAt) - B.parseStamp(a.finishedAt));
  const page = Math.max(1, req.page ?? 1);
  const size = Math.min(100, Math.max(1, req.size ?? 20));
  return { rows: rows.slice((page - 1) * size, page * size), total: rows.length, page, size };
}
