/**
 * Autonomous config — the knobs for the unattended loop, stored as **clean JSON** (no
 * `_about`/`_*` comment keys; the web Settings Form labels + explains every field) at
 * `~/.4pm/profiles/<name>/autonomous.config.json` — the **profile dir**, next to `config.json` and
 * OUTSIDE any project repo, so the autonomous *parameters* never ship in a checkout and the *logic*
 * lives only in this cli. Read by the daemon each cycle; edited from the web Autonomous → Settings tab.
 * ADR-0418: `evidenceDir` / `mockupDir` folders; the old `model` knob is gone (each AI profile's model applies)
 * and is dropped on the next save. ADR-0453: `erDir` / `sequenceDir` folders (the project ER + sequence diagrams).
 * ADR-0507: the project-scoped knobs (claim TTL / check, attempts, run timeout, size hints, folders) come
 * from the server policy when one was received — `readAutonomousConfig` returns the **effective** config
 * (worker file ⊕ policy); every write is a patch of changed keys under a mutex, carrying who paused.
 * ADR-0563: `archiveAfterDays` / `booksSyncMinutes` (archive + books sync); one request per intake claim.
 * @adr 0321 @adr 0507 @adr 0563
 */
import { readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DIAGRAM_ROOT, ER_ROOT, EVIDENCE_ROOT, MOCKUP_ROOT, PROJECT_AUTONOMOUS_KEYS, SEQUENCE_ROOT, isSafeRepoDir, type AutonomousPausedBy } from "@4pm/dto";
import { autonomousPolicy } from "./autonomous-policy";

/** The autonomous knobs (parameters only — no logic). */
export interface AutonomousConfig {
  /** The on/off switch: when true the daemon's scheduler does not start cycles. @adr 0392 */
  paused: boolean;
  /** Who / what paused this worker, why and when (absent while running). @adr 0507 */
  pausedBy?: AutonomousPausedBy;
  pausedReason?: string;
  pausedAt?: string;
  /** Standard 5-field cron the daemon's in-process scheduler fires on (ADR-0392 — no OS crontab). */
  cronSchedule: string;
  /** Empty = run all day; `HH:MM-HH:MM` = skip within the window (may cross midnight). */
  quietHours: string;
  /** -1 = unlimited; >0 = cap on cycles that actually run in one local day. */
  maxTicksPerDay: number;
  /** After N consecutive failed cycles, set `paused=true` (0 = off). */
  stopOnConsecutiveFailures: number;
  /** Delete per-day tick logs older than N days (0 = keep forever). */
  logRetentionDays: number;
  /** Skip the cycle when the 5h-session utilization is at/over this % (ADR-0321 quota gate). */
  maxSessionPct: number;
  /** Skip the cycle when the 7-day utilization is at/over this % (ADR-0321 quota gate). */
  maxWeeklyPct: number;
  /** A task claim lives this long from `Started`; older ⇒ released by its holder / taken over. @adr 0371 */
  claimTtlHours: number;
  /** Re-verify the held claim this often while the agent works; lost ⇒ the run is stopped. @adr 0371 */
  claimCheckMinutes: number;
  /** A task that fails / overruns this many times is split into child tasks. @adr 0371 */
  maxTaskAttempts: number;
  /**
   * Wall-clock cap (minutes) of each AI run of the cycle (intake / implement / split) — replaces the
   * AI-run timeout for these runs; clamped to [5, claimTtlHours × 60]. @adr 0452
   */
  runTimeoutMinutes: number;
  /** Indicative S/M size hints for intake — guidance for the agent, not hard caps. @adr 0371 §6 */
  taskSizeHints: { sMaxFiles: number; sMaxLines: number; mMaxFiles: number; mMaxLines: number };
  /** Repo-relative folder of new book evidence files (ADR-0418; default `.4pm/evidence`). */
  evidenceDir: string;
  /** Repo-relative folder of the intake UI mockups (ADR-0418; default `.4pm/mockups`). */
  mockupDir: string;
  /** Repo-relative folder of the project ER module files + change requests (default `.4pm/er`). @adr 0453 */
  erDir: string;
  /** Repo-relative folder of the task / question sequence diagrams (default `.4pm/sequences`). @adr 0453 */
  sequenceDir: string;
  /** Repo-relative folder of the draw.io system diagram + change requests (default `.4pm/diagrams`). @adr 0530 */
  diagramDir: string;
  /**
   * Apply new system-diagram / ER change requests without a person. Taken from the server policy only — a value in
   * the worker file is ignored, so nothing on the worker can turn it on. @adr 0530
   */
  diagramAutoApprove: boolean;
  erAutoApprove: boolean;
  /** Merge a finished task into `<base>` instead of a PR — policy-only, like the auto-approves. @adr 0539 */
  skipPullRequest: boolean;
  /** Resolve one conflicting 4PM PR per cycle — policy-only. @adr 0539 */
  autoResolvePrConflicts: boolean;
  /** Daily cleanup of dead 4PM task branches — policy-only. @adr 0540 */
  branchCleanup: { enabled: boolean; afterDays: number };
  /** Intake adds a `DOC-…` row per request, reviewed in rounds before its tasks run — policy-only. @adr 0536 */
  docsPhase: boolean;
  /** A `Done` request stays in the live books this many days before the archive moves it — policy-only. @adr 0563 */
  archiveAfterDays: number;
  /** The books-sync PR is refreshed at most this often (minutes) — policy-only. @adr 0563 */
  booksSyncMinutes: number;
}

