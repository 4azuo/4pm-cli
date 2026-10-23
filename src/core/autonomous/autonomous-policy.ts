/**
 * The autonomous policy this worker received from the server (`ws_token.autonomousPolicy` + the
 * `autonomous.policy` push): the project switch, the server's `allowed` verdict and the project-scoped
 * knobs every worker of the project shares. Persisted in the profile dir (`autonomous.policy.json`,
 * `0600`) so a cli restarted while offline never resumes a project that was paused meanwhile. Also keeps
 * the worker's last tick (`lastCheck`, skips included) and the running cycle's `step` for the
 * `machine.status.autonomous` snapshot, and the template marker last read on `origin/<base>` for
 * `machine.status.templateMarker`. The last check and the claim mirror are stamped with the served project and
 * dropped when the worker serves another one.
 * A leaf module (no autonomous imports) — the config reader merges the policy on top of the worker file.
 * Without a policy the worker runs no cycle (it serves no ready project).
 * @adr 0507 @adr 0511 @adr 0529 @adr 0550 @adr 0570
 */
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AutonomousCheckDetail, AutonomousLastCheck, AutonomousPolicy, AutonomousStep } from "@4pm/dto";
import { readProjectAutonomousSettings } from "@4pm/dto";
import { logger } from "../../common/logger/logger";

/** The policy file name (profile dir). */
const POLICY_FILE = "autonomous.policy.json";
/** The last-check file name (profile dir). */
const LAST_CHECK_FILE = "autonomous.lastcheck.json";
/** The claim mirror file name (profile dir) — written by `writeLocalClaim`. */
export const CLAIM_FILE = "autonomous-claim.json";

let profileDir: string | null = null;
let policy: AutonomousPolicy | null = null;
let lastCheck: AutonomousLastCheck | null = null;
let step: AutonomousStep | null = null;
/** The served project (ws_token / project.tokens); undefined = not known yet in this process. @adr 0570 */
let servedProject: string | null | undefined = undefined;
/** The project the in-memory last check belongs to (absent in a file written before ADR-0570). */
let lastCheckProject: string | null | undefined = undefined;
const listeners = new Set<(p: AutonomousPolicy | null) => void>();
const stepListeners = new Set<() => void>();

/** Load the persisted policy + last check for this profile (once, at start). */
export function loadAutonomousPolicy(dir: string): void {
  profileDir = dir;
  try {
    policy = normalize(JSON.parse(readFileSync(join(dir, POLICY_FILE), "utf8")));
  } catch {
    policy = null;
  }
  try {
    const { projectId, ...check } = JSON.parse(readFileSync(join(dir, LAST_CHECK_FILE), "utf8")) as AutonomousLastCheck & { projectId?: string | null };
    lastCheck = check;
    lastCheckProject = projectId;
    // A cycle still marked running did not end before the restart: it no longer runs.
    if (lastCheck.outcome === "running") lastCheck = { at: lastCheck.at, outcome: "skip", reason: "cycle interrupted" };
  } catch {
    lastCheck = null;
    lastCheckProject = undefined;
  }
}

/**
 * Apply a policy from `ws_token` / the push. `undefined` (not in this message) keeps the stored one;
 * `null` clears it (⇒ blocked).
 */
export function setAutonomousPolicy(raw: unknown): void {
  if (raw === undefined) return;
  const next = raw === null ? null : normalize(raw);
  policy = next;
  if (profileDir) {
    try {
      writeFileSync(join(profileDir, POLICY_FILE), JSON.stringify(next) + "\n", { mode: 0o600 });
    } catch (err) {
      logger.warn("autonomous.policy.persistFailed", { error: String(err) });
    }
  }
  logger.info("autonomous.policy", { projectEnabled: next?.projectEnabled ?? null, allowed: next?.allowed ?? null, reason: next?.reason ?? null });
  for (const fn of [...listeners]) {
    try {
      fn(next);
    } catch {
      /* a listener must not break the policy update */
    }
  }
  // `effective` / `allowed` changed — report the snapshot now (ADR-0574).
  notifyAutonomousChanged();
}

/** The current policy (null = none received yet ⇒ cycles are blocked). */
export function autonomousPolicy(): AutonomousPolicy | null {
  return policy;
}

/**
 * Policy reasons that only stop new cycles: a running cycle finishes its work (no AI-run cancel). A
 * required template update waits for the cycle in the repo lock's queue instead.
 * @adr 0550
 */
const SOFT_REASONS: ReadonlySet<string> = new Set(["templateUpdateRequired"]);

/** Should the running cycle be stopped (its AI run cancelled) under the current policy? @adr 0507 @adr 0550 */
export function policyStopsRunningCycle(): boolean {
  const r = policyBlockReason();
  return r !== null && !SOFT_REASONS.has(r);
}

/** Why the policy blocks cycles right now (null = it does not). */
export function policyBlockReason(): string | null {
  // No policy = the server has not assigned this worker a ready project (yet) — never run.
  if (!policy) return "notAssigned";
  if (!policy.allowed) return policy.reason ?? "notAllowed";
  if (!policy.projectEnabled) return "projectDisabled";
  return null;
}

