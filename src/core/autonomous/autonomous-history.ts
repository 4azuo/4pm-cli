/**
 * Autonomous run history — replaces the scaffold's `autonomous-history.py`. The daemon owns
 * this now (the tick is dumb), tracking, per served project, the applied cron schedule, the
 * consecutive-failure count (for auto-pause), today's tick count (for max-ticks/day) and the last N run
 * records. Runtime state → kept at `<root>/.4pm/.autonomous.histories.json` (local: listed in `.git/info/exclude`),
 * the newest 100 records. Never throws — a missing/corrupt file initializes the default
 * skeleton.
 * @adr 0321 @adr 0563
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AUTONOMOUS_LOCK_REL, HISTORIES_REL } from "@4pm/dto";
import { readFileInRoot, writeFileInRoot } from "../../utils/safe-path";

const MAX_RECORDS = 100;

/** The local autonomous files a checkout must never commit. */
const LOCAL_FILES = [HISTORIES_REL, AUTONOMOUS_LOCK_REL];

/**
 * Keep the local autonomous files out of git in this checkout (`.git/info/exclude`, outside the books-overlay block).
 * Best-effort.
 * @adr 0563
 */
export async function ensureLocalAutonomousFiles(root: string): Promise<void> {
  try {
    const file = join(root, ".git", "info", "exclude");
    const cur = await readFile(file, "utf8").catch(() => "");
    const missing = LOCAL_FILES.filter((p) => !cur.split("\n").includes(`/${p}`));
    if (missing.length) {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, `${cur}${cur && !cur.endsWith("\n") ? "\n" : ""}${missing.map((p) => `/${p}`).join("\n")}\n`, "utf8");
    }
  } catch {
    /* best-effort */
  }
}

/** One recorded cycle. */
export interface HistoryRecord {
  ts: string;
  status: "success" | "failure" | "skip";
  note: string;
  tick: string;
}

/** The whole history skeleton. */
export interface Histories {
  cronApplied: string;
  consecutiveFails: number;
  ticks: { day: string; count: number };
  records: HistoryRecord[];
}

const SKELETON: Histories = { cronApplied: "", consecutiveFails: 0, ticks: { day: "", count: 0 }, records: [] };

/** Path to the histories file under a project root. */
function historiesPath(root: string): string {
  return join(root, HISTORIES_REL);
}

/** Read the histories (default skeleton on any error). */
export async function readHistories(root: string): Promise<Histories> {
  try {
    const d = JSON.parse(await readFileInRoot(root, historiesPath(root), "utf8")) as Record<string, unknown>;
    const ticks = (d.ticks ?? {}) as { day?: string; count?: number };
    return {
      cronApplied: typeof d.cronApplied === "string" ? d.cronApplied : "",
      consecutiveFails: typeof d.consecutiveFails === "number" ? d.consecutiveFails : 0,
      ticks: { day: typeof ticks.day === "string" ? ticks.day : "", count: typeof ticks.count === "number" ? ticks.count : 0 },
      records: Array.isArray(d.records) ? (d.records as HistoryRecord[]) : [],
    };
  } catch {
    return { ...SKELETON, ticks: { ...SKELETON.ticks }, records: [] };
  }
}

/** Persist the histories (atomic-ish write). Never throws. */
export async function writeHistories(root: string, h: Histories): Promise<void> {
  try {
    await writeFileInRoot(root, historiesPath(root), JSON.stringify(h, null, 2) + "\n");
  } catch {
    /* best-effort — a read-only mount just loses history */
  }
}

/** Today's tick count (0 when the stored day isn't today). */
export function todayTickCount(h: Histories, today: string): number {
  return h.ticks.day === today ? h.ticks.count : 0;
}

/** Append a run record (capped at the last N) — mutates + returns `h`. */
export function pushRecord(h: Histories, rec: HistoryRecord): Histories {
  h.records.push(rec);
  if (h.records.length > MAX_RECORDS) h.records = h.records.slice(-MAX_RECORDS);
  return h;
}
