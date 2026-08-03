/**
 * Persistent input history for the TUI (ADR-0057): the prompts/slash commands the
 * operator submits are saved to the profile dir so Up/Down recall works across
 * sessions. Best-effort — history must never break the cli.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Keep at most this many recent inputs. */
const MAX_HISTORY = 200;

/** Path to the history file inside the profile directory. */
function historyPath(profileDir: string): string {
  return join(profileDir, "input-history.json");
}

/** Load the saved input history (oldest → newest); [] when missing/unreadable. */
export function loadInputHistory(profileDir: string): string[] {
  const path = historyPath(profileDir);
  if (!existsSync(path)) return [];
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return Array.isArray(data) ? (data.filter((x) => typeof x === "string") as string[]) : [];
  } catch {
    return [];
  }
}

/**
 * Append one input and persist (capped, de-duping an immediate repeat). Returns the
 * updated list.
 */
export function appendInputHistory(profileDir: string, line: string, current: string[]): string[] {
  const trimmed = line.trim();
  if (!trimmed || current[current.length - 1] === trimmed) return current;
  const next = [...current, trimmed].slice(-MAX_HISTORY);
  try {
    writeFileSync(historyPath(profileDir), JSON.stringify(next), "utf8");
  } catch {
    // Best-effort — never break input on a write error.
  }
  return next;
}
