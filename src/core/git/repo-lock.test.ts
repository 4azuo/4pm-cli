/**
 * Tests for the repo lock: FIFO hand-over, queue position updates, the queue bound, the wait timeout,
 * stopping a waiter, try-acquire, and the cross-process lock file in the profile dir.
 * @adr 0506
 */
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acquireRepo,
  configureRepoLock,
  failAllRepoWaiters,
  REPO_QUEUE_MAX,
  RepoBusyError,
  RepoQueueTimeoutError,
  RepoWaitCancelledError,
  resetRepoLocksForTest,
  tryAcquireRepo,
  type RepoQueueInfo,
} from "./repo-lock";

describe("repo lock", () => {
  let dir: string;
  const root = "/tmp/4pm-repo-lock-test-root";

  beforeEach(() => {
    resetRepoLocksForTest();
    dir = mkdtempSync(join(tmpdir(), "4pm-repolock-"));
    configureRepoLock(dir);
  });
  afterEach(() => {
    resetRepoLocksForTest();
    rmSync(dir, { recursive: true, force: true });
  });

  it("hands the tree over in FIFO order and reports positions", async () => {
    const cycle = await acquireRepo(root, { holder: "autonomous", label: "cycle" });
    cycle.setTask("TSK-000001-001");
    const seen: RepoQueueInfo[] = [];
    const order: string[] = [];
    const a = acquireRepo(root, { holder: "command", label: "a", onQueued: (i) => seen.push(i) }).then((h) => {
      order.push("a");
      return h;
    });
    const b = acquireRepo(root, { holder: "git", label: "b" }).then((h) => {
      order.push("b");
      h.release();
    });
    expect(seen.at(-1)).toMatchObject({ position: 0, holder: "autonomous", task: "TSK-000001-001" });
    cycle.release();
    (await a).release();
    await b;
    expect(order).toEqual(["a", "b"]);
  });

  it("writes the lock file in the profile dir while held", async () => {
    const h = await acquireRepo(root, { holder: "project", label: "clone" });
    const f = join(dir, "repo.lock");
    expect(JSON.parse(readFileSync(f, "utf8"))).toMatchObject({ pid: process.pid, holder: "project" });
    h.release();
    expect(existsSync(f)).toBe(false);
  });

  it("try-acquire returns null while held", async () => {
    const h = await acquireRepo(root, { holder: "autonomous", label: "cycle" });
    expect(tryAcquireRepo(root, "git", "fetch")).toBeNull();
    h.release();
    const t = tryAcquireRepo(root, "git", "fetch");
    expect(t).not.toBeNull();
    t?.release();
  });

  it("refuses past the queue bound, times out, and can be stopped", async () => {
    const h = await acquireRepo(root, { holder: "autonomous", label: "cycle" });
    const waiters = Array.from({ length: REPO_QUEUE_MAX }, (_, i) =>
      acquireRepo(root, { holder: "command", label: `w${i}`, timeoutMs: 60_000 }).catch((e: unknown) => e),
    );
    await expect(acquireRepo(root, { holder: "command", label: "over" })).rejects.toBeInstanceOf(RepoBusyError);
    failAllRepoWaiters(new Error("CLI_RESTARTING"));
    expect(((await waiters[0]) as Error).message).toBe("CLI_RESTARTING");
    await expect(acquireRepo(root, { holder: "command", label: "t", timeoutMs: 10 })).rejects.toBeInstanceOf(RepoQueueTimeoutError);
    const ctl = new AbortController();
    const stopped = acquireRepo(root, { holder: "command", label: "s", signal: ctl.signal });
    ctl.abort();
    await expect(stopped).rejects.toBeInstanceOf(RepoWaitCancelledError);
    h.release();
  });
});
