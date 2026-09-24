/**
 * Autonomous config (ADR-0321) — the knobs for the unattended loop, stored as **clean JSON** (no
 * `_about`/`_*` comment keys; the web Settings Form labels + explains every field) at
 * `~/.4pm/profiles/<name>/autonomous.config.json` — the **profile dir**, next to `config.json` and
 * OUTSIDE any project repo, so the autonomous *parameters* never ship in a checkout and the *logic*
 * lives only in this cli. Read by the daemon each cycle; edited from the web Autonomous → Settings tab.
 */
import { readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The autonomous knobs (parameters only — no logic). */
export interface AutonomousConfig {
  /** Soft brake: the daemon skips the cycle without running the AI. */
  paused: boolean;
  /** Standard 5-field cron the daemon keeps the crontab line in sync with. */
  cronSchedule: string;
  /** Empty = run all day; `HH:MM-HH:MM` = skip within the window (may cross midnight). */
  quietHours: string;
  /** -1 = unlimited; >0 = cap on cycles that actually run in one local day. */
  maxTicksPerDay: number;
  /** After N consecutive failed cycles, set `paused=true` (0 = off). */
  stopOnConsecutiveFailures: number;
  /** Delete per-day tick logs older than N days (0 = keep forever). */
  logRetentionDays: number;
  /** Empty = the AI CLI's default model; else an id to force for the loop. */
  model: string;
  /** Skip the cycle when the 5h-session utilization is at/over this % (ADR-0321 quota gate). */
  maxSessionPct: number;
  /** Skip the cycle when the 7-day utilization is at/over this % (ADR-0321 quota gate). */
  maxWeeklyPct: number;
}

/** Defaults when the file is absent or a field is missing. */
export const DEFAULT_AUTONOMOUS_CONFIG: AutonomousConfig = {
  paused: true,
  cronSchedule: "*/10 * * * *",
  quietHours: "",
  maxTicksPerDay: -1,
  stopOnConsecutiveFailures: 3,
  logRetentionDays: 14,
  model: "",
  maxSessionPct: 80,
  maxWeeklyPct: 90,
};

/** The config file path under a profile dir. */
export function autonomousConfigPath(profileDir: string): string {
  return join(profileDir, "autonomous.config.json");
}

/** Coerce an unknown JSON object into a full config, filling defaults for missing/invalid fields. */
function coerce(raw: unknown): AutonomousConfig {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_AUTONOMOUS_CONFIG;
  const num = (v: unknown, def: number): number => (typeof v === "number" && Number.isFinite(v) ? v : def);
  const str = (v: unknown, def: string): string => (typeof v === "string" ? v : def);
  return {
    paused: typeof o.paused === "boolean" ? o.paused : d.paused,
    cronSchedule: str(o.cronSchedule, d.cronSchedule),
    quietHours: str(o.quietHours, d.quietHours),
    maxTicksPerDay: num(o.maxTicksPerDay, d.maxTicksPerDay),
    stopOnConsecutiveFailures: num(o.stopOnConsecutiveFailures, d.stopOnConsecutiveFailures),
    logRetentionDays: num(o.logRetentionDays, d.logRetentionDays),
    model: str(o.model, d.model),
    maxSessionPct: num(o.maxSessionPct, d.maxSessionPct),
    maxWeeklyPct: num(o.maxWeeklyPct, d.maxWeeklyPct),
  };
}

/** Read + parse the config (async). Missing/corrupt file ⇒ defaults. */
export async function readAutonomousConfig(profileDir: string): Promise<AutonomousConfig> {
  try {
    return coerce(JSON.parse(await readFile(autonomousConfigPath(profileDir), "utf8")));
  } catch {
    return { ...DEFAULT_AUTONOMOUS_CONFIG };
  }
}

/** Sync read (for the coarse `machine.status` running flag). Missing/corrupt ⇒ defaults. */
export function readAutonomousConfigSync(profileDir: string): AutonomousConfig {
  try {
    return coerce(JSON.parse(readFileSync(autonomousConfigPath(profileDir), "utf8")));
  } catch {
    return { ...DEFAULT_AUTONOMOUS_CONFIG };
  }
}

/** The raw config file text for the web editor (`{}`-pretty defaults when absent). */
export async function readAutonomousConfigText(profileDir: string): Promise<string> {
  try {
    return await readFile(autonomousConfigPath(profileDir), "utf8");
  } catch {
    return JSON.stringify(DEFAULT_AUTONOMOUS_CONFIG, null, 2) + "\n";
  }
}

/** Persist the config (from the web Settings editor); coerced so only real keys are written. */
export async function writeAutonomousConfig(profileDir: string, raw: unknown): Promise<void> {
  const cfg = coerce(raw);
  await writeFile(autonomousConfigPath(profileDir), JSON.stringify(cfg, null, 2) + "\n", "utf8");
}

/** True when `now` (local) falls inside the `HH:MM-HH:MM` quiet-hours window (supports crossing midnight). */
export function isInQuietHours(quietHours: string, now: Date = new Date()): boolean {
  const m = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(quietHours.trim());
  if (!m) return false;
  const toMin = (h: string, mi: string): number => Number(h) * 60 + Number(mi);
  const start = toMin(m[1]!, m[2]!);
  const end = toMin(m[3]!, m[4]!);
  const cur = now.getHours() * 60 + now.getMinutes();
  return start <= end ? cur >= start && cur < end : cur >= start || cur < end;
}
