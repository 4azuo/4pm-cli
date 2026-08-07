/**
 * Per-profile single-instance lock (ADR-0047): a `start.lock` file in the profile
 * directory holds the pid of the running `4pm start`. It stops two clis on the same
 * profile (hence the same MACHINE link) from thrashing each other's ws_token. A stale
 * lock — pid no longer alive, OR whose pid is this very process — is taken over.
 *
 * The "pid is this very process" case is essential for the containerized worker
 * (ADR-0192): the cli runs as pid 1, its profile (with start.lock) lives on a persistent
 * volume, and a non-graceful kill (SIGKILL/OOM/host shutdown) leaves start.lock=1 behind.
 * Every restart is pid 1 again, so a naive `isAlive(1)` (the process probing itself) would
 * wedge the profile forever. A genuinely-distinct live instance always has a different pid,
 * so a lock whose pid equals ours is by definition our own stale lock, never a conflict.
 */
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Path to the per-profile lock file. */
function lockPath(profileDir: string): string {
  return join(profileDir, "start.lock");
}

/** Is a pid currently alive? (signal 0 probes without killing.) */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process; EPERM = alive but owned by someone else (still alive).
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The pid of a DISTINCT live lock holder, or null when free/stale (incl. our own pid). */
export function lockHolder(profileDir: string): number | null {
  try {
    const pid = Number.parseInt(readFileSync(lockPath(profileDir), "utf8").trim(), 10);
    // A lock whose pid is our own is a stale lock left by a previous run of THIS process
    // slot (the container pid-1 restart case), not a competing instance ⇒ take it over.
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && isAlive(pid)) return pid;
  } catch {
    // no lock file / unreadable ⇒ free
  }
  return null;
}

/** Acquire the lock; returns false when another live instance already holds it. */
export function acquireInstanceLock(profileDir: string): boolean {
  if (lockHolder(profileDir) !== null) return false;
  writeFileSync(lockPath(profileDir), String(process.pid), "utf8");
  return true;
}

/** Release the lock, but only when this process owns it. */
export function releaseInstanceLock(profileDir: string): void {
  try {
    const pid = Number.parseInt(readFileSync(lockPath(profileDir), "utf8").trim(), 10);
    if (pid === process.pid) rmSync(lockPath(profileDir), { force: true });
  } catch {
    // already gone
  }
}
