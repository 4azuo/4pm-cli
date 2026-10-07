/**
 * Autonomous tick scheduler (ADR-0392) — the daemon's own in-process clock for the autonomous loop,
 * replacing the OS crontab line (ADR-0152/0321). A `croner` job fires on `cronSchedule` and submits
 * one cycle through the same bus path `4pm auto-run` uses, so every gate (offline / quiet hours /
 * max ticks / quota) and the per-root serialization stay in `runAutonomousCycle`. Needs no cron
 * service, no extra process and no host privilege — it lives and dies with the `4pm start` daemon,
 * which a cycle needs anyway. One cli serves one physic project (1:1), so one job per process.
 */
import { Cron } from "croner";
import { logger } from "../common/logger/logger";
import { DEFAULT_AUTONOMOUS_CONFIG, readAutonomousConfig, readAutonomousConfigSync } from "./autonomous-config";

/** What the scheduler needs from the daemon (read live, so a rename/attach/idle is picked up). */
export interface AutonomousSchedulerDeps {
  profileDir: string;
  /** The served physic project root, or null when the cli is idle. */
  servedRoot: () => string | null;
  /** Trigger one cycle (the `bus.submitAutonomous` path). */
  submit: () => void;
}

let deps: AutonomousSchedulerDeps | null = null;
let job: Cron | null = null;
let pattern = "";

/**
 * True for a standard 5-field cron expression croner accepts in its strict (vixie) syntax — a step needs
 * a star or a range before it, so a bare `0/10` is rejected (ADR-0412); no seconds field, so no
 * sub-minute ticks.
 */
export function isValidCronSchedule(expr: string): boolean {
  const s = expr.trim();
  if (s.split(/\s+/).length !== 5) return false;
  try {
    new Cron(s, { paused: true }).stop();
    return true;
  } catch {
    return false;
  }
}

/** One scheduled fire: submit a cycle unless idle or paused (paused skips silently — no log noise). */
function onTick(): void {
  if (!deps || !deps.servedRoot()) return;
  if (readAutonomousConfigSync(deps.profileDir).paused) return;
  deps.submit();
}

/** Start the scheduler once per process (idempotent) and arm it from the current config. */
export function startAutonomousScheduler(d: AutonomousSchedulerDeps): void {
  if (deps) return;
  deps = d;
  void reloadAutonomousSchedule();
}

/**
 * Re-arm the job from `cronSchedule` — called after a settings write so a schedule edit applies at
 * once. An invalid stored expression falls back to the default schedule (logged) instead of stopping.
 */
export async function reloadAutonomousSchedule(): Promise<void> {
  if (!deps) return;
  const cfg = await readAutonomousConfig(deps.profileDir);
  let next = cfg.cronSchedule.trim();
  if (!isValidCronSchedule(next)) {
    logger.warn("autonomous.schedule.invalid", { cronSchedule: cfg.cronSchedule });
    next = DEFAULT_AUTONOMOUS_CONFIG.cronSchedule;
  }
  if (job && next === pattern) return;
  job?.stop();
  pattern = next;
  // `unref` so the timer never keeps a process alive on its own; `catch` so a throw can't kill the job.
  job = new Cron(next, { unref: true, catch: true }, onTick);
}
