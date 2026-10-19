/**
 * Remember which AI credential (provider + CLAUDE_CONFIG_DIR / CODEX_HOME dir) last worked, so the next
 * prompt tries it first, and the operator's pin. Persisted in the profile dir.
 * Best-effort — never breaks a run.
 * @adr 0057
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The state map (reserved keys below → credential keys). */
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

/** Reserved key for the working credential. @adr 0182 */
const WORKING_CREDENTIAL_KEY = "__credential__";

/** The last known working credential key, or null. @adr 0182 */
export function getWorkingCredential(profileDir: string): string | null {
  return readState(profileDir)[WORKING_CREDENTIAL_KEY] ?? null;
}

/** The dir of the working credential when it is a `provider` one (`<provider>::<dir>`), else null. */
export function getWorkingDir(profileDir: string, provider: string): string | null {
  const key = getWorkingCredential(profileDir);
  return key?.startsWith(`${provider}::`) ? key.slice(provider.length + 2) : null;
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

/**
 * Reserved key for the operator's MANUAL profile pin — kept in the same state file
 * alongside `__credential__`. Unlike `__credential__` (auto-remembered by failover), the pin is set
 * explicitly via `/ai-profile use` and is honoured as the working-first hint on EVERY prompt,
 * overriding `aiFailoverMode` (remember/priority). Failover to the other profiles stays as a backup;
 * the pin persists until the operator switches again or clears it (`/ai-profile reset`).
 * @adr 0250
 */
const PINNED_CREDENTIAL_KEY = "__pinned__";

/** The operator-pinned credential key (manual override), or null when none is pinned. @adr 0250 */
export function getPinnedCredential(profileDir: string): string | null {
  return readState(profileDir)[PINNED_CREDENTIAL_KEY] ?? null;
}

/** Persist the operator-pinned credential key (best-effort). */
export function setPinnedCredential(profileDir: string, key: string): void {
  const state = readState(profileDir);
  if (state[PINNED_CREDENTIAL_KEY] === key) return;
  state[PINNED_CREDENTIAL_KEY] = key;
  try {
    writeFileSync(statePath(profileDir), JSON.stringify(state, null, 2), "utf8");
  } catch {
    // Best-effort.
  }
}

/** Clear the operator-pinned credential — return to automatic failover (`/ai-profile reset`). */
export function clearPinnedCredential(profileDir: string): void {
  const state = readState(profileDir);
  if (!(PINNED_CREDENTIAL_KEY in state)) return;
  delete state[PINNED_CREDENTIAL_KEY];
  try {
    writeFileSync(statePath(profileDir), JSON.stringify(state, null, 2), "utf8");
  } catch {
    // Best-effort.
  }
}
