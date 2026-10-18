/**
 * Autonomous tick scheduler — the daemon's own in-process clock for the autonomous loop,
 * replacing the OS crontab line. A `croner` job fires on `cronSchedule` and submits
 * one cycle through the same bus path `4pm auto-run` uses, so every gate (offline / quiet hours /
 * max ticks / quota) and the per-root serialization stay in `runAutonomousCycle`. Needs no cron
 * service, no extra process and no host privilege — it lives and dies with the `4pm start` daemon,
 * which a cycle needs anyway. One cli serves one physic project (1:1), so one job per process. It is an
 * engine-scoped lifecycle service: stopped when the daemon drains, so no restart leaves it ticking. Each fire
 * waits a random 0–30 s first, so workers on the same schedule don't race for the books branch at once.
 * @adr 0392 @adr 0152 @adr 0321 @adr 0505 @adr 0556
 */
import { Cron } from "croner";
import { logger } from "../../common/logger/logger";
import { DEFAULT_AUTONOMOUS_CONFIG, onAutonomousConfigWrite, readAutonomousConfig, readAutonomousConfigSync } from "./autonomous-config";
import { lifecycle } from "../session/lifecycle";
import { policyBlockReason, recordLastCheck } from "./autonomous-policy";
import { refreshBaseTemplateMarker } from "./template-marker";

/** What the scheduler needs from the daemon (read live, so a rename/attach/idle is picked up). */
export interface AutonomousSchedulerDeps {
  profileDir: string;
  /** The served physic project root, or null when the cli is idle. */
  servedRoot: () => string | null;
  /** Trigger one cycle (the `bus.submitAutonomous` path). */
  submit: () => void;
}

let deps: AutonomousSchedulerDeps | null = null;
/** Unsubscribes the config-write listener (every config write re-arms the job — ADR-0507). */
let offConfigWrite: (() => void) | null = null;
let job: Cron | null = null;
let pattern = "";
/** The jitter delay of the current fire, cleared on stop / re-arm. */
let jitterTimer: NodeJS.Timeout | null = null;
/** Upper bound of the random delay before a scheduled cycle. @adr 0556 */
const TICK_JITTER_MS = 30_000;

/**
 * True for a standard 5-field cron expression croner accepts in its strict (vixie) syntax — a step needs
 * a star or a range before it, so a bare `0/10` is rejected; no seconds field, so no
 * sub-minute ticks.
 * @adr 0412
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
  if (!deps || !deps.servedRoot() || lifecycle.stopping) return;
  if (readAutonomousConfigSync(deps.profileDir).paused) return;
  // The project switch is off / the server does not allow this worker (ADR-0507): skip silently like
  // `paused`, but keep the reason for the worker snapshot.
  const blocked = policyBlockReason();
  if (blocked) {
    recordLastCheck("skip", `policy: ${blocked}`);
    // Paused for a required template update: re-read the base marker so a merged Update PR resumes it (ADR-0550).
    if (blocked === "templateUpdateRequired") void refreshBaseTemplateMarker(deps.servedRoot()!);
    return;
  }
  deps.submit();
}

/** A cron fire: run `onTick` after a random 0–`TICK_JITTER_MS` delay (one pending delay at a time). @adr 0556 */
function onFire(): void {
  if (jitterTimer) return;
  jitterTimer = setTimeout(() => {
    jitterTimer = null;
    onTick();
  }, Math.floor(Math.random() * TICK_JITTER_MS));
  jitterTimer.unref();
}

/** Cancel a pending jitter delay. */
function clearJitter(): void {
  if (jitterTimer) clearTimeout(jitterTimer);
  jitterTimer = null;
}

/**
 * Submit one cycle now, outside the schedule (the web / public API "run now" — the same bus path as
 * `4pm auto-run`). Every gate of the cycle (paused, quiet hours, quota…) still applies inside it. False when
 * the scheduler isn't started or the cli serves no project.
 * @adr 0482
 */
export function runAutonomousNow(): boolean {
  if (!deps || !deps.servedRoot() || lifecycle.stopping) return false;
  deps.submit();
  return true;
}

/** Start the scheduler once per process (idempotent) and arm it from the current config. */
export function startAutonomousScheduler(d: AutonomousSchedulerDeps): void {
  if (deps || lifecycle.stopping) return;
  deps = d;
  lifecycle.register("autonomous.scheduler", "engine", stopAutonomousScheduler);
  offConfigWrite = onAutonomousConfigWrite(() => void reloadAutonomousSchedule());
  void reloadAutonomousSchedule();
}

/** Stop the job and forget the deps (the daemon is draining). @adr 0505 */
export function stopAutonomousScheduler(): void {
  offConfigWrite?.();
  offConfigWrite = null;
  job?.stop();
  job = null;
  clearJitter();
  pattern = "";
  deps = null;
}

/**
 * Re-arm the job from `cronSchedule` — called after a settings write so a schedule edit applies at
 * once. An invalid stored expression falls back to the default schedule (logged) instead of stopping.
 */
export async function reloadAutonomousSchedule(): Promise<void> {
  if (!deps) return;
  const cfg = await readAutonomousConfig(deps.profileDir);
  if (!deps) return; // stopped while reading
  let next = cfg.cronSchedule.trim();
  if (!isValidCronSchedule(next)) {
    logger.warn("autonomous.schedule.invalid", { cronSchedule: cfg.cronSchedule });
    next = DEFAULT_AUTONOMOUS_CONFIG.cronSchedule;
  }
  if (job && next === pattern) return;
  job?.stop();
  clearJitter();
  pattern = next;
  // `unref` so the timer never keeps a process alive on its own; `catch` so a throw can't kill the job.
  job = new Cron(next, { unref: true, catch: true }, onFire);
}
