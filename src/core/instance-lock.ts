/**
 * Per-profile single-instance lock (ADR-0047): a `start.lock` file in the profile
 * directory holds the pid of the running `4pm start`. It stops two clis on the same
 * profile (hence the same MACHINE link) from thrashing each other's ws_token. A stale
 * lock — pid no longer alive — is taken over.
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

/** The pid of a live lock holder, or null when free/stale. */
export function lockHolder(profileDir: string): number | null {
  try {
    const pid = Number.parseInt(readFileSync(lockPath(profileDir), "utf8").trim(), 10);
    if (Number.isInteger(pid) && pid > 0 && isAlive(pid)) return pid;
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