/** Lower bound of `runTimeoutMinutes`. @adr 0452 */
const MIN_RUN_TIMEOUT_MINUTES = 5;

/** Defaults when the file is absent or a field is missing. */
export const DEFAULT_AUTONOMOUS_CONFIG: AutonomousConfig = {
  paused: true,
  cronSchedule: "*/10 * * * *",
  quietHours: "",
  maxTicksPerDay: -1,
  stopOnConsecutiveFailures: 3,
  logRetentionDays: 14,
  maxSessionPct: 80,
  maxWeeklyPct: 90,
  claimTtlHours: 6,
  claimCheckMinutes: 10,
  maxTaskAttempts: 5,
  runTimeoutMinutes: 60,
  taskSizeHints: { sMaxFiles: 5, sMaxLines: 300, mMaxFiles: 20, mMaxLines: 1500 },
  evidenceDir: EVIDENCE_ROOT,
  mockupDir: MOCKUP_ROOT,
  erDir: ER_ROOT,
  sequenceDir: SEQUENCE_ROOT,
  diagramDir: DIAGRAM_ROOT,
  diagramAutoApprove: true,
  erAutoApprove: false,
  skipPullRequest: false,
  autoResolvePrConflicts: false,
  branchCleanup: { enabled: false, afterDays: 14 },
  docsPhase: true,
  archiveAfterDays: 30,
  booksSyncMinutes: 10,
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
  // A folder must be a safe repo-relative path (ADR-0418); anything else falls back to the default.
  const claimTtlHours = Math.max(1, num(o.claimTtlHours, d.claimTtlHours));
  const dir = (v: unknown, def: string): string => {
    const t = typeof v === "string" ? v.trim().replace(/\/+$/, "") : "";
    return t && isSafeRepoDir(t) ? t : def;
  };
  const paused = typeof o.paused === "boolean" ? o.paused : d.paused;
  const pausedBy = paused && ["user", "auto", "projectDeleted", "migration"].includes(String(o.pausedBy)) ? (o.pausedBy as AutonomousPausedBy) : undefined;
  return {
    paused,
    ...(pausedBy ? { pausedBy } : {}),
    ...(paused && typeof o.pausedReason === "string" ? { pausedReason: o.pausedReason.slice(0, 300) } : {}),
    ...(paused && typeof o.pausedAt === "string" ? { pausedAt: o.pausedAt.slice(0, 40) } : {}),
    cronSchedule: str(o.cronSchedule, d.cronSchedule),
    quietHours: str(o.quietHours, d.quietHours),
    maxTicksPerDay: num(o.maxTicksPerDay, d.maxTicksPerDay),
    stopOnConsecutiveFailures: num(o.stopOnConsecutiveFailures, d.stopOnConsecutiveFailures),
    logRetentionDays: num(o.logRetentionDays, d.logRetentionDays),
    maxSessionPct: num(o.maxSessionPct, d.maxSessionPct),
    maxWeeklyPct: num(o.maxWeeklyPct, d.maxWeeklyPct),
    claimTtlHours,
    claimCheckMinutes: Math.max(1, num(o.claimCheckMinutes, d.claimCheckMinutes)),
    maxTaskAttempts: Math.max(1, num(o.maxTaskAttempts, d.maxTaskAttempts)),
    // A run never outlives its own claim, and is never unlimited (ADR-0452).
    runTimeoutMinutes: Math.min(claimTtlHours * 60, Math.max(MIN_RUN_TIMEOUT_MINUTES, num(o.runTimeoutMinutes, d.runTimeoutMinutes))),
    taskSizeHints: (() => {
      const h = (o.taskSizeHints && typeof o.taskSizeHints === "object" ? o.taskSizeHints : {}) as Record<string, unknown>;
      const dh = d.taskSizeHints;
      return {
        sMaxFiles: num(h.sMaxFiles, dh.sMaxFiles),
        sMaxLines: num(h.sMaxLines, dh.sMaxLines),
        mMaxFiles: num(h.mMaxFiles, dh.mMaxFiles),
        mMaxLines: num(h.mMaxLines, dh.mMaxLines),
      };
    })(),
    evidenceDir: dir(o.evidenceDir, d.evidenceDir),
    mockupDir: dir(o.mockupDir, d.mockupDir),
    erDir: dir(o.erDir, d.erDir),
    sequenceDir: dir(o.sequenceDir, d.sequenceDir),
    diagramDir: dir(o.diagramDir, d.diagramDir),
    // Policy-only (ADR-0530): the file's value never counts.
    diagramAutoApprove: d.diagramAutoApprove,
    erAutoApprove: d.erAutoApprove,
    skipPullRequest: d.skipPullRequest,
    autoResolvePrConflicts: d.autoResolvePrConflicts,
    branchCleanup: d.branchCleanup,
    docsPhase: d.docsPhase,
    archiveAfterDays: d.archiveAfterDays,
    booksSyncMinutes: d.booksSyncMinutes,
  };
}

