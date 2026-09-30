/**
 * Autonomous mode control on the worker (ADR-0152, autonomous.read/write/logs channels). The
 * dashboard drives the physic project's headless autonomous engine through the cli: read
 * settings+status+books+approvals, tail the tick log, write {settings|approvals|userTodo}, and
 * install/uninstall the cron. Everything is scoped to the serving physic project's root; the cron
 * line is keyed by that root's tick script so the 1:1:1:1:1 chain (ADR-0152) stays clean — the
 * cli also uninstalls its cron on physic delete/rename/unlink. Never throws — errors map to a
 * failing reply.
 */
import { readFile, writeFile, chmod } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { execFile, spawn } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  AutonomousBooks,
  AutonomousLogsReply,
  AutonomousReadReply,
  AutonomousStatus,
  AutonomousWriteReply,
  AutonomousWriteRequest,
} from "@4pm/ws";
import {
  readAutonomousConfig,
  readAutonomousConfigSync,
  readAutonomousConfigText,
  writeAutonomousConfig,
} from "./autonomous-config";
import { readHistories } from "./autonomous-history";
import { ATTEMPTS_REL } from "./autonomous-books";
import { mutateBooksOnBase, readBaseFile, resolveBases } from "./autonomous-git";

const run = promisify(execFile);

const APPROVALS_REL = ".claude/.autonomous.approvals.json";
// Authorship sidecar (ADR-0320): `{ "<id>": { by, at } }` — the last human who wrote (created/edited)
// a row, server-stamped on a `bookSave`. Used to enforce separation of duties on approval.
const AUTHORS_REL = ".claude/.autonomous.authors.json";
const TICK_REL = ".claude/hooks/autonomous-tick.sh";
const LOG_DIR_REL = ".claude/logs";
const BOOK_FILES: Record<keyof AutonomousBooks, string> = {
  userTodo: "USER_TODO.md",
  aiTodo: "AI_TODO.md",
  aiProgress: "AI_PROGRESS.md",
  aiDone: "AI_DONE.md",
  userQa: "USER_QA.md",
};

