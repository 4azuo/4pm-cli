/**
 * Autonomous mode control on the worker (ADR-0152, autonomous.read/write/logs channels). The
 * dashboard drives the physic project's headless autonomous engine through the cli: read
 * settings+status+books+approvals, tail the tick log, write {settings|approvals|userTodo|bookSave}.
 * Everything is scoped to the serving physic project's root. Ticks come from the daemon's in-process
 * scheduler (ADR-0392 — no OS crontab), so on/off is just the `paused` flag. Never throws — errors map
 * to a failing reply.
 */
import { readFileSync } from "node:fs";
import { readFileInRoot, resolveForRead, writeFileInRoot } from "../../utils/safe-path";
import { join } from "node:path";
import type {
  ApprovalEntry,
  AutonomousBooks,
  AutonomousEvidenceReply,
  AutonomousEvidenceRequest,
  AutonomousLogsReply,
  AutonomousReadReply,
  AutonomousStatus,
  AutonomousWriteReply,
  AutonomousWriteRequest,
} from "@4pm/ws";
import { isSafeRepoDir } from "@4pm/dto";
import {
  readAutonomousConfig,
  readAutonomousConfigSync,
  readAutonomousConfigText,
  repoDirsOf,
  writeAutonomousConfig,
} from "./autonomous-config";
import { readHistories } from "./autonomous-history";
import { ATTEMPTS_REL, findTables, replaceRows } from "./autonomous-books";
import { approvalStates, buildApprovalEntries, mergeApprovalWrite, unapproveIds, type ApprovalBooks } from "./autonomous-approvals";
import { applyDiscussionBatch } from "./autonomous-discussions";
import { applyBookPatch, bookContentHash, bookRowsById, isBookRowId, type BookConflict } from "@4pm/dto";
import { freshBooksRef, mutateBooks, readBooksFile, resolveBases } from "./autonomous-git";
import { listDesignEvidence } from "./autonomous-er";
import { applyStagedEvidence, listMockups, pruneEvidence, readEvidenceFile, stageEvidence } from "./autonomous-evidence";
import { isValidCronSchedule, reloadAutonomousSchedule, runAutonomousNow } from "./autonomous-scheduler";
import { t } from "../../i18n";

const APPROVALS_REL = ".claude/.autonomous.approvals.json";
// Authorship sidecar (ADR-0320): `{ "<id>": { by, at } }` — the last human who wrote (created/edited)
// a row, server-stamped on a `bookSave`. Used to enforce separation of duties on approval.
const AUTHORS_REL = ".claude/.autonomous.authors.json";
const LOG_DIR_REL = ".claude/logs";
const BOOK_FILES: Record<keyof AutonomousBooks, string> = {
  userTodo: "USER_TODO.md",
  aiTodo: "AI_TODO.md",
  aiProgress: "AI_PROGRESS.md",
  aiDone: "AI_DONE.md",
  userQa: "USER_QA.md",
};

/**
 * Read a project file as UTF-8 — symlink-safe under `base` (ADR-0430: a linked book never surfaces a file
 * from outside the project); a fallback string when it is missing/unreadable/outside.
 */
async function readText(base: string, path: string, fallback = ""): Promise<string> {
  try {
    return await readFileInRoot(base, path, "utf8");
  } catch {
    return fallback;
  }
}