/** Overlay the policy's project-scoped knobs on a worker config (no policy ⇒ unchanged). @adr 0507 */
function withPolicy(cfg: AutonomousConfig): AutonomousConfig {
  const pol = autonomousPolicy();
  return pol ? { ...cfg, ...pol.settings } : cfg;
}

/** The worker file only (no policy overlay) — for writes. Missing/corrupt ⇒ defaults. */
export async function readWorkerAutonomousConfig(profileDir: string): Promise<AutonomousConfig> {
  try {
    return coerce(JSON.parse(await readFile(autonomousConfigPath(profileDir), "utf8")));
  } catch {
    return { ...DEFAULT_AUTONOMOUS_CONFIG };
  }
}

/** Read the **effective** config (async): the worker file ⊕ the server policy. @adr 0507 */
export async function readAutonomousConfig(profileDir: string): Promise<AutonomousConfig> {
  return withPolicy(await readWorkerAutonomousConfig(profileDir));
}

/** Sync effective read (for the coarse `machine.status` running flag / the tick). Missing/corrupt ⇒ defaults. */
export function readAutonomousConfigSync(profileDir: string): AutonomousConfig {
  try {
    return withPolicy(coerce(JSON.parse(readFileSync(autonomousConfigPath(profileDir), "utf8"))));
  } catch {
    return withPolicy({ ...DEFAULT_AUTONOMOUS_CONFIG });
  }
}

