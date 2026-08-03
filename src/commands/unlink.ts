/**
 * `4pm unlink` command — revoke the server-side link (machine-0006b) then delete the
 * profile's local `.cre`. Server unreachable ⇒ still delete locally + warn (ADR-0014).
 */
import { rmSync } from "node:fs";
import { readCredential } from "../core/credential";
import { clearDefaultProfileIf } from "../config/profile";
import { selfUnlink } from "../services/api";

/**
 * Revoke the link on the server (best-effort), then delete the local credential.
 */
export async function runUnlink(profileDir: string, profileName: string): Promise<void> {
  const cred = readCredential(profileDir, profileName);
  if (!cred) {
    console.log(`Profile "${profileName}" has no link yet.`);
    return;
  }
  // Tell the server to revoke the link (close WS + soft-delete link/physic). Best-effort:
  // if the server is unreachable the cli still removes its local .cre.
  try {
    await selfUnlink(cred.serverUrl, cred.hashcode3);
    console.log("✔ Revoked the server-side link.");
  } catch (err) {
    console.log(
      `⚠ Could not reach the server to revoke — revoke it at web /machines. (${(err as Error).message})`,
    );
  }
  // MEMO#10 — delete the whole profile directory (its `.cre` + the physic project
  // folder scaffolded inside it on link).
  rmSync(profileDir, { recursive: true, force: true });
  // If this was the default profile, drop the pointer so it falls back cleanly (ADR-0047).
  clearDefaultProfileIf(profileName);
  console.log("✔ Deleted the profile and its physic project folder.");
}
