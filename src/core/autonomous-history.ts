/**
 * Autonomous run history (ADR-0321) — replaces the scaffold's `autonomous-history.py`. The daemon owns
 * this now (the tick is dumb), tracking, per served project, the applied cron schedule, the
 * consecutive-failure count (for auto-pause), today's tick count (for max-ticks/day) and the last N run
 * records. Runtime state → kept at `<root>/.claude/.autonomous.histories.json` (gitignored). Never
 * throws — a missing/corrupt file initializes the default skeleton.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const HISTORIES_REL = ".claude/.autonomous.histories.json";
const MAX_RECORDS = 50;

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

/** Read the histories (default skeleton on any error). Tolerates the legacy snake_case keys. */
export async function readHistories(root: string): Promise<Histories> {
  try {
    const d = JSON.parse(await readFile(historiesPath(root), "utf8")) as Record<string, unknown>;
    const ticks = (d.ticks ?? {}) as { day?: string; count?: number };
    return {
      cronApplied: typeof d.cronApplied === "string" ? d.cronApplied : typeof d.cron_applied === "string" ? d.cron_applied : "",
      consecutiveFails: typeof d.consecutiveFails === "number" ? d.consecutiveFails : typeof d.consecutive_fails === "number" ? d.consecutive_fails : 0,
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
    await writeFile(historiesPath(root), JSON.stringify(h, null, 2) + "\n", "utf8");
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
