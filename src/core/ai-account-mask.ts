/**
 * AI account label masking on platform-pool (rented) workers (ADR-0395): applies the server's
 * `maskAiAccounts` flag (from `ws_token`, mirrored in `config.json`) to the label helpers in
 * `utils/ai-cli.ts`, and resolves the header's active-profile label so it can be re-rendered when the
 * flag flips mid-session.
 */
import { readProfileConfig, type ProfileConfig } from "../config/profile";
import { isAiAccountMaskOn, profileDisplayLabel, profileLabels, setAiAccountMask } from "../utils/ai-cli";
import { getWorkingProfile } from "./ai-profile-state";

/**
 * Turn masking on/off for this profile; returns true when the state changed (so the caller can
 * refresh labels already on screen). The `#N` numbering reads the live config at label time.
 */
export function applyAiAccountMask(profileDir: string, on: boolean): boolean {
  const changed = isAiAccountMaskOn() !== on;
  setAiAccountMask(on ? () => readProfileConfig(profileDir) : null);
  return changed;
}

/**
 * The header's seed active AI profile label (ADR-0057): the last working profile, else the first
 * configured candidate; null when none is configured. Masked while masking is on.
 */
export function activeProfileLabel(profileDir: string, config: ProfileConfig): string | null {
  const workingDir = getWorkingProfile(profileDir, config.aiCli || "claude");
  return workingDir ? profileDisplayLabel(workingDir) : (profileLabels(config)[0] ?? null);
}
