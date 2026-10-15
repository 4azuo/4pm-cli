/**
 * Repo lock — one owner of a served project's git working tree at a time. The autonomous cycle (its
 * whole run), Console AI runs in the root, git-changing commands, Git tab writes, clone / provision and a
 * project drain take it exclusively; others **wait in a FIFO** (bounded) instead of failing or racing
 * (`index.lock`, an agent editing the engine's task branch, a silent stash). The lock is in-process plus a
 * `repo.lock` file in the **profile dir** (never the workspace — the agent uid can write there) so a
 * second process of the same profile cannot take the tree either.
 * @adr 0506
 */
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { logger } from "../../common/logger/logger";
import { processStartMs } from "../profile/instance-lock";

/** Who holds the tree. */
export type RepoHolder = "autonomous" | "command" | "git" | "project";

/** What a waiter is told while it waits. */
export interface RepoQueueInfo {
  /** Waiters ahead of this one (0 = next). */
  position: number;
  holder: RepoHolder;
  /** The task the autonomous holder works on, when known. */
  task?: string;
}

/** A held lock; `release()` is idempotent. */
export interface RepoLockHandle {
  readonly root: string;
  release(): void;
  /** Tell waiters which task the holder now works on (the autonomous cycle after its claim). */
  setTask(task: string | undefined): void;
}

/** Acquire options. */
export interface RepoAcquireOptions {
  holder: RepoHolder;
  label: string;
  task?: string;
  /** Stop waiting (the run was stopped). */
  signal?: AbortSignal;
  /** Called when the request is queued and whenever its position changes. */
  onQueued?: (info: RepoQueueInfo) => void;
  /** Wait bound in ms (default: the configured queue timeout). */
  timeoutMs?: number;
}

/** Thrown when the queue is full. */
export class RepoBusyError extends Error {
  readonly code = "REPO_BUSY";
}
/** Thrown when a waiter gave up after the timeout. */
export class RepoQueueTimeoutError extends Error {
  readonly code = "REPO_QUEUE_TIMEOUT";
}
/** Thrown when a waiter was stopped. */
export class RepoWaitCancelledError extends Error {
  readonly code = "REPO_WAIT_CANCELLED";
}

/** At most this many waiters per root. */
export const REPO_QUEUE_MAX = 20;
/** Default wait bound (minutes) — `repoQueueTimeoutMin` in the worker config overrides it. */
export const REPO_QUEUE_TIMEOUT_DEFAULT_MIN = 120;
/** How often a waiter re-checks a lock file held by another process (ms). */
const FOREIGN_POLL_MS = 2_000;

/** One root's state. */
interface RootState {
  current: { holder: RepoHolder; label: string; task?: string; since: number } | null;
  queue: Waiter[];
}

/** A queued request. */
interface Waiter {
  opts: RepoAcquireOptions;
  grant: () => void;
  fail: (err: Error) => void;
  lastPosition: number;
}

const roots = new Map<string, RootState>();
let profileDir: string | null = null;
let timeoutMin = REPO_QUEUE_TIMEOUT_DEFAULT_MIN;

/** Point the cross-process lock file at this profile and set the queue timeout. */
export function configureRepoLock(dir: string, queueTimeoutMin?: number): void {
  profileDir = dir;
  if (typeof queueTimeoutMin === "number" && Number.isFinite(queueTimeoutMin) && queueTimeoutMin > 0) {
    timeoutMin = queueTimeoutMin;
  }
}

/** Normalize a root to its lock key. */
function keyOf(root: string): string {
  return resolve(root);
}

/** The state of a root (created on first use). */
function stateOf(key: string): RootState {
  let st = roots.get(key);
  if (!st) {
    st = { current: null, queue: [] };
    roots.set(key, st);
  }
  return st;
}

/** Who holds a root now (null = free) — for status lines. */
export function repoLockHolder(root: string): { holder: RepoHolder; label: string; task?: string } | null {
  const cur = roots.get(keyOf(root))?.current;
  return cur ? { holder: cur.holder, label: cur.label, task: cur.task } : null;
}

/** Take the lock now if it is free (no queueing); null when busy. */
export function tryAcquireRepo(root: string, holder: RepoHolder, label: string): RepoLockHandle | null {
  const key = keyOf(root);
  const st = stateOf(key);
  if (st.current || st.queue.length > 0 || foreignHolder(key)) return null;
  return grant(key, st, { holder, label });
}

/**
 * Take the lock, waiting in the root's FIFO when it is held. Rejects with {@link RepoBusyError} when
 * the queue is full, {@link RepoQueueTimeoutError} after the wait bound, {@link RepoWaitCancelledError}
 * when `signal` aborts.
 */