/** Parse JSON text; `null` when invalid. */
function parseJson(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Escape a value so it is safe inside one Markdown table cell (collapse newlines, escape pipes). */
function tableCell(value: string): string {
  return value.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
}

/** Read a JSON object map (`{}` on any error). */
async function readJsonMap(base: string, path: string): Promise<Record<string, unknown>> {
  return (parseJson(await readText(base, path, "{}")) ?? {}) as Record<string, unknown>;
}

/** The `by` recorded for a row id in an authors/approvals map, or null. */
function entryBy(map: Record<string, unknown>, id: string): string | null {
  const e = map[id];
  return e && typeof e === "object" && typeof (e as { by?: unknown }).by === "string"
    ? (e as { by: string }).by
    : null;
}

/**
 * Parse the FIRST Markdown table's rows keyed by their first-column id → the row's cells joined, so a
 * `bookSave` can tell which rows were added or edited. Mirrors the web `parseFirstTable`
 * enough for the diff; separator/blank lines are skipped and the id cell is trimmed.
 * @adr 0320
 */
function tableRowsById(md: string): Map<string, string> {
  const rows = new Map<string, string>();
  let headerSeen = false;
  let inTable = false;
  for (const line of md.split(/\r?\n/)) {
    const s = line.trim();
    if (!s.startsWith("|")) {
      if (inTable) break; // the table ended
      continue;
    }
    inTable = true;
    if (!headerSeen) {
      headerSeen = true;
      continue; // header row
    }
    if (/^\|[\s:|-]+\|?$/.test(s)) continue; // separator row
    const cells = s.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
    const id = cells[0] ?? "";
    if (id) rows.set(id, cells.join("\u0001"));
  }
  return rows;
}

/** The capped books → their files. @adr 0365 */
const CAPPED_BOOK_FILES = { USER_TODO: "USER_TODO.md", USER_QA: "USER_QA.md", AI_TODO: "AI_TODO.md" } as const;

/** Row ids currently in each capped book — diffed around an autonomous tick to count new rows. @adr 0365 */
export async function cappedBookIds(root: string): Promise<Record<keyof typeof CAPPED_BOOK_FILES, Set<string>>> {
  const out = {} as Record<keyof typeof CAPPED_BOOK_FILES, Set<string>>;
  for (const [book, file] of Object.entries(CAPPED_BOOK_FILES) as [keyof typeof CAPPED_BOOK_FILES, string][]) {
    out[book] = new Set(tableRowsById(await readText(root, join(root, file))).keys());
  }
  return out;
}

/**
 * Compute the engine status from the profile-dir config + the project's histories (ADR-0152, config
 * relocated by ADR-0321). `root` = the served physic project; `profileDir` = where
 * `autonomous.config.json` lives. `installed` is always true: the in-process scheduler is
 * armed for any served project, so on/off is `paused` alone (kept for wire compat — ADR-0317 guard).
 * @adr 0392
 */
export async function getAutonomousStatus(root: string, profileDir: string): Promise<AutonomousStatus> {
  const [cfg, hist] = await Promise.all([readAutonomousConfig(profileDir), readHistories(root)]);
  const last = hist.records[hist.records.length - 1];
  const today = new Date().toISOString().slice(0, 10);
  return {
    installed: true,
    paused: cfg.paused,
    cronSchedule: cfg.cronSchedule,
    lastTickAt: last?.ts ?? null,
    lastResult: last?.status ?? null,
    consecutiveFails: hist.consecutiveFails,
    todayTicks: hist.ticks.day === today ? hist.ticks.count : 0,
    // The last tick stopped on a protected books branch (ADR-0448 phase 0) — "<branch>".
    booksProtected: /^books-protected: (.+)$/.exec(last?.note ?? "")?.[1] ?? null,
  };
}

/** Coarse, synchronous "is it running?" for machine.status — !paused (profile config) and a recent tick. */
export function isAutonomousRunning(root: string, profileDir: string): boolean {
  try {
    if (readAutonomousConfigSync(profileDir).paused) return false;
    const histPath = resolveForRead(root, join(root, ".claude/.autonomous.histories.json"));
    if (!histPath) throw new Error("outside the project");
    const h = JSON.parse(readFileSync(histPath, "utf8")) as {
      records?: { ts?: string }[];
    };
    const ts = h.records?.[h.records.length - 1]?.ts;
    if (!ts) return false;
    const t = Date.parse(ts.replace(" ", "T"));
    return Number.isFinite(t) && Date.now() - t < 6 * 3600 * 1000; // ran within 6h
  } catch {
    return false;
  }
}

/** autonomous.read — the whole autonomous surface in one reply (config from the profile dir). @adr 0321 */
export async function readAutonomous(root: string, profileDir: string): Promise<AutonomousReadReply> {
  // The books live on `autonomous-books/<base>` (ADR-0448): read them from the remote books branch — the
  // working tree may be on a task branch while the agent works — falling back to the working tree when
  // there is no remote base.
  const base = (await resolveBases(root).catch(() => null))?.root.base ?? "";
  const read = async (rel: string, fallback = ""): Promise<string> => {
    const remote = base ? await readBooksFile(root, base, rel) : null;
    return remote === null ? readText(root, join(root, rel), fallback) : remote || fallback;
  };
  const cfg = await readAutonomousConfig(profileDir);
  // Sequences, ER change requests and book attachments for the Evidences rail (ADR-0453).
  const design = await listDesignEvidence(root, base ? await freshBooksRef(root, base) : null, cfg).catch(() => ({}));
  const [settings, approvals, authors, attempts, mockups, status, ...books] = await Promise.all([
    readAutonomousConfigText(profileDir),
    read(APPROVALS_REL, "{}"),
    read(AUTHORS_REL, "{}"),
    read(ATTEMPTS_REL, "{}"),
    // Intake UI mockups (ADR-0418) — the AI Todo rows offer a viewer for their group's files.
    listMockups(root, base || null, cfg.mockupDir).catch(() => [] as string[]),
    getAutonomousStatus(root, profileDir),
    ...Object.values(BOOK_FILES).map((f) => read(f)),
  ]);
  const keys = Object.keys(BOOK_FILES) as (keyof AutonomousBooks)[];
  const bookMap = {} as AutonomousBooks;
  keys.forEach((k, i) => (bookMap[k] = books[i] ?? ""));
  // Per-id verification (ADR-0438) so the web can mark unsigned / changed-after-approval rows.
  const approvalStatesById = approvalStates(parseJson(approvals) ?? {}, {
    userTodo: bookMap.userTodo,
    userQa: bookMap.userQa,
    aiTodo: bookMap.aiTodo,
  });
  return { settings, status, books: bookMap, approvals, authors, attempts, mockups, approvalStates: approvalStatesById, ...design };
}

/** autonomous.logs — tail one day's tick log (default today). */
export async function readAutonomousLogs(root: string, date?: string): Promise<AutonomousLogsReply> {
  const day = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : new Date().toISOString().slice(0, 10);
  const text = await readText(root, join(root, LOG_DIR_REL, `autonomous-tick-${day}.log`));
  const lines = text ? text.split("\n").filter((l) => l.length > 0).slice(-500) : [];
  return { date: day, lines };
}

/** Result of a web book write before it is published. */
type WebWrite = {
  ok: boolean;
  code?: "APPROVAL_SELF" | "APPROVAL_STALE" | "BOOK_TEAM_FORBIDDEN" | "BOOK_ROW_NOT_OWNED" | "USER_QA_ANSWER_ONLY" | "BOOK_CONFLICT" | "BOOK_STALE";
  failedId?: string;
  /** `BOOK_CONFLICT`: the rows (or the text around the table) the patch could not merge. @adr 0455 */
  conflicts?: BookConflict[];
  error?: string;
  added?: number;
  addedIds?: string[];
};

/**
 * Check a book save against the caller's write rules — `answerOnly`: no row added
 * or removed and only `Answer` changes; `ownRowsOnly`: changed / removed rows were written by the caller;
 * `editableTeams`: every changed row's old and new `Team` is in the list. Null when the save passes.
 * @adr 0450 @adr 0454
 */
function checkSaveRules(
  prevMd: string,
  nextMd: string,
  rules: { editableTeams?: string[] | null; ownRowsOnly?: boolean; answerOnly?: boolean },
  authors: Record<string, unknown>,
  by: string,
): WebWrite | null {
  const prev = bookRowsById(prevMd);
  const next = bookRowsById(nextMd);
  const added = [...next.keys()].filter((id) => !prev.has(id));
  const removed = [...prev.keys()].filter((id) => !next.has(id));
  const modified = [...next.keys()].filter((id) => prev.has(id) && JSON.stringify(prev.get(id)!.cells) !== JSON.stringify(next.get(id)!.cells));
  const fail = (code: NonNullable<WebWrite["code"]>, ids: string[], error: string): WebWrite => ({ ok: false, code, failedId: ids.join(","), error });
  if (rules.answerOnly) {
    const beyondAnswer = modified.filter((id) => {
      const a = { ...prev.get(id)!.cells, answer: "" };
      const b = { ...next.get(id)!.cells, answer: "" };
      return JSON.stringify(a) !== JSON.stringify(b);
    });
    const bad = [...added, ...removed, ...beyondAnswer];
    if (bad.length) return fail("USER_QA_ANSWER_ONLY", bad, "USER_QA_ANSWER_ONLY");
  }
  if (rules.ownRowsOnly) {
    const bad = [...modified, ...removed].filter((id) => entryBy(authors, id) !== by);
    if (bad.length) return fail("BOOK_ROW_NOT_OWNED", bad, "BOOK_ROW_NOT_OWNED");
  }
  if (Array.isArray(rules.editableTeams)) {
    const allowed = new Set(rules.editableTeams);
    const bad = [...added, ...removed, ...modified].filter(
      (id) => !allowed.has(prev.get(id)?.team ?? next.get(id)?.team ?? "") || !allowed.has(next.get(id)?.team ?? prev.get(id)?.team ?? ""),
    );
    if (bad.length) return fail("BOOK_TEAM_FORBIDDEN", bad, "BOOK_TEAM_FORBIDDEN");
  }
  return null;
}

/** The approval-targetable books as they are in `dir` (USER_TODO / USER_QA / AI_TODO). */
async function approvalBooksIn(dir: string): Promise<ApprovalBooks> {
  const [userTodo, userQa, aiTodo] = await Promise.all([
    readText(dir, join(dir, BOOK_FILES.userTodo)),
    readText(dir, join(dir, BOOK_FILES.userQa)),
    readText(dir, join(dir, BOOK_FILES.aiTodo)),
  ]);
  return { userTodo, userQa, aiTodo };
}

/** A stale-row refusal: the row changed after the approver read it. */
function stale(id: string): WebWrite {
  return { ok: false, code: "APPROVAL_STALE", failedId: id, error: "approval stale" };
}

/**
 * Apply one web book edit (approvals / batch / posted request / traced book save)
 * to the books under `dir` (a side worktree of the books branch `autonomous-books/<base>`, or the working tree when there is no remote).
 * @adr 0311 @adr 0319 @adr 0320
 */
async function applyWebWrite(dir: string, profileDir: string, req: AutonomousWriteRequest, by: string): Promise<WebWrite> {
  switch (req.kind) {
    case "approvals": {
      // Separation of duties: a non-ADMIN may not approve a row they wrote.
      if (req.approved && !req.byIsAdmin) {
        const authors = await readJsonMap(dir, join(dir, AUTHORS_REL));
        if (entryBy(authors, req.taskId) === by) return { ok: false, code: "APPROVAL_SELF", failedId: req.taskId, error: "self-approval blocked" };
      }
      const map = parseJson(await readText(dir, join(dir, APPROVALS_REL), "{}")) ?? {};
      if (req.approved) {
        // The server-signed entry, checked against the row as it is on the books branch now (ADR-0438).
        const books = await approvalBooksIn(dir);
        const built = buildApprovalEntries([req.taskId], req.signed, books, by, req.byLabel ?? by);
        if (!built.ok) return stale(built.staleId);
        const merged = mergeApprovalWrite(map, built.entries, req.parties, books);
        if (!merged.ok) return stale(merged.staleId);
      } else unapproveIds(map, [req.taskId], by, req.clearAll !== false);
      await writeFileInRoot(dir, join(dir, APPROVALS_REL), JSON.stringify(map, null, 2) + "\n");
      return { ok: true };
    }
    case "approvalsBatch": {
      // SoD: reject the WHOLE batch if any approved id was written by this non-ADMIN user.
      if (!req.byIsAdmin) {
        const authors = await readJsonMap(dir, join(dir, AUTHORS_REL));
        const selfId = req.approve.find((id) => entryBy(authors, id) === by);
        if (selfId) return { ok: false, code: "APPROVAL_SELF", failedId: selfId, error: "self-approval blocked" };
      }
      // Commit many approve/unapprove ids in ONE write so a Save's coupled batch is atomic.
      const map = parseJson(await readText(dir, join(dir, APPROVALS_REL), "{}")) ?? {};
      const books = await approvalBooksIn(dir);
      const built = buildApprovalEntries(req.approve, req.signed, books, by, req.byLabel ?? by);
      if (!built.ok) return stale(built.staleId);
      // Party approvals (ADR-0451) join `parties[]`; a final replaces the v1 entry.
      const merged = mergeApprovalWrite(map, built.entries, req.parties, books);
      if (!merged.ok) return stale(merged.staleId);
      unapproveIds(map, req.unapprove, by, req.clearAll !== false);
      await writeFileInRoot(dir, join(dir, APPROVALS_REL), JSON.stringify(map, null, 2) + "\n");
      return { ok: true };
    }
    case "userTodo": {
      // USER_TODO is a content-only `| ID | Group | Depends | Request |` table: append the posted
      // request with the id the server allocated (`REQ-GGGGGG-001`, ADR-0455) and stamp the writer.
      const cur = await readText(dir, join(dir, BOOK_FILES.userTodo));
      if (!req.id || !isBookRowId(req.id) || bookRowsById(cur).has(req.id)) return { ok: false, error: "invalid request id" };
      const id = req.id;
      // Insert into the request table (not at the end of the file — a trailing `<!-- 4pm:… -->` block
      // such as the attachment map must stay after the table; ADR-0400). No table ⇒ append as before.
      const table = findTables(cur).find((tb) => tb.header.some((h) => h.toLowerCase() === "id"));
      const next = table
        ? replaceRows(cur, table, [...table.rows, table.header.map((h) => (h.toLowerCase() === "id" ? id : /request/i.test(h) ? req.content : ""))])
        : cur.replace(/\s*$/, "\n") + `| ${id} | | | ${tableCell(req.content)} |\n`;
      await writeFileInRoot(dir, join(dir, BOOK_FILES.userTodo), next);
      const authors = await readJsonMap(dir, join(dir, AUTHORS_REL));
      authors[id] = { by, byLabel: req.byLabel ?? by, at: new Date().toISOString() };
      await writeFileInRoot(dir, join(dir, AUTHORS_REL), JSON.stringify(authors, null, 2) + "\n");
      return { ok: true, added: 1, addedIds: [id] };
    }
    case "bookSave": {
      // Traced book save: write the md and stamp the authors sidecar for every row this save
      // ADDED or EDITED (diff by id vs the book on the books branch) — authorship is server-filled, not a cell.
      const file = BOOK_FILES[req.book];
      // The book as it will be written (ADR-0455): the patch merged by row id onto the book as it is now (this
      // runs again on every push retry, so it merges with whatever landed meanwhile) — a row someone else changed
      // refuses the whole save; or a whole file, only when it was edited from the current version.
      const current = await readText(dir, join(dir, file));
      let content: string;
      if (req.patch) {
        const merged = applyBookPatch(current, req.patch);
        if (!merged.ok) return { ok: false, code: "BOOK_CONFLICT", conflicts: merged.conflicts, error: "book conflict" };
        content = merged.md;
      } else if (req.content !== undefined) {
        if (req.baseHash !== undefined && bookContentHash(current) !== req.baseHash) return { ok: false, code: "BOOK_STALE", error: "book stale" };
        content = req.content;
      } else return { ok: false, error: "content is required" };
      // The caller's write rules (ADR-0450/0454) — checked against the book on the books branch first.
      if (req.book !== "aiDone" && (req.editableTeams !== undefined || req.ownRowsOnly || req.answerOnly)) {
        const refused = checkSaveRules(
          await readText(dir, join(dir, file)),
          content,
          req,
          await readJsonMap(dir, join(dir, AUTHORS_REL)),
          by,
        );
        if (refused) return refused;
      }
      // Approvals riding on this save (ADR-0438) are checked BEFORE anything is written: SoD counts this
      // save's edits (the editor becomes the row's author), and each signed entry must match the saved row.
      const approving = req.book !== "aiDone" ? (req.approve ?? []) : [];
      const touchesApprovals =
        req.book !== "aiDone" && (approving.length > 0 || (req.unapprove?.length ?? 0) > 0 || Object.keys(req.parties ?? {}).length > 0);
      let approvalEntries: Record<string, ApprovalEntry> = {};
      let approvalBooksSaved: ApprovalBooks | null = null;
      if (touchesApprovals && req.book !== "aiDone") {
        const prevRows = tableRowsById(await readText(dir, join(dir, file)));
        const nextRows = tableRowsById(content);
        const authorsNow = await readJsonMap(dir, join(dir, AUTHORS_REL));
        if (!req.byIsAdmin) {
          const self = approving.find((id) => (prevRows.get(id) !== nextRows.get(id) ? by : entryBy(authorsNow, id)) === by);
          if (self) return { ok: false, code: "APPROVAL_SELF", failedId: self, error: "self-approval blocked" };
        }
        const books = await approvalBooksIn(dir);
        books[req.book as keyof ApprovalBooks] = content;
        const built = buildApprovalEntries(approving, req.signed, books, by, req.byLabel ?? by);
        if (!built.ok) return stale(built.staleId);
        approvalEntries = built.entries;
        // Parties must bind to the saved content too (checked before anything is written).
        const probe: Record<string, unknown> = {};
        const partiesOk = mergeApprovalWrite(probe, {}, req.parties, books);
        if (!partiesOk.ok) return stale(partiesOk.staleId);
        approvalBooksSaved = books;
      }
      // Evidence (ADR-0404): move the staged files in first — a missing/invalid one aborts the whole save.
      if (req.evidence?.length) {
        const bad = await applyStagedEvidence(dir, profileDir, req.book, req.evidence, (await readAutonomousConfig(profileDir)).evidenceDir);
        if (bad) return { ok: false, error: bad };
      }
      // AI Done is cli-written history (ADR-0400): the web only saves its `AI verify` verdicts there — no
      // authorship to stamp and no capped rows to count.
      if (req.book === "aiDone") {
        await writeFileInRoot(dir, join(dir, file), content);
        return { ok: true, added: 0 };
      }
      const prevText = await readText(dir, join(dir, file));
      const prev = tableRowsById(prevText);
      const next = tableRowsById(content);
      const authors = await readJsonMap(dir, join(dir, AUTHORS_REL));
      const at = new Date().toISOString();
      const byLabel = req.byLabel ?? by;
      let added = 0;
      const addedIds: string[] = [];
      for (const [id, cells] of next) {
        if (prev.get(id) !== cells) authors[id] = { by, byLabel, at };
        if (!prev.has(id)) {
          added += 1;
          addedIds.push(id);
        }
      }
      await writeFileInRoot(dir, join(dir, file), content);
      await writeFileInRoot(dir, join(dir, AUTHORS_REL), JSON.stringify(authors, null, 2) + "\n");
      if (touchesApprovals) {
        const map = parseJson(await readText(dir, join(dir, APPROVALS_REL), "{}")) ?? {};
        mergeApprovalWrite(map, approvalEntries, req.parties, approvalBooksSaved ?? (await approvalBooksIn(dir)));
        unapproveIds(map, req.unapprove ?? [], by, req.clearAll !== false);
        await writeFileInRoot(dir, join(dir, APPROVALS_REL), JSON.stringify(map, null, 2) + "\n");
      }
      // Files whose link this save removed (and no book still references) go in the same commit (ADR-0404).
      await pruneEvidence(dir, req.book, prevText, content);
      return { ok: true, added, addedIds };
    }
    default:
      return { ok: false, error: "not a book write" };
  }
}

/**
 * Apply a web write (autonomous.write). Settings stay local to the worker (profile dir); book edits
 * (approvals, requests, book saves) are published straight to the books branch through a side worktree
 * — the cycle's sync would otherwise discard an unpushed edit, and the working tree may be
 * on a task branch. With no remote base they fall back to the working tree.
 * @adr 0371
 */
export async function writeAutonomous(
  root: string,
  profileDir: string,
  req: AutonomousWriteRequest,
  by: string,
): Promise<AutonomousWriteReply> {
  // Rows a userTodo / bookSave added — counted by the server toward the monthly book cap (ADR-0365).
  let added: number | undefined;
  let addedIds: string[] | undefined;
  try {
    if (req.kind === "settings") {
      // The config lives in the profile dir (ADR-0321), as clean JSON (coerced — comment keys dropped).
      const parsed = parseJson(req.settings);
      if (!parsed) return { ok: false, error: t("autonomous.settingsInvalidJson") };
      if (typeof parsed.cronSchedule === "string" && !isValidCronSchedule(parsed.cronSchedule)) {
        return { ok: false, error: t("autonomous.settingsInvalidCron") };
      }
      // Evidence / mockup folders must be safe repo-relative paths (ADR-0418); empty ⇒ the default.
      for (const k of ["evidenceDir", "mockupDir", "erDir", "sequenceDir"] as const) {
        const v = typeof parsed[k] === "string" ? (parsed[k] as string).trim().replace(/\/+$/, "") : "";
        if (v && !isSafeRepoDir(v)) return { ok: false, error: t("autonomous.settingsInvalidDir") };
      }
      await writeAutonomousConfig(profileDir, parsed);
      await reloadAutonomousSchedule(); // a schedule change takes effect at once (ADR-0392)
    } else if (req.kind === "runNow") {
      // Run one cycle now (public API — ADR-0482): the same submit as `4pm auto-run`; the cycle's gates apply.
      if (!runAutonomousNow()) return { ok: false, error: t("autonomous.runNowUnavailable") };
    } else if (req.kind === "evidenceStage") {
      // Book evidence upload (machine-0072, ADR-0404): kept in the profile dir until a bookSave commits it.
      const staged = await stageEvidence(profileDir, req.contentBase64);
      return staged.ok ? { ok: true, stageId: staged.stageId } : { ok: false, error: staged.error };
    } else if (req.kind === "discussionBatch") {
      // Discussion files (ADR-0454): one books commit with the batch trailers; its own publish path.
      return await applyDiscussionBatch(root, req);
    } else if ((req as { kind: string }).kind === "cron") {
      // Retired (ADR-0392): an older dashboard's Install/Uninstall cron — the scheduler is always
      // armed, so answer with the live status instead of touching any crontab.
    } else {
      const base = (await resolveBases(root).catch(() => null))?.root.base ?? "";
      let res: WebWrite | undefined;
      const pub = base
        ? await mutateBooks(
            root,
            base,
            `chore(web): ${req.kind} by ${req.byLabel ?? by}`,
            async (dir) => {
              res = await applyWebWrite(dir, profileDir, req, by);
              return res.ok;
            },
            repoDirsOf(await readAutonomousConfig(profileDir)),
          )
        : "unchanged";
      if (res === undefined) res = await applyWebWrite(root, profileDir, req, by); // no remote base ⇒ working tree
      else if (pub === "failed") return { ok: false, error: "could not push the change to the base branch (retry)" };
      if (!res.ok) {
        return {
          ok: false,
          ...(res.code ? { code: res.code } : {}),
          ...(res.failedId ? { failedId: res.failedId } : {}),
          ...(res.conflicts ? { conflicts: res.conflicts } : {}),
          error: res.error,
        };
      }
      added = res.added;
      addedIds = res.addedIds;
    }
    return {
      ok: true,
      status: await getAutonomousStatus(root, profileDir),
      ...(added !== undefined ? { added } : {}),
      ...(addedIds?.length ? { addedIds } : {}),
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Read one committed book evidence file — or an intake mockup, a sequence diagram or an ER file — for the web.
 * @api machine-0073 @adr 0418 @adr 0404 @adr 0453
 */
export async function readAutonomousEvidence(root: string, profileDir: string, req: AutonomousEvidenceRequest): Promise<AutonomousEvidenceReply> {
  try {
    const base = (await resolveBases(root).catch(() => null))?.root.base ?? null;
    const { mockupDir, erDir, sequenceDir } = await readAutonomousConfig(profileDir);
    return await readEvidenceFile(root, base, req.path, req.ref, mockupDir, [erDir, sequenceDir]);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
