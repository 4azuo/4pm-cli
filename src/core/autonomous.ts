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
  const [settings, approvals, authors, status, ...books] = await Promise.all([
    readAutonomousConfigText(profileDir),
    readText(join(root, APPROVALS_REL), "{}"),
    readText(join(root, AUTHORS_REL), "{}"),
    getAutonomousStatus(root, profileDir),
    ...Object.values(BOOK_FILES).map((f) => readText(join(root, f))),
  ]);
  const keys = Object.keys(BOOK_FILES) as (keyof AutonomousBooks)[];
  const bookMap = {} as AutonomousBooks;
  keys.forEach((k, i) => (bookMap[k] = books[i] ?? ""));
  return { settings, status, books: bookMap, approvals, authors };
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

/** autonomous.write — a discriminated write (settings/approvals/userTodo/bookSave/cron). Never throws.
 *  `profileDir` holds the config (settings); `root` holds the books/approvals/authors + the cron. */
export async function writeAutonomous(
  root: string,
  profileDir: string,
  req: AutonomousWriteRequest,
  by: string,
): Promise<AutonomousWriteReply> {
  try {
    switch (req.kind) {
      case "settings": {
        // The config lives in the profile dir (ADR-0321), as clean JSON (coerced — comment keys dropped).
        const parsed = parseJson(req.settings);
        if (!parsed) return { ok: false, error: "settings is not valid JSON" };
        await writeAutonomousConfig(profileDir, parsed);
        // A schedule change takes effect immediately when the cron is installed.
        await syncCron(root, profileDir);
        break;
      }
      case "approvals": {
        // Separation of duties (ADR-0320): a non-ADMIN may not approve a row they wrote.
        if (req.approved && !req.byIsAdmin) {
          const authors = await readJsonMap(join(root, AUTHORS_REL));
          if (entryBy(authors, req.taskId) === by) {
            return { ok: false, code: "APPROVAL_SELF", failedId: req.taskId, error: "self-approval blocked" };
          }
        }
        const map = parseJson(await readText(join(root, APPROVALS_REL), "{}")) ?? {};
        if (req.approved) map[req.taskId] = { approved: true, by, byLabel: req.byLabel ?? by, at: new Date().toISOString() };
        else delete map[req.taskId];
        await writeFile(join(root, APPROVALS_REL), JSON.stringify(map, null, 2) + "\n", "utf8");
        break;
      }
      case "approvalsBatch": {
        // SoD (ADR-0320): reject the WHOLE batch if any approved id was written by this non-ADMIN user.
        if (!req.byIsAdmin) {
          const authors = await readJsonMap(join(root, AUTHORS_REL));
          const selfId = req.approve.find((id) => entryBy(authors, id) === by);
          if (selfId) return { ok: false, code: "APPROVAL_SELF", failedId: selfId, error: "self-approval blocked" };
        }
        // Commit many approve/unapprove ids in ONE write (ADR-0311) so a Save's coupled batch is atomic.
        const map = parseJson(await readText(join(root, APPROVALS_REL), "{}")) ?? {};
        const at = new Date().toISOString();
        const byLabel = req.byLabel ?? by;
        for (const taskId of req.approve) map[taskId] = { approved: true, by, byLabel, at };
        for (const taskId of req.unapprove) delete map[taskId];
        await writeFile(join(root, APPROVALS_REL), JSON.stringify(map, null, 2) + "\n", "utf8");
        break;
      }
      case "userTodo": {
        // USER_TODO is a content-only `| ID | Group | Depends | Request |` table (ADR-0320): append the
        // posted request as one row with a fresh `REQ-{group}-{req}` id (the approval key + a `Depends`
        // target), and stamp the writer in the authors sidecar. group = the largest REQ group seen + 1
        // (each web post is its own batch); req starts at 0001.
        const cur = await readText(join(root, BOOK_FILES.userTodo));
        const ids = [...cur.matchAll(/REQ-(\d{4})-(\d{4})/g)];
        const maxGroup = ids.reduce((m, g) => Math.max(m, Number(g[1])), 0);
        const id = `REQ-${String(maxGroup + 1).padStart(4, "0")}-0001`;
        const row = `| ${id} | | | ${tableCell(req.content)} |\n`;
        await writeFile(join(root, BOOK_FILES.userTodo), cur.replace(/\s*$/, "\n") + row, "utf8");
        const authors = await readJsonMap(join(root, AUTHORS_REL));
        authors[id] = { by, byLabel: req.byLabel ?? by, at: new Date().toISOString() };
        await writeFile(join(root, AUTHORS_REL), JSON.stringify(authors, null, 2) + "\n", "utf8");
        break;
      }
      case "bookSave": {
        // Traced book save (ADR-0320): write the md, and stamp the authors sidecar for every row this
        // save ADDED or EDITED (diff by id vs the on-disk book) — so authorship is server-filled, not a
        // client-written `.md` cell. Rows the cycle writes worker-side never pass through here.
        const file = BOOK_FILES[req.book];
        const prev = tableRowsById(await readText(join(root, file)));
        const next = tableRowsById(req.content);
        const authors = await readJsonMap(join(root, AUTHORS_REL));
        const at = new Date().toISOString();
        const byLabel = req.byLabel ?? by;
        for (const [id, cells] of next) {
          if (prev.get(id) !== cells) authors[id] = { by, byLabel, at };
        }
        await writeFile(join(root, file), req.content, "utf8");
        await writeFile(join(root, AUTHORS_REL), JSON.stringify(authors, null, 2) + "\n", "utf8");
        break;
      }
      case "cron": {
        if (req.action === "install") await installCron(root, profileDir);
        else await uninstallCron(root);
        break;
      }
    }
    return { ok: true, status: await getAutonomousStatus(root, profileDir) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