export function acquireRepo(root: string, opts: RepoAcquireOptions): Promise<RepoLockHandle> {
  const key = keyOf(root);
  const st = stateOf(key);
  if (!st.current && st.queue.length === 0 && !foreignHolder(key)) {
    return Promise.resolve(grant(key, st, opts));
  }
  if (st.queue.length >= REPO_QUEUE_MAX) {
    return Promise.reject(new RepoBusyError(`The project's working tree is busy (${REPO_QUEUE_MAX} jobs waiting).`));
  }
  return new Promise<RepoLockHandle>((resolveHandle, reject) => {
    let settled = false;
    let poll: NodeJS.Timeout | null = null;
    const cleanup = (): void => {
      clearTimeout(timer);
      if (poll) clearInterval(poll);
      opts.signal?.removeEventListener("abort", onAbort);
      const i = st.queue.indexOf(waiter);
      if (i >= 0) st.queue.splice(i, 1);
      notifyPositions(st);
    };
    const waiter: Waiter = {
      opts,
      lastPosition: -1,
      grant: () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolveHandle(grant(key, st, opts));
      },
      fail: (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      },
    };
    const onAbort = (): void => waiter.fail(new RepoWaitCancelledError("Stopped while waiting for the project's working tree."));
    const ms = opts.timeoutMs ?? timeoutMin * 60_000;
    const timer = setTimeout(
      () => waiter.fail(new RepoQueueTimeoutError(`Waited ${Math.round(ms / 60_000)} min for the project's working tree.`)),
      ms,
    );
    timer.unref?.();
    if (opts.signal?.aborted) {
      onAbort();
      return;
    }
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    st.queue.push(waiter);
    notifyPositions(st);
    // A lock held by another process frees without an in-process event — poll for it.
    if (!st.current) {
      poll = setInterval(() => pump(key, st), FOREIGN_POLL_MS);
      poll.unref?.();
    }
  });
}

/** Run `fn` while holding the root's lock. */
export async function withRepoLock<T>(root: string, opts: RepoAcquireOptions, fn: (h: RepoLockHandle) => Promise<T>): Promise<T> {
  const handle = await acquireRepo(root, opts);
  try {
    return await fn(handle);
  } finally {
    handle.release();
  }
}

/** Mark the root held and return its handle. */
function grant(key: string, st: RootState, opts: Pick<RepoAcquireOptions, "holder" | "label" | "task">): RepoLockHandle {
  st.current = { holder: opts.holder, label: opts.label, task: opts.task, since: Date.now() };
  writeLockFile(key, opts.holder);
  let released = false;
  return {
    root: key,
    setTask: (task) => {
      if (!released && st.current) {
        st.current.task = task;
        for (const w of st.queue) w.lastPosition = -1; // re-announce with the task
        notifyPositions(st);
      }
    },
    release: () => {
      if (released) return;
      released = true;
      st.current = null;
      removeLockFile(key);
      pump(key, st);
    },
  };
}

/** Hand the root to the next waiter when it is free. */
function pump(key: string, st: RootState): void {
  if (st.current || foreignHolder(key)) return;
  st.queue[0]?.grant();
}

/** Tell each waiter its position (only when it changed). */
function notifyPositions(st: RootState): void {
  st.queue.forEach((w, i) => {
    if (w.lastPosition === i) return;
    w.lastPosition = i;
    try {
      w.opts.onQueued?.({ position: i, holder: st.current?.holder ?? "project", task: st.current?.task });
    } catch {
      /* a status callback must not break the queue */
    }
  });
}

// ── Cross-process part: `repo.lock` in the profile dir ───────────────────────────────────────────

/** The lock file path (one per profile — a profile serves one project). */
function lockFile(): string | null {
  return profileDir ? join(profileDir, "repo.lock") : null;
}

/** Record this process as the holder of `key`. Best-effort. */
function writeLockFile(key: string, holder: RepoHolder): void {
  const f = lockFile();
  if (!f) return;
  try {
    writeFileSync(f, JSON.stringify({ pid: process.pid, root: key, holder }), { mode: 0o600 });
  } catch (err) {
    logger.warn("repo.lock.write", { error: String(err) });
  }
}

/** Remove the lock file when this process owns it. */
function removeLockFile(key: string): void {
  const f = lockFile();
  if (!f) return;
  try {
    const cur = JSON.parse(readFileSync(f, "utf8")) as { pid?: number; root?: string };
    if (cur.pid === process.pid && cur.root === key) rmSync(f, { force: true });
  } catch {
    /* gone already */
  }
}

/**
 * True when another **live** process holds `key` (the instance-lock liveness rule: the pid is alive
 * and was already running when the file was written — a reused pid is not the writer).
 */
function foreignHolder(key: string): boolean {
  const f = lockFile();
  if (!f || !existsSync(f)) return false;
  try {
    const cur = JSON.parse(readFileSync(f, "utf8")) as { pid?: number; root?: string };
    if (!cur.pid || cur.pid === process.pid || cur.root !== key) return false;
    try {
      process.kill(cur.pid, 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EPERM") return false;
    }
    const started = processStartMs(cur.pid);
    if (started === "unknown") return true;
    if (started === "unreadable") return false;
    return started <= statSync(f).mtimeMs;
  } catch {
    return false;
  }
}

/** Fail every waiter of every root (the daemon is draining — they must not start). @adr 0505 */
export function failAllRepoWaiters(err: Error): void {
  for (const st of roots.values()) {
    for (const w of [...st.queue]) w.fail(err);
  }
}

/** Reset every root (tests). */
export function resetRepoLocksForTest(): void {
  roots.clear();
  profileDir = null;
  timeoutMin = REPO_QUEUE_TIMEOUT_DEFAULT_MIN;
}
