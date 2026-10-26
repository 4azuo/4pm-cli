/**
 * Per-profile self-update state (`<profile>/update-state.json`, in the persistent volume): the boot trial
 * written before re-executing into an update, the versions that failed to load or start (skipped for 24 h),
 * and a failure report waiting for the next session. Versions are stored canonical (the caller passes
 * `canonVersion` output). A profile is registered once per process; without one every call is a no-op.
 * @adr 0644
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../common/logger/logger";

/** How long a bad version is skipped before one new attempt is allowed. */
export const BAD_VERSION_TTL_MS = 24 * 60 * 60 * 1000;
/** How many bad versions are kept. */
const MAX_BAD_VERSIONS = 5;

/** An update that re-executed into a new version and has not proved healthy yet. */
export interface UpdateTrial {
  from: string;
  to: string;
  at: string;
}

/** A version that failed to load or start on this worker. */
export interface BadVersion {
  version: string;
  reason: string;
  at: string;
}

/** A failure to report over `cli.update-result` once a session is up. */
export interface PendingUpdateReport {
  message: string;
  fromVersion: string;
  toVersion: string;
  at: string;
}

/** The whole file. */
export interface UpdateState {
  trial?: UpdateTrial;
  bad?: BadVersion[];
  pendingReport?: PendingUpdateReport;
}

/** The profile dir whose state this process reads and writes. */
let stateDir: string | null = null;

/** Register the profile this process updates for (`4pm start` / `4pm update`). */
export function useUpdateStateDir(profileDir: string): void {
  stateDir = profileDir;
}

/** Path of the state file, or null when no profile is registered. */
function statePath(): string | null {
  return stateDir ? join(stateDir, "update-state.json") : null;
}

/** Read the state; a missing or unreadable file is an empty state. */
export function readUpdateState(): UpdateState {
  const path = statePath();
  if (!path || !existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as UpdateState) : {};
  } catch {
    return {};
  }
}

/** Apply `change` to the state and write it atomically (temp file + rename). Best-effort. */
function mutateUpdateState(change: (state: UpdateState) => void): void {
  const path = statePath();
  if (!path) return;
  const state = readUpdateState();
  change(state);
  try {
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
    renameSync(tmp, path);
  } catch (err) {
    logger.warn("update.state.writeFailed", { error: String(err) });
  }
}

/** Record the boot trial right before re-executing into `to`. */
export function beginUpdateTrial(from: string, to: string): void {
  mutateUpdateState((state) => {
    state.trial = { from, to, at: new Date().toISOString() };
  });
}

/** Clear the boot trial when it is for `version` (the running cli proved healthy). */
export function clearUpdateTrial(version: string): void {
  if (readUpdateState().trial?.to !== version) return;
  mutateUpdateState((state) => {
    delete state.trial;
  });
  logger.info("update.trial.healthy", { version });
}

/** Drop the boot trial without judging it (it was for a version this boot does not care about). */
export function dropUpdateTrial(): void {
  if (!readUpdateState().trial) return;
  mutateUpdateState((state) => {
    delete state.trial;
  });
}

/** Mark `version` bad with its reason (newest first, bounded). */
export function markBadVersion(version: string, reason: string): void {
  mutateUpdateState((state) => {
    const rest = (state.bad ?? []).filter((b) => b.version !== version);
    state.bad = [{ version, reason, at: new Date().toISOString() }, ...rest].slice(0, MAX_BAD_VERSIONS);
  });
  logger.warn("update.badVersion", { version, reason });
}

/** The still-active bad mark of `version` (younger than the TTL), or null. */
export function activeBadVersion(version: string, now = Date.now()): BadVersion | null {
  const hit = (readUpdateState().bad ?? []).find((b) => b.version === version);
  if (!hit) return null;
  const at = Date.parse(hit.at);
  return Number.isFinite(at) && now - at < BAD_VERSION_TTL_MS ? hit : null;
}

/** Queue a failure report for the next session (replaces an older one). */
export function queueUpdateReport(report: PendingUpdateReport): void {
  mutateUpdateState((state) => {
    state.pendingReport = report;
  });
}

/** Take (read and clear) the queued failure report. */
export function takeUpdateReport(): PendingUpdateReport | null {
  const report = readUpdateState().pendingReport ?? null;
  if (report) {
    mutateUpdateState((state) => {
      delete state.pendingReport;
    });
  }
  return report;
}
