/**
 * Manage the `.cre` credential file (machine-0001/0002, ADR-0014): holds hashcode (3)
 * + metadata; stored in the profile directory ~/.4pm/profiles/<name>/, chmod 600;
 * deleted on logout/LINK_REVOKED/HASHCODE_EXPIRED/unlink.
 */
import {
  chmodSync,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PROFILE } from "../config/profile";

/** Contents of the `.cre` file — does not hold ws_token/session key. */
export interface Credential {
  serverUrl: string;
  hashcode3: string;
  scope: string;
  pairedAt: string;
  /**
   * WebSocket base URL for the gateway (ADR-0131 phase 3): healed from the ws_token
   * response. When set, the cli connects to `<wsUrl>/ws` (@4pm/cli-server) instead of
   * deriving the URL from `serverUrl`. Absent ⇒ old behaviour (server gateway).
   */
  wsUrl?: string;
}

/** Legacy `.cre` file path (before ADR-0014 — 1 cli per machine). */
const LEGACY_CRE_PATH = join(homedir(), ".config", "4pm", "credential.cre");

/**
 * Path to the `.cre` file inside the profile directory.
 */
function credentialPath(profileDir: string): string {
  return join(profileDir, "credential.cre");
}

/**
 * Read the credential — null if not paired (Unlinked state).
 * If the `default` profile has no `.cre`, auto-migrate from the legacy path (if any).
 */
export function readCredential(
  profileDir: string,
  profileName: string,
): Credential | null {
  const path = credentialPath(profileDir);
  if (!existsSync(path)) {
    if (profileName === DEFAULT_PROFILE && existsSync(LEGACY_CRE_PATH)) {
      try {
        const legacy = JSON.parse(
          readFileSync(LEGACY_CRE_PATH, "utf8"),
        ) as Credential;
        writeCredential(profileDir, legacy);
        rmSync(LEGACY_CRE_PATH, { force: true });
        return legacy;
      } catch {
        return null;
      }
    }
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Credential;
  } catch {
    return null;
  }
}

/**
 * Write the credential (the profile directory already exists, chmod 600).
 */
export function writeCredential(
  profileDir: string,
  credential: Credential,
): void {
  const path = credentialPath(profileDir);
  writeFileSync(path, JSON.stringify(credential, null, 2), "utf8");
  chmodSync(path, 0o600);
}

/**
 * Delete the credential (logout / revoke).
 */
export function deleteCredential(profileDir: string): void {
  rmSync(credentialPath(profileDir), { force: true });
}
