/**
 * Manage the `.cre` credential file (machine-0001/0002): holds hashcode (3)
 * + metadata; stored in the profile directory ~/.4pm/profiles/<name>/, chmod 600;
 * deleted on logout/LINK_REVOKED/HASHCODE_EXPIRED/unlink.
 * @adr 0014
 */
import {
  chmodSync,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/** Contents of the `.cre` file — does not hold ws_token/session key. */
export interface Credential {
  serverUrl: string;
  hashcode3: string;
  scope: string;
  pairedAt: string;
  /**
   * WebSocket base URL for the gateway: healed from the ws_token
   * response. When set, the cli connects to `<wsUrl>/ws` (@4pm/cli-server) instead of
   * deriving the URL from `serverUrl` (absent ⇒ derived from `serverUrl`).
   * @adr 0131 phase 3
   */
  wsUrl?: string;
}

/**
 * Path to the `.cre` file inside the profile directory.
 */
function credentialPath(profileDir: string): string {
  return join(profileDir, "credential.cre");
}

/**
 * Read the credential — null if not paired (Unlinked state).
 */
export function readCredential(profileDir: string): Credential | null {
  const path = credentialPath(profileDir);
  if (!existsSync(path)) return null;
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
