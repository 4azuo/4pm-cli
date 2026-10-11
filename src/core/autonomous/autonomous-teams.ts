/**
 * The teams this cli serves in its project: pushed by the server on `ws_token.servedTeams` and
 * live on `project.tokens`, persisted in the profile dir so a tick before the next connect still honours
 * it. `null` = all teams (no routing restriction). A team-restricted worker takes in and claims only rows of
 * its teams; untagged rows are left to the "all teams" workers.
 * @adr 0450
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** File (in the profile dir) holding the last served-teams push. */
const FILE = "served-teams.json";

/** Loaded value; `undefined` = not loaded yet. */
let served: string[] | null | undefined;

/** Load the persisted value once (missing / unreadable ⇒ all teams). */
function load(profileDir: string): string[] | null {
  if (served !== undefined) return served;
  try {
    const raw = JSON.parse(readFileSync(join(profileDir, FILE), "utf8")) as { teams?: unknown };
    served = Array.isArray(raw.teams) ? raw.teams.filter((t): t is string => typeof t === "string") : null;
  } catch {
    served = null;
  }
  return served;
}

/** Apply a push: `undefined` (an older server) keeps the last value; `null` = all teams. */
export function setServedTeams(teams: string[] | null | undefined, profileDir: string): void {
  if (teams === undefined) return;
  served = teams;
  try {
    writeFileSync(join(profileDir, FILE), JSON.stringify({ teams }, null, 2), { mode: 0o600 });
  } catch {
    // in-memory value still applies for this process
  }
}

/** The served team codes, or null for all teams. */
export function servedTeams(profileDir: string): string[] | null {
  return load(profileDir);
}

/** True when this worker takes rows of `team` ("" = untagged ⇒ only an all-teams worker). */
export function servesTeam(profileDir: string, team: string | undefined): boolean {
  const s = load(profileDir);
  if (s === null) return true;
  return Boolean(team) && s.includes(team!);
}

/** Test hook: reset the in-memory value. */
export function resetServedTeamsForTest(): void {
  served = undefined;
}