/** Read a file as UTF-8; a fallback string when it is missing/unreadable. */
async function readText(path: string, fallback = ""): Promise<string> {
  try {
    return await readFile(path, "utf8");
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
async function readJsonMap(path: string): Promise<Record<string, unknown>> {
  return (parseJson(await readText(path, "{}")) ?? {}) as Record<string, unknown>;
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
 * `bookSave` can tell which rows were added or edited (ADR-0320). Mirrors the web `parseFirstTable`
 * enough for the diff; separator/blank lines are skipped and the id cell is trimmed.
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

/** The capped books (ADR-0365) → their files. */
const CAPPED_BOOK_FILES = { USER_TODO: "USER_TODO.md", USER_QA: "USER_QA.md", AI_TODO: "AI_TODO.md" } as const;

/** Row ids currently in each capped book — diffed around an autonomous tick to count new rows (ADR-0365). */
export async function cappedBookIds(root: string): Promise<Record<keyof typeof CAPPED_BOOK_FILES, Set<string>>> {
  const out = {} as Record<keyof typeof CAPPED_BOOK_FILES, Set<string>>;
  for (const [book, file] of Object.entries(CAPPED_BOOK_FILES) as [keyof typeof CAPPED_BOOK_FILES, string][]) {
    out[book] = new Set(tableRowsById(await readText(join(root, file))).keys());
  }
  return out;
}

/** The physic project's tick-script absolute path (the cron line key). */
function tickScript(root: string): string {
  return join(root, TICK_REL);
}

/** Current crontab content (empty when the user has no crontab). */
async function crontabList(): Promise<string> {
  try {
    const { stdout } = await run("crontab", ["-l"], { timeout: 10_000 });
    return stdout;
  } catch {
    return "";
  }
}

/** Replace the crontab with `content` (via `crontab -`). Never throws. */
async function crontabSet(content: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("crontab", ["-"], { stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
    child.stdin.end(content.endsWith("\n") ? content : content + "\n");
  });
}

/** True when the crontab has a line for this physic project's tick script. */
async function cronInstalled(root: string): Promise<boolean> {
  const script = tickScript(root);
  return (await crontabList()).split("\n").some((l) => l.includes(script) && !l.trim().startsWith("#"));
}

/**
 * Compute the engine status from crontab + the profile-dir config + the project's histories (ADR-0152,
 * config relocated by ADR-0321). `root` = the served physic project; `profileDir` = where
 * `autonomous.config.json` lives.
 */
export async function getAutonomousStatus(root: string, profileDir: string): Promise<AutonomousStatus> {
  const [cfg, hist, installed] = await Promise.all([
    readAutonomousConfig(profileDir),
    readHistories(root),
    cronInstalled(root),
  ]);
  const last = hist.records[hist.records.length - 1];
  const today = new Date().toISOString().slice(0, 10);
  return {
    installed,
    paused: cfg.paused,
    cronSchedule: cfg.cronSchedule,
    lastTickAt: last?.ts ?? null,
    lastResult: last?.status ?? null,
    consecutiveFails: hist.consecutiveFails,
    todayTicks: hist.ticks.day === today ? hist.ticks.count : 0,
    // The last tick stopped on a protected base (ADR-0371 phase 0) — "<branch> (<repo>)".
    baseProtected: /^base-protected: (.+)$/.exec(last?.note ?? "")?.[1] ?? null,
  };
}

/** Coarse, synchronous "is it running?" for machine.status — !paused (profile config) and a recent tick. */
export function isAutonomousRunning(root: string, profileDir: string): boolean {
  try {
    if (readAutonomousConfigSync(profileDir).paused) return false;
    const h = JSON.parse(readFileSync(join(root, ".claude/.autonomous.histories.json"), "utf8")) as {
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

/** autonomous.read — the whole autonomous surface in one reply (config from the profile dir — ADR-0321). */
export async function readAutonomous(root: string, profileDir: string): Promise<AutonomousReadReply> {
  // The books live on `<base>` (ADR-0371): read them from `origin/<base>` — the working tree may be on a
  // task branch while the agent works — falling back to the working tree when there is no remote base.
  const base = (await resolveBases(root).catch(() => null))?.root.base ?? "";
  const read = async (rel: string, fallback = ""): Promise<string> => {
    const remote = base ? await readBaseFile(root, base, rel) : null;
    return remote === null ? readText(join(root, rel), fallback) : remote || fallback;
  };
  const [settings, approvals, authors, attempts, status, ...books] = await Promise.all([
    readAutonomousConfigText(profileDir),
    read(APPROVALS_REL, "{}"),
    read(AUTHORS_REL, "{}"),
    read(ATTEMPTS_REL, "{}"),
    getAutonomousStatus(root, profileDir),
    ...Object.values(BOOK_FILES).map((f) => read(f)),
  ]);
  const keys = Object.keys(BOOK_FILES) as (keyof AutonomousBooks)[];
  const bookMap = {} as AutonomousBooks;
  keys.forEach((k, i) => (bookMap[k] = books[i] ?? ""));
  return { settings, status, books: bookMap, approvals, authors, attempts };
}

/** autonomous.logs — tail one day's tick log (default today). */
export async function readAutonomousLogs(root: string, date?: string): Promise<AutonomousLogsReply> {
  const day = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : new Date().toISOString().slice(0, 10);
  const text = await readText(join(root, LOG_DIR_REL, `autonomous-tick-${day}.log`));
  const lines = text ? text.split("\n").filter((l) => l.length > 0).slice(-500) : [];
  return { date: day, lines };
}

/** Install the cron line for this physic project (idempotent — replaces any existing line). */
async function installCron(root: string, profileDir: string): Promise<void> {
  const script = tickScript(root);
  const cfg = await readAutonomousConfig(profileDir);
  await chmod(script, 0o755).catch(() => undefined);
  const kept = (await crontabList()).split("\n").filter((l) => l.trim() && !l.includes(script));
  kept.push(`${cfg.cronSchedule} ${script}`);
  await crontabSet(kept.join("\n"));
}

/** Sync the crontab line to the current `cronSchedule` (idempotent) — called by the daemon when the
 *  config changes or when a cycle runs, so a schedule edit takes effect without a manual reinstall. */
export async function syncCron(root: string, profileDir: string): Promise<void> {
  if (await cronInstalled(root)) await installCron(root, profileDir);
}

/** Remove this physic project's cron line (idempotent). Exposed for lifecycle cleanup. */
export async function uninstallCron(root: string): Promise<void> {
  const script = tickScript(root);
  const cur = await crontabList();
  if (!cur.includes(script)) return;
  const kept = cur.split("\n").filter((l) => l.trim() && !l.includes(script));
  await crontabSet(kept.join("\n"));
}

/** Re-point the cron from an old root to a new root when the physic folder is renamed. */
export async function repointCron(oldRoot: string, newRoot: string, profileDir: string): Promise<void> {
  if (!(await cronInstalled(oldRoot))) return;
  await uninstallCron(oldRoot);
  await installCron(newRoot, profileDir);
}

/** Result of a web book write before it is published. */
type WebWrite = { ok: boolean; code?: "APPROVAL_SELF"; failedId?: string; error?: string; added?: number };

/**
 * Apply one web book edit (approvals / batch / posted request / traced book save — ADR-0311/0319/0320)
 * to the books under `dir` (a side worktree of `<base>`, or the working tree when there is no remote).
 */
async function applyWebWrite(dir: string, req: AutonomousWriteRequest, by: string): Promise<WebWrite> {
  switch (req.kind) {
    case "approvals": {
      // Separation of duties (ADR-0320): a non-ADMIN may not approve a row they wrote.
      if (req.approved && !req.byIsAdmin) {
        const authors = await readJsonMap(join(dir, AUTHORS_REL));
        if (entryBy(authors, req.taskId) === by) return { ok: false, code: "APPROVAL_SELF", failedId: req.taskId, error: "self-approval blocked" };
      }
      const map = parseJson(await readText(join(dir, APPROVALS_REL), "{}")) ?? {};
      if (req.approved) map[req.taskId] = { approved: true, by, byLabel: req.byLabel ?? by, at: new Date().toISOString() };
      else delete map[req.taskId];
      await writeFile(join(dir, APPROVALS_REL), JSON.stringify(map, null, 2) + "\n", "utf8");
      return { ok: true };
    }
    case "approvalsBatch": {
      // SoD (ADR-0320): reject the WHOLE batch if any approved id was written by this non-ADMIN user.
      if (!req.byIsAdmin) {
        const authors = await readJsonMap(join(dir, AUTHORS_REL));
        const selfId = req.approve.find((id) => entryBy(authors, id) === by);
        if (selfId) return { ok: false, code: "APPROVAL_SELF", failedId: selfId, error: "self-approval blocked" };
      }
      // Commit many approve/unapprove ids in ONE write (ADR-0311) so a Save's coupled batch is atomic.
      const map = parseJson(await readText(join(dir, APPROVALS_REL), "{}")) ?? {};
      const at = new Date().toISOString();
      const byLabel = req.byLabel ?? by;
      for (const taskId of req.approve) map[taskId] = { approved: true, by, byLabel, at };
      for (const taskId of req.unapprove) delete map[taskId];
      await writeFile(join(dir, APPROVALS_REL), JSON.stringify(map, null, 2) + "\n", "utf8");
      return { ok: true };
    }
    case "userTodo": {
      // USER_TODO is a content-only `| ID | Group | Depends | Request |` table (ADR-0320): append the posted
      // request with a fresh `REQ-{group}-{req}` id (group = the largest seen + 1) and stamp the writer.
      const cur = await readText(join(dir, BOOK_FILES.userTodo));
      const ids = [...cur.matchAll(/REQ-(\d{4})-(\d{4})/g)];
      const maxGroup = ids.reduce((m, g) => Math.max(m, Number(g[1])), 0);
      const id = `REQ-${String(maxGroup + 1).padStart(4, "0")}-0001`;
      const row = `| ${id} | | | ${tableCell(req.content)} |\n`;
      await writeFile(join(dir, BOOK_FILES.userTodo), cur.replace(/\s*$/, "\n") + row, "utf8");
      const authors = await readJsonMap(join(dir, AUTHORS_REL));
      authors[id] = { by, byLabel: req.byLabel ?? by, at: new Date().toISOString() };
      await writeFile(join(dir, AUTHORS_REL), JSON.stringify(authors, null, 2) + "\n", "utf8");
      return { ok: true, added: 1 };
    }
    case "bookSave": {
      // Traced book save (ADR-0320): write the md and stamp the authors sidecar for every row this save
      // ADDED or EDITED (diff by id vs the book on <base>) — authorship is server-filled, not a cell.
      const file = BOOK_FILES[req.book];
      const prev = tableRowsById(await readText(join(dir, file)));
      const next = tableRowsById(req.content);
      const authors = await readJsonMap(join(dir, AUTHORS_REL));
      const at = new Date().toISOString();
      const byLabel = req.byLabel ?? by;
      let added = 0;
      for (const [id, cells] of next) {
        if (prev.get(id) !== cells) authors[id] = { by, byLabel, at };
        if (!prev.has(id)) added += 1;
      }
      await writeFile(join(dir, file), req.content, "utf8");
      await writeFile(join(dir, AUTHORS_REL), JSON.stringify(authors, null, 2) + "\n", "utf8");
      return { ok: true, added };
    }
    default:
      return { ok: false, error: "not a book write" };
  }
}

/**
 * Apply a web write (autonomous.write). Settings + cron stay local to the worker; book edits
 * (approvals, requests, book saves) are published straight to `<base>` through a side worktree
 * (ADR-0371) — the cycle's sync would otherwise discard an unpushed edit, and the working tree may be
 * on a task branch. With no remote base they fall back to the working tree.
 */
export async function writeAutonomous(
  root: string,
  profileDir: string,
  req: AutonomousWriteRequest,
  by: string,
): Promise<AutonomousWriteReply> {
  // Rows a userTodo / bookSave added — counted by the server toward the monthly book cap (ADR-0365).
  let added: number | undefined;
  try {
    if (req.kind === "settings") {
      // The config lives in the profile dir (ADR-0321), as clean JSON (coerced — comment keys dropped).
      const parsed = parseJson(req.settings);
      if (!parsed) return { ok: false, error: "settings is not valid JSON" };
      await writeAutonomousConfig(profileDir, parsed);
      await syncCron(root, profileDir); // a schedule change takes effect immediately when installed
    } else if (req.kind === "cron") {
      if (req.action === "install") await installCron(root, profileDir);
      else await uninstallCron(root);
    } else {
      const base = (await resolveBases(root).catch(() => null))?.root.base ?? "";
      let res: WebWrite | undefined;
      const pub = base
        ? await mutateBooksOnBase(root, base, `chore(web): ${req.kind} by ${req.byLabel ?? by}`, async (dir) => {
            res = await applyWebWrite(dir, req, by);
            return res.ok;
          })
        : "unchanged";
      if (res === undefined) res = await applyWebWrite(root, req, by); // no remote base ⇒ working tree
      else if (pub === "failed") return { ok: false, error: "could not push the change to the base branch (retry)" };
      if (!res.ok) return { ok: false, ...(res.code ? { code: res.code } : {}), ...(res.failedId ? { failedId: res.failedId } : {}), error: res.error };
      added = res.added;
    }
    return { ok: true, status: await getAutonomousStatus(root, profileDir), ...(added !== undefined ? { added } : {}) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
