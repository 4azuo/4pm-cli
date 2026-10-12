/**
 * Per-profile single-instance lock: a `start.lock` file in the profile
 * directory holds the pid of the running `4pm start`. It stops two clis on the same
 * profile (hence the same MACHINE link) from thrashing each other's ws_token. A stale
 * lock — pid no longer alive, OR whose pid is this very process — is taken over.
 *
 * The "pid is this very process" case is essential for the containerized worker:
 * the cli runs as pid 1, its profile (with start.lock) lives on a persistent
 * volume, and a non-graceful kill (SIGKILL/OOM/host shutdown) leaves start.lock=1 behind.
 * Every restart is pid 1 again, so a naive `isAlive(1)` (the process probing itself) would
 * wedge the profile forever. A genuinely-distinct live instance always has a different pid,
 * so a lock whose pid equals ours is by definition our own stale lock, never a conflict.
 *
 * Pids also repeat across container restarts for OTHER processes — e.g. the self-update re-exec
 * parent can get the very pid a previous run's cli left in the lock. So on Linux a live
 * pid only counts as the holder when it was already running when the lock was written; a process
 * started later cannot have written it.
 * @adr 0047 @adr 0192 @adr 0473
 */
import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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

/** Linux clock ticks per second for `/proc/<pid>/stat` starttime (USER_HZ — 100 on every mainstream arch). */
const CLOCK_TICKS_PER_SEC = 100;

/** System boot time in epoch ms (`/proc/stat` btime), or null without `/proc`. */
function bootTimeMs(): number | null {
  try {
    const m = /^btime (\d+)$/m.exec(readFileSync("/proc/stat", "utf8"));
    return m ? Number(m[1]) * 1000 : null;
  } catch {
    return null;
  }
}

/**
 * When a pid started, in epoch ms: `"unknown"` without `/proc` (non-Linux), `"unreadable"` when
 * `/proc` exists but the pid's stat can't be read (another uid under hidepid, or it just exited).
 * Truncation (ticks, whole-second btime) only makes it earlier — biased toward "still the holder".
 */
export function processStartMs(pid: number): number | "unknown" | "unreadable" {
  const boot = bootTimeMs();
  if (boot === null) return "unknown";
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // Field 22 (starttime); the command name (field 2) may contain spaces/parens ⇒ split after the last ")".
    const starttime = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]);
    return Number.isFinite(starttime) ? boot + (starttime * 1000) / CLOCK_TICKS_PER_SEC : "unreadable";
  } catch {
    return "unreadable";
  }
}

/** Could `pid` have written a lock last modified at `lockMtimeMs`? (it must already have been running) */
function startedBeforeLock(pid: number, lockMtimeMs: number): boolean {
  const started = processStartMs(pid);
  if (started === "unknown") return true; // no /proc ⇒ pid-only rule
  // Unreadable stat for a live pid ⇒ another uid ⇒ it can't be this profile's cli (the profile is 0700).
  if (started === "unreadable") return false;
  return started <= lockMtimeMs;
}

/** The pid of a DISTINCT live lock holder, or null when free/stale (incl. our own pid). */
export function lockHolder(profileDir: string): number | null {
  try {
    const pid = Number.parseInt(readFileSync(lockPath(profileDir), "utf8").trim(), 10);
    // A lock whose pid is our own is a stale lock left by a previous run of THIS process
    // slot (the container pid-1 restart case), not a competing instance ⇒ take it over.
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid || !isAlive(pid)) return null;
    // A live pid that started after the lock was written is a reused pid, not the writer.
    if (!startedBeforeLock(pid, statSync(lockPath(profileDir)).mtimeMs)) return null;
    return pid;
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
