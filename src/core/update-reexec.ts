/**
 * Start the freshly updated cli. The caller must already have released everything a fresh `4pm start`
 * claims (the lifecycle stopped every service, the lock is released, the WS is closed). With
 * `process.execve` (Node ≥ 23.11 on Unix) the process image is **replaced** in place — same pid, so
 * `docker-init` signals the new cli directly and no parent process is left behind. Without it, the
 * old process spawns the child and only forwards stop signals — `docker-init` signals only its direct
 * child (this process), so without forwarding the real cli would be SIGKILLed with the container.
 * @adr 0473 @adr 0015 @adr 0505
 */
import { spawn } from "node:child_process";
import { logger } from "../common/logger/logger";
import { reexecArgv } from "./update";

/** Signals forwarded to the child. SIGINT only off-TTY: on a TTY the terminal already signals the whole group. */
export function forwardedSignals(stdinIsTty: boolean): NodeJS.Signals[] {
  return stdinIsTty ? ["SIGTERM", "SIGHUP"] : ["SIGTERM", "SIGHUP", "SIGINT"];
}

/** `process.execve`, when this Node provides it (Node ≥ 23.11, Unix). */
type ExecveFn = (file: string, args?: string[], env?: NodeJS.ProcessEnv) => never;

/** The runtime's `execve`, or null (Windows / older Node). */
function execveOf(): ExecveFn | null {
  const fn = (process as unknown as { execve?: ExecveFn }).execve;
  return typeof fn === "function" && process.platform !== "win32" ? fn.bind(process) : null;
}

/**
 * Run the updated binary with the same args (FOURPM_NO_UPDATE=1 skips its redundant startup check):
 * exec in place when possible, else spawn it, forward stop signals and exit with the child's code.
 * `preferExec: false` forces the spawn fallback (tests).
 */
export function reexecUpdated(opts: { preferExec?: boolean } = {}): Promise<never> {
  const env = { ...process.env, FOURPM_NO_UPDATE: "1" };
  const execve = opts.preferExec === false ? null : execveOf();
  if (execve) {
    logger.info("update.exec", { pid: process.pid });
    try {
      // argv[0] is part of `args` for execve.
      execve(process.execPath, [process.execPath, ...reexecArgv()], env);
    } catch (err) {
      logger.warn("update.exec.failed", { error: String(err) });
      // fall through to the spawn path
    }
  }
  return spawnAndForward(env);
}

/** The fallback: spawn the child, forward stop signals, exit with its code. */
function spawnAndForward(env: NodeJS.ProcessEnv): Promise<never> {
  const child = spawn(process.execPath, reexecArgv(), {
    stdio: "inherit",
    env,
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
