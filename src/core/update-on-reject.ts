/**
 * Self-update after the cli-server rejects this version (`CLI_VERSION_UNSUPPORTED`). A rejected daemon
 * has no session, so neither an operator push nor the daily tick can reach it: it installs the latest
 * release itself (the one signed path, mandatory — `autoUpdate:false` doesn't apply) once running work is
 * done. The WS client turns the outcome into a restart, a retry later, or a stop (update-locked image).
 * @adr 0547 @adr 0432
 */
import { logger } from "../common/logger/logger";
import { cliUpdateLocked, updateToLatest } from "./update";
import { work } from "./session/work-tracker";

/** What the WS client does after a rejected version. */
export type RejectUpdateOutcome =
  | { action: "updated"; version: string }
  | { action: "retry"; reason: string }
  | { action: "locked" };

/**
 * Wait for idle (≤ `waitIdleMs`), then install the server's latest release. `updated` ⇒ restart into it;
 * `retry` ⇒ reconnect later (busy, failed, no newer release, server unreachable); `locked` ⇒ the image
 * can't update itself.
 */
export async function updateAfterVersionReject(serverUrl: string, waitIdleMs: number): Promise<RejectUpdateOutcome> {
  if (cliUpdateLocked()) return { action: "locked" };
  if (!(await work.waitIdle(waitIdleMs))) {
    return { action: "retry", reason: `work still running (${work.leases().map((l) => l.label).join(", ")})` };
  }
  const lease = work.begin("cliUpdate", "cli-update");
  try {
    const result = await updateToLatest(serverUrl);
    logger.info("update.reject.result", { action: result.action });
    switch (result.action) {
      case "updated":
        return { action: "updated", version: result.version };
      case "locked":
        return { action: "locked" };
      case "failed":
        return { action: "retry", reason: result.error };
      case "already-latest":
        return { action: "retry", reason: `no newer release than ${result.version}` };
      case "dev-build":
        return { action: "retry", reason: "dev build — update by rebuilding" };
    }
  } catch (err) {
    return { action: "retry", reason: String(err) };
  } finally {
    lease.end();
  }
}
