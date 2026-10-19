/**
 * `4pm unlink` command — revoke the server-side link then delete everything of the profile locally: its
 * profile dir (`.cre`, config, logs), its workspace (the physic project) and its run dir. Server unreachable ⇒
 * still delete locally + warn.
 * @api machine-0006b @adr 0014 @adr 0487
 */
import { rmSync } from "node:fs";
import { readCredential } from "../core/profile/credential";
import { clearDefaultProfileIf, readProfileConfig, workspaceRoot } from "../config/profile";
import { selfUnlink } from "../services/api";
import { agentRunDirPath, removeSharedTree } from "../utils/agent-user";
import { initI18n, t } from "../i18n";

/**
 * Delete one local folder of the profile, warning (not failing) when part of it cannot be removed.
 */
function removeLocal(dir: string, remove: (dir: string) => void): void {
  try {
    remove(dir);
  } catch (err) {
    console.log(t("unlink.leftBehind", { path: dir, message: (err as Error).message }));
  }
}

/**
 * Revoke the link on the server (best-effort), then delete the profile, its workspace and its run dir.
 */
export async function runUnlink(profileDir: string, profileName: string): Promise<void> {
  // Localize per the worker config (ADR-0276).
  initI18n(readProfileConfig(profileDir).locale);
  const cred = readCredential(profileDir);
  if (!cred) {
    console.log(t("unlink.noLink", { profile: profileName }));
    return;
  }
  // Tell the server to revoke the link (close WS + soft-delete link/physic). Best-effort:
  // if the server is unreachable the cli still removes its local .cre.
  try {
    await selfUnlink(cred.serverUrl, cred.hashcode3);
    console.log(t("unlink.revoked"));
  } catch (err) {
    console.log(t("unlink.revokeFailed", { message: (err as Error).message }));
  }
  // The physic project lives in the profile's workspace, outside the profile dir: remove it as the agent
  // first, then as the cli. A custom SCAFFOLD_ROOT is shared, never per-profile — leave it alone.
  if (!process.env.SCAFFOLD_ROOT) removeLocal(workspaceRoot(profileDir), removeSharedTree);
  const rmTree = (dir: string): void => rmSync(dir, { recursive: true, force: true });
  removeLocal(agentRunDirPath(profileDir), rmTree);
  // MEMO#10 — the profile directory itself (its `.cre`, config, logs).
  removeLocal(profileDir, rmTree);
  // If this was the default profile, drop the pointer so it falls back cleanly (ADR-0047).
  clearDefaultProfileIf(profileName);
  console.log(t("unlink.deleted"));
}
