/**
 * Remember which AI-CLI profile (CLAUDE_CONFIG_DIR / CODEX_HOME dir) last worked, per
 * command, so the next prompt tries it first (ADR-0057). Persisted in the profile dir.
 * Best-effort — never breaks a run.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Map of aiCli command → last working profile dir. */
type ProfileState = Record<string, string>;

/** Path to the state file inside the profile directory. */
function statePath(profileDir: string): string {
  return join(profileDir, "ai-profiles.json");
}

/** Read the whole state map (empty on missing/unreadable). */
function readState(profileDir: string): ProfileState {
  const path = statePath(profileDir);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ProfileState;
  } catch {
    return {};
  }
}

/** The last known working profile dir for a command, or null. */
export function getWorkingProfile(profileDir: string, cmd: string): string | null {
  return readState(profileDir)[cmd] ?? null;
}

/** Persist the working profile dir for a command (best-effort). */
export function setWorkingProfile(profileDir: string, cmd: string, dir: string): void {
  const state = readState(profileDir);
  if (state[cmd] === dir) return;
  state[cmd] = dir;
  try {
    writeFileSync(statePath(profileDir), JSON.stringify(state, null, 2), "utf8");
  } catch {
    // Best-effort.
  }
}

/**
 * Reserved key for the unified working credential (ADR-0182) — kept in the same state file
 * alongside the legacy per-cmd dirs; the `::` in a credential key never collides with a cmd name.
 */
const WORKING_CREDENTIAL_KEY = "__credential__";

/** The last known working credential key (unified mixed list — ADR-0182), or null. */
export function getWorkingCredential(profileDir: string): string | null {
  return readState(profileDir)[WORKING_CREDENTIAL_KEY] ?? null;
}

/** Persist the working credential key (best-effort). */
export function setWorkingCredential(profileDir: string, key: string): void {
  const state = readState(profileDir);
  if (state[WORKING_CREDENTIAL_KEY] === key) return;
  state[WORKING_CREDENTIAL_KEY] = key;
  try {
    writeFileSync(statePath(profileDir), JSON.stringify(state, null, 2), "utf8");
  } catch {
    // Best-effort.
  }
}
