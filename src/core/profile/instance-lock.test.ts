/**
 * Tests for the per-profile single-instance lock — own/dead/live holders and the reused-pid rule
 * (a live pid that started after the lock was written is not the holder).
 * @adr 0047 @adr 0473
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireInstanceLock, lockHolder, processStartMs, releaseInstanceLock } from "./instance-lock";

const linux = process.platform === "linux";

/** Start a long-lived child process to stand in for another live pid. */
function startSleeper(): ChildProcess {
  return spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], { stdio: "ignore" });
}

/** Write a lock holding `pid`, optionally back-dating its mtime by `ageMs`. */
function writeLock(dir: string, pid: number, ageMs = 0): void {
  const file = join(dir, "start.lock");
  writeFileSync(file, String(pid), "utf8");
  if (ageMs > 0) {
    const at = (Date.now() - ageMs) / 1000;
    utimesSync(file, at, at);
  }
}

describe("instance-lock", () => {
  let dir: string;
  let sleeper: ChildProcess | null = null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "4pm-lock-"));
  });
  afterEach(() => {
    sleeper?.kill();
    sleeper = null;
    rmSync(dir, { recursive: true, force: true });
  });

  it("acquires a free profile and writes its own pid", () => {
    expect(acquireInstanceLock(dir)).toBe(true);
    expect(readFileSync(join(dir, "start.lock"), "utf8")).toBe(String(process.pid));
  });

  it("takes over a lock holding its own pid", () => {
    writeLock(dir, process.pid, 3_600_000);
    expect(lockHolder(dir)).toBeNull();
    expect(acquireInstanceLock(dir)).toBe(true);
  });

  it("takes over a lock whose pid is dead", async () => {
    const dead = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    await new Promise((resolve) => dead.on("exit", resolve));
    writeLock(dir, dead.pid!);
    expect(lockHolder(dir)).toBeNull();
  });

  it("refuses while a live process that wrote the lock holds it", async () => {
    sleeper = startSleeper();
    // Let the child start before the lock is written (its start time must precede the mtime).
    await new Promise((resolve) => setTimeout(resolve, 50));
    writeLock(dir, sleeper.pid!);
    expect(lockHolder(dir)).toBe(sleeper.pid);
    expect(acquireInstanceLock(dir)).toBe(false);
  });

  it.runIf(linux)("treats a live pid that started after the lock was written as stale (reused pid)", () => {
    sleeper = startSleeper();
    // The lock predates the live process ⇒ that process can't have written it.
    writeLock(dir, sleeper.pid!, 3_600_000);
    expect(lockHolder(dir)).toBeNull();
    expect(acquireInstanceLock(dir)).toBe(true);
  });

  it.runIf(linux)("reads a start time no later than now for a live pid", () => {
    const started = processStartMs(process.pid);
    expect(typeof started).toBe("number");
    expect(started as number).toBeLessThanOrEqual(Date.now());
  });

  it("releases only its own lock", () => {
    sleeper = startSleeper();
    writeLock(dir, sleeper.pid!);
    releaseInstanceLock(dir);
    expect(readFileSync(join(dir, "start.lock"), "utf8")).toBe(String(sleeper.pid));
    writeLock(dir, process.pid);
    releaseInstanceLock(dir);
    expect(() => readFileSync(join(dir, "start.lock"), "utf8")).toThrow();
  });
});
