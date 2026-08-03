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

const run = promisify(execFile);

const SETTINGS_REL = ".claude/.autonomous.settings.json";
const HISTORIES_REL = ".claude/.autonomous.histories.json";
const APPROVALS_REL = ".claude/.autonomous.approvals.json";
const TICK_REL = ".claude/hooks/autonomous-tick.sh";
const LOG_DIR_REL = ".claude/logs";
const BOOK_FILES: Record<keyof AutonomousBooks, string> = {
  userTodo: "USER_TODO.md",
  aiTodo: "AI_TODO.md",
  aiProgress: "AI_PROGRESS.md",
  aiDone: "AI_DONE.md",
  userQa: "USER_QA.md",
};
const DEFAULT_CRON = "*/10 * * * *";

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

/** Compute the engine status from crontab + settings + histories (ADR-0152). */
export async function getAutonomousStatus(root: string): Promise<AutonomousStatus> {
  const settings = parseJson(await readText(join(root, SETTINGS_REL))) ?? {};
  const hist = parseJson(await readText(join(root, HISTORIES_REL))) ?? {};
  const records = Array.isArray(hist.records) ? (hist.records as Record<string, unknown>[]) : [];
  const last = records[records.length - 1];
  const ticks = (hist.ticks as { day?: string; count?: number } | undefined) ?? {};
  const today = new Date().toISOString().slice(0, 10);
  return {
    installed: await cronInstalled(root),
    paused: settings.paused === true,
    cronSchedule: typeof settings.cron_schedule === "string" ? settings.cron_schedule : DEFAULT_CRON,
    lastTickAt: last && typeof last.ts === "string" ? last.ts : null,
    lastResult: last && typeof last.status === "string" ? last.status : null,
    consecutiveFails: typeof hist.consecutive_fails === "number" ? hist.consecutive_fails : 0,
    todayTicks: ticks.day === today && typeof ticks.count === "number" ? ticks.count : 0,
  };
}

/** Coarse, synchronous "is it running?" for machine.status — !paused and a recent tick. */
export function isAutonomousRunning(root: string): boolean {
  try {
    const s = JSON.parse(readFileSync(join(root, SETTINGS_REL), "utf8")) as { paused?: boolean };
    if (s.paused === true) return false;
    const h = JSON.parse(readFileSync(join(root, HISTORIES_REL), "utf8")) as {
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

/** autonomous.read — the whole autonomous surface in one reply. */
export async function readAutonomous(root: string): Promise<AutonomousReadReply> {
  const [settings, approvals, status, ...books] = await Promise.all([
    readText(join(root, SETTINGS_REL)),
    readText(join(root, APPROVALS_REL), "{}"),
    getAutonomousStatus(root),
    ...Object.values(BOOK_FILES).map((f) => readText(join(root, f))),
  ]);
  const keys = Object.keys(BOOK_FILES) as (keyof AutonomousBooks)[];
  const bookMap = {} as AutonomousBooks;
  keys.forEach((k, i) => (bookMap[k] = books[i] ?? ""));
  return { settings, status, books: bookMap, approvals };
}

/** autonomous.logs — tail one day's tick log (default today). */
export async function readAutonomousLogs(root: string, date?: string): Promise<AutonomousLogsReply> {
  const day = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : new Date().toISOString().slice(0, 10);
  const text = await readText(join(root, LOG_DIR_REL, `autonomous-tick-${day}.log`));
  const lines = text ? text.split("\n").filter((l) => l.length > 0).slice(-500) : [];
  return { date: day, lines };
}

/** Install the cron line for this physic project (idempotent — replaces any existing line). */
async function installCron(root: string): Promise<void> {
  const script = tickScript(root);
  const status = await getAutonomousStatus(root);
  await chmod(script, 0o755).catch(() => undefined);
  const kept = (await crontabList()).split("\n").filter((l) => l.trim() && !l.includes(script));
  kept.push(`${status.cronSchedule} ${script}`);
  await crontabSet(kept.join("\n"));
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
export async function repointCron(oldRoot: string, newRoot: string): Promise<void> {
  if (!(await cronInstalled(oldRoot))) return;
  await uninstallCron(oldRoot);
  await installCron(newRoot);
}

/** autonomous.write — a discriminated write (settings/approvals/userTodo/cron). Never throws. */
export async function writeAutonomous(
  root: string,
  req: AutonomousWriteRequest,
  by: string,
): Promise<AutonomousWriteReply> {
  try {
    switch (req.kind) {
      case "settings": {
        if (!parseJson(req.settings)) return { ok: false, error: "settings is not valid JSON" };
        await writeFile(join(root, SETTINGS_REL), req.settings, "utf8");
        break;
      }
      case "approvals": {
        const map = parseJson(await readText(join(root, APPROVALS_REL), "{}")) ?? {};
        if (req.approved) map[req.taskId] = { approved: true, by, at: new Date().toISOString() };
        else delete map[req.taskId];
        await writeFile(join(root, APPROVALS_REL), JSON.stringify(map, null, 2) + "\n", "utf8");
        break;
      }
      case "userTodo": {
        const cur = await readText(join(root, BOOK_FILES.userTodo));
        const block = `\n\n> posted by ${by} at ${new Date().toISOString()}\n${req.content.trim()}\n`;
        await writeFile(join(root, BOOK_FILES.userTodo), cur.trimEnd() + block, "utf8");
        break;
      }
      case "cron": {
        if (req.action === "install") await installCron(root);
        else await uninstallCron(root);
        break;
      }
    }
    return { ok: true, status: await getAutonomousStatus(root) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
