/**
 * Re-exec into the freshly updated cli and wait for it. The caller must already have released
 * everything a fresh `4pm start` claims (instance lock, control / git-token sockets, WS session).
 * While waiting, stop signals are forwarded to the child — `docker-init` signals only its direct
 * child (this process), so without forwarding the real cli would be SIGKILLed with the container.
 * @adr 0473 @adr 0015
 */
import { spawn } from "node:child_process";
import { logger } from "../common/logger/logger";
import { reexecArgv } from "./update";

/** Signals forwarded to the child. SIGINT only off-TTY: on a TTY the terminal already signals the whole group. */
export function forwardedSignals(stdinIsTty: boolean): NodeJS.Signals[] {
  return stdinIsTty ? ["SIGTERM", "SIGHUP"] : ["SIGTERM", "SIGHUP", "SIGINT"];
}

/**
 * Spawn the updated binary with the same args (FOURPM_NO_UPDATE=1 skips its redundant startup
 * check), forward stop signals, and exit with the child's code once it ends.
 */
export function reexecUpdated(): Promise<never> {
  const child = spawn(process.execPath, reexecArgv(), {
    stdio: "inherit",
    env: { ...process.env, FOURPM_NO_UPDATE: "1" },
  });
  let forwarded = false;
  for (const signal of forwardedSignals(Boolean(process.stdin.isTTY))) {
    process.on(signal, () => {
      forwarded = true;
      child.kill(signal);
    });
  }
  return new Promise<never>(() => {
    child.on("error", (err) => {
      logger.error("update.reexec.error", { error: String(err) });
      process.exit(1);
    });
    // Killed by a signal we forwarded ⇒ a requested stop (0); any other signal death ⇒ failure.
    child.on("exit", (code, signal) => process.exit(code ?? (signal && !forwarded ? 1 : 0)));
  });
}