/**
 * The config text for the web editor. Once a policy was received the project-scoped keys belong to the
 * project, so the text carries the worker-scoped keys only; before that, the whole file.
 * @adr 0507
 */
export async function readAutonomousConfigText(profileDir: string): Promise<string> {
  const cfg = await readWorkerAutonomousConfig(profileDir);
  if (!autonomousPolicy()) {
    try {
      return await readFile(autonomousConfigPath(profileDir), "utf8");
    } catch {
      return JSON.stringify(DEFAULT_AUTONOMOUS_CONFIG, null, 2) + "\n";
    }
  }
  const worker = Object.fromEntries(Object.entries(cfg).filter(([k]) => !(PROJECT_AUTONOMOUS_KEYS as readonly string[]).includes(k)));
  return JSON.stringify(worker, null, 2) + "\n";
}

/** Serializes every config write (read-modify-write) in this process. */
let writeChain: Promise<unknown> = Promise.resolve();
/** Called after every write (the scheduler re-arms). */
const writeListeners = new Set<() => void>();

/** Subscribe to config writes (the tick scheduler re-arms on each). @adr 0507 */
export function onAutonomousConfigWrite(fn: () => void): () => void {
  writeListeners.add(fn);
  return () => writeListeners.delete(fn);
}

/**
 * Patch the worker config: under a mutex, read the **file** (never the policy overlay), apply only the
 * given keys, coerce, write, then notify (the scheduler re-arms). A concurrent Settings save and an
 * auto-pause therefore never revert each other. Resuming (`paused:false`) clears `pausedBy/Reason/At`.
 * @adr 0507
 */
export function patchAutonomousConfig(profileDir: string, patch: Partial<AutonomousConfig>): Promise<AutonomousConfig> {
  const run = writeChain.then(async () => {
    const cur = await readWorkerAutonomousConfig(profileDir);
    const merged: Record<string, unknown> = { ...cur, ...patch };
    if (patch.paused === false) {
      delete merged.pausedBy;
      delete merged.pausedReason;
      delete merged.pausedAt;
    }
    const cfg = coerce(merged);
    await writeFile(autonomousConfigPath(profileDir), JSON.stringify(cfg, null, 2) + "\n", "utf8");
    for (const fn of [...writeListeners]) {
      try {
        fn();
      } catch {
        /* a listener must not fail the write */
      }
    }
    return cfg;
  });
  writeChain = run.catch(() => undefined);
  return run;
}

/**
 * Persist a Settings save from the web: the worker-scoped keys it carries (a project-scoped key is
 * ignored once a policy exists — the server refuses it anyway). Flipping `paused` records who did it.
 * @adr 0507
 */
export async function writeAutonomousConfig(profileDir: string, raw: unknown): Promise<void> {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const policyOwned = autonomousPolicy() ? new Set<string>(PROJECT_AUTONOMOUS_KEYS) : new Set<string>();
  const patch = Object.fromEntries(
    Object.entries(o).filter(([k]) => !policyOwned.has(k) && k !== "pausedBy" && k !== "pausedReason" && k !== "pausedAt"),
  ) as Partial<AutonomousConfig>;
  const cur = await readWorkerAutonomousConfig(profileDir);
  if (patch.paused === true && !cur.paused) Object.assign(patch, { pausedBy: "user", pausedAt: new Date().toISOString() });
  await patchAutonomousConfig(profileDir, patch);
}

/** Turn the engine off (`paused:true`) with who / why — e.g. when the served project is deleted, so the
 * next project bound to this cli starts stopped. No-op when already paused.
 * @adr 0392 @adr 0507
 */
export async function pauseAutonomous(profileDir: string, by: AutonomousPausedBy = "projectDeleted", reason?: string): Promise<void> {
  const cfg = await readWorkerAutonomousConfig(profileDir);
  if (cfg.paused) return;
  await patchAutonomousConfig(profileDir, { paused: true, pausedBy: by, pausedAt: new Date().toISOString(), ...(reason ? { pausedReason: reason } : {}) });
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
