/**
 * config.json sync (ADR-0141) — serves the machine-user Settings tab's read/edit of the
 * paired profile's config.json over WS (machine-0025/0026). The web sends raw text; the cli
 * validates it as JSON, preserves the server-managed fields (physicPath + the ws_token runtime
 * mirror), and writes it wholesale so removed keys are actually dropped.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  defaultProfileConfig,
  overwriteProfileConfig,
  readProfileConfig,
  type ProfileConfig,
} from "../config/profile";

/**
 * Fields the server assigns/refreshes per `ws_token` (ADR-0081) — never overwritten from the
 * web: an edit keeps their current on-disk value so it can't fight the server's runtime knobs.
 */
const SERVER_MANAGED_KEYS = ["physicPath", "sessionSwitchPct", "perPromptTokenLimit"] as const;

/** Read the profile's config.json as text (canonical defaults when the file is absent). */
export function readConfigText(profileDir: string): string {
  const path = join(profileDir, "config.json");
  if (existsSync(path)) {
    try {
      return readFileSync(path, "utf8");
    } catch {
      // Unreadable ⇒ fall through to the defaults so the editor still opens.
    }
  }
  return JSON.stringify(defaultProfileConfig(), null, 2);
}

/** Validate + apply edited config.json text; server-managed fields keep their on-disk value. */
export function applyConfigText(profileDir: string, text: string): { ok: boolean; error?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `Invalid JSON: ${(err as Error).message}` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "config.json must be a JSON object." };
  }
  const next = { ...(parsed as Record<string, unknown>) } as ProfileConfig;
  const current = readProfileConfig(profileDir);
  for (const key of SERVER_MANAGED_KEYS) {
    if (current[key] !== undefined) (next as Record<string, unknown>)[key] = current[key];
    else delete (next as Record<string, unknown>)[key];
  }
  overwriteProfileConfig(profileDir, next);
  return { ok: true };
}
