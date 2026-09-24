/**
 * `4pm attach` (ADR-0192 §2) — open the interactive TUI against a **running** headless daemon
 * (`4pm start`) over its per-profile control socket, instead of starting a second WS session. The
 * daemon streams its SessionBus (transcript/header) into a local bus that drives the same Ink TUI;
 * the operator's input is forwarded back. One terminal can attach to any of N daemons.
 */
import { join } from "node:path";
import { readCredential } from "../core/credential";
import { fetchWhoami } from "../services/api";
import { SessionBus } from "../core/session-bus";
import { connectControl } from "../core/control-client";
import { CONTROL_SOCKET_FILE } from "../core/control-protocol";
import { readControlToken } from "../core/control-token";
import { runTui } from "../ui/run-tui";
import type { SessionInfo } from "../ui/session-info";
import { readProfileConfig } from "../config/profile";
import { initI18n, t } from "../i18n";

/**
 * Attach the TUI to the daemon serving `profileName`. Requires a TTY (the TUI); a non-running
 * daemon (no/closed socket) exits with a hint to `4pm start` it first.
 */
export async function runAttach(profileDir: string, profileName: string): Promise<void> {
  // Localize the cli's operator-facing messages per the worker config (ADR-0276).
  initI18n(readProfileConfig(profileDir).locale);
  if (!process.stdout.isTTY) {
    console.error(t("attach.needsTty"));
    process.exitCode = 1;
    return;
  }
  const socketPath = join(profileDir, CONTROL_SOCKET_FILE);
  const bus = new SessionBus();

  let conn;
  try {
    conn = await connectControl(socketPath, bus, readControlToken(profileDir));
  } catch {
    console.error(t("attach.noDaemon", { profile: profileName }));
    process.exitCode = 1;
    return;
  }

  // whoami works locally — the attach host shares the profile's credential (hashcode 3).
  const credential = readCredential(profileDir, profileName);
  const info: SessionInfo = {
    version: conn.info.version,
    scope: conn.info.scope,
    profile: conn.info.profile,
    profileDir,
    serverUrl: conn.info.serverUrl,
    physicPath: conn.info.physicPath,
    aiCli: conn.info.aiCli,
    whoami: () =>
      credential
        ? fetchWhoami(credential.serverUrl, credential.hashcode3).catch(() => null)
        : Promise.resolve(null),
  };

  bus.log(t("attach.attached", { profile: profileName }));
  try {
    await runTui(bus, info);
  } finally {
    conn.close();
  }
}
