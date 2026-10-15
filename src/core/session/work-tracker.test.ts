/**
 * Tests for the WorkTracker — the daemon's single idle signal.
 * @adr 0505
 */
import { describe, expect, it } from "vitest";
import { WorkTracker } from "./work-tracker";

describe("WorkTracker", () => {
  it("is idle only when every lease ended (end is idempotent)", () => {
    const w = new WorkTracker();
    expect(w.idle()).toBe(true);
    const a = w.begin("autonomousCycle");
    const b = w.begin("aiRun", "run-1");
    expect(w.idle()).toBe(false);
    expect(w.kinds().sort()).toEqual(["aiRun", "autonomousCycle"]);
    a.end();
    a.end();
    expect(w.idle()).toBe(false);
    b.end();
    expect(w.idle()).toBe(true);
  });

  it("track() ends the lease when the work throws", async () => {
    const w = new WorkTracker();
    await expect(w.track("gitOp", "x", async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(w.idle()).toBe(true);
  });

  it("waitIdle resolves true once idle, false after the bound", async () => {
    const w = new WorkTracker();
    const lease = w.begin("command");
    expect(await w.waitIdle(10)).toBe(false);
    const waiting = w.waitIdle(1_000);
    lease.end();
    expect(await waiting).toBe(true);
  });
});