/** Subscribe to policy changes (the running cycle stops when it turns blocking). */
export function onAutonomousPolicy(fn: (p: AutonomousPolicy | null) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Record the outcome of one tick (run / skip / error) for the snapshot; persisted. */
export function recordLastCheck(outcome: AutonomousLastCheck["outcome"], reason: string, detail?: AutonomousCheckDetail): void {
  lastCheck = { at: new Date().toISOString(), outcome, reason: reason.slice(0, 300), ...(detail ? { detail } : {}) };
  lastCheckProject = servedProject;
  if (!profileDir) return;
  try {
    const stamp = servedProject !== undefined ? { projectId: servedProject } : {};
    writeFileSync(join(profileDir, LAST_CHECK_FILE), JSON.stringify({ ...lastCheck, ...stamp }) + "\n", { mode: 0o600 });
  } catch {
    /* best-effort */
  }
}

/**
 * Set what the running cycle does right now (null = no cycle); listeners re-send `machine.status` at once.
 * @adr 0529
 */
export function setAutonomousStep(kind: AutonomousStep["kind"] | null, ids: string[] = []): void {
  const next = kind ? { kind, ids, since: new Date().toISOString() } : null;
  if (step?.kind === next?.kind && (step?.ids ?? []).join(",") === (next?.ids ?? []).join(",")) return;
  step = next;
  notifyAutonomousChanged();
}

/**
 * The worker's autonomous snapshot changed (a step, the policy, its own switch): listeners re-send
 * `machine.status` at once, so the web sees it without waiting for the heartbeat.
 * @adr 0529 @adr 0574
 */
export function notifyAutonomousChanged(): void {
  for (const fn of [...stepListeners]) {
    try {
      fn();
    } catch {
      /* a listener must not break the caller */
    }
  }
}

/** The running cycle's step, or null. @adr 0529 */
export function autonomousStep(): AutonomousStep | null {
  return step;
}

/** Subscribe to snapshot changes — steps, policy, the worker switch (the ws client re-sends its status). @adr 0529 */
export function onAutonomousStep(fn: () => void): () => void {
  stepListeners.add(fn);
  return () => stepListeners.delete(fn);
}

let marker: { root: string; version: string | null } | null = null;

/**
 * Record the template marker read on `origin/<base>` of `root` (`version` null = no marker); a change
 * re-sends `machine.status` at once (the server may pause / resume autonomous).
 * @adr 0550
 */
export function setTemplateMarker(root: string, version: string | null): void {
  if (marker?.root === root && marker.version === version) return;
  marker = { root, version };
  logger.info("autonomous.templateMarker", { version });
  for (const fn of [...stepListeners]) {
    try {
      fn();
    } catch {
      /* a listener must not break the reader */
    }
  }
}

/** The template marker last read for `root`, or null when not read yet. @adr 0550 */
export function templateMarkerOf(root: string): { version: string | null } | null {
  return marker?.root === root ? { version: marker.version } : null;
}

/**
 * Apply the served project (connect: `ws_token`; live: a `project.tokens` switch). The last check and the claim
 * mirror stamped with another project are dropped, so the snapshot never reports another project's Last check or
 * Task — also after a move made while this worker was offline. A file written before the stamp existed is adopted
 * as the served project's (an upgrade must not orphan a live claim). Returns whether anything was dropped.
 * @adr 0570
 */
export function setAutonomousServedProject(projectId: string | null): boolean {
  const changed = servedProject !== undefined && servedProject !== projectId;
  servedProject = projectId;
  let dropped = false;
  if (lastCheck && (changed || (lastCheckProject !== undefined && lastCheckProject !== projectId))) {
    lastCheck = null;
    dropped = true;
    if (profileDir) rmSync(join(profileDir, LAST_CHECK_FILE), { force: true });
  }
  lastCheckProject = lastCheck ? projectId : undefined;
  if (changed && step) {
    step = null;
    dropped = true;
  }
  if (profileDir) {
    try {
      const claim = JSON.parse(readFileSync(join(profileDir, CLAIM_FILE), "utf8")) as { projectId?: string | null };
      const stamp = Object.prototype.hasOwnProperty.call(claim, "projectId") ? claim.projectId : undefined;
      if (changed || (stamp !== undefined && stamp !== projectId)) {
        rmSync(join(profileDir, CLAIM_FILE), { force: true });
        dropped = true;
      }
    } catch {
      /* no claim */
    }
  }
  if (dropped) logger.info("autonomous.projectStateCleared", { projectId });
  return dropped;
}

/** The served project the autonomous state is stamped with (undefined = not known yet). @adr 0570 */
export function autonomousServedProject(): string | null | undefined {
  return servedProject;
}

/**
 * Drop the project-scoped autonomous state now (the worker leaves its project): the last check, the step and the
 * claim mirror.
 * @adr 0570
 */
export function clearAutonomousProjectState(): void {
  lastCheck = null;
  lastCheckProject = undefined;
  step = null;
  if (!profileDir) return;
  rmSync(join(profileDir, LAST_CHECK_FILE), { force: true });
  rmSync(join(profileDir, CLAIM_FILE), { force: true });
}

/** The last tick, or null. */
export function lastAutonomousCheck(): AutonomousLastCheck | null {
  return lastCheck;
}

/** Coerce a received policy (settings are re-validated with the shared reader). */
function normalize(raw: unknown): AutonomousPolicy | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  return {
    projectEnabled: o.projectEnabled === true,
    allowed: o.allowed === true,
    ...(typeof o.reason === "string" ? { reason: o.reason as AutonomousPolicy["reason"] } : {}),
    settings: readProjectAutonomousSettings(o.settings),
    // The project's asset generators (ADR-0615).
    ...(Array.isArray(o.assetProviders) ? { assetProviders: o.assetProviders.filter((p): p is string => typeof p === "string") } : {}),
  };
}

/** Reset (tests). */
export function resetAutonomousPolicyForTest(): void {
  profileDir = null;
  policy = null;
  lastCheck = null;
  lastCheckProject = undefined;
  servedProject = undefined;
  step = null;
  listeners.clear();
  stepListeners.clear();
}
