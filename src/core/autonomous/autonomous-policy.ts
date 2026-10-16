/**
 * The autonomous policy this worker received from the server (`ws_token.autonomousPolicy` + the
 * `autonomous.policy` push): the project switch, the server's `allowed` verdict and the project-scoped
 * knobs every worker of the project shares. Persisted in the profile dir (`autonomous.policy.json`,
 * `0600`) so a cli restarted while offline never resumes a project that was paused meanwhile. Also keeps
 * the worker's last tick (`lastCheck`, skips included) and the running cycle's `step` for the
 * `machine.status.autonomous` snapshot.
 * A leaf module (no autonomous imports) — the config reader merges the policy on top of the worker file.
 * Without a policy the worker runs no cycle (it serves no ready project).
 * @adr 0507 @adr 0511 @adr 0529
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AutonomousCheckDetail, AutonomousLastCheck, AutonomousPolicy, AutonomousStep } from "@4pm/dto";
import { readProjectAutonomousSettings } from "@4pm/dto";
import { logger } from "../../common/logger/logger";

/** The policy file name (profile dir). */
const POLICY_FILE = "autonomous.policy.json";
/** The last-check file name (profile dir). */
const LAST_CHECK_FILE = "autonomous.lastcheck.json";

let profileDir: string | null = null;
let policy: AutonomousPolicy | null = null;
let lastCheck: AutonomousLastCheck | null = null;
let step: AutonomousStep | null = null;
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
    lastCheck = JSON.parse(readFileSync(join(dir, LAST_CHECK_FILE), "utf8")) as AutonomousLastCheck;
  } catch {
    lastCheck = null;
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
}

/** The current policy (null = none received yet ⇒ cycles are blocked). */
export function autonomousPolicy(): AutonomousPolicy | null {
  return policy;
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
  if (!profileDir) return;
  try {
    writeFileSync(join(profileDir, LAST_CHECK_FILE), JSON.stringify(lastCheck) + "\n", { mode: 0o600 });
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
  for (const fn of [...stepListeners]) {
    try {
      fn();
    } catch {
      /* a listener must not break the cycle */
    }
  }
}

/** The running cycle's step, or null. @adr 0529 */
export function autonomousStep(): AutonomousStep | null {
  return step;
}

/** Subscribe to step changes (the ws client re-sends its status). @adr 0529 */
export function onAutonomousStep(fn: () => void): () => void {
  stepListeners.add(fn);
  return () => stepListeners.delete(fn);
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
  };
}

/** Reset (tests). */
export function resetAutonomousPolicyForTest(): void {
  profileDir = null;
  policy = null;
  lastCheck = null;
  step = null;
  listeners.clear();
  stepListeners.clear();
}
