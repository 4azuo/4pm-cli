/**
 * Tests for the daemon lifecycle: the drain waits for running work, cancels it at the bound, and every
 * registered service is stopped (engine first, process last) — nothing outlives a shutdown.
 * @adr 0505
 */
import { describe, expect, it } from "vitest";
import { Lifecycle } from "./lifecycle";
import { work } from "./work-tracker";

describe("Lifecycle", () => {
  it("drains running work, then stops engine → session → close → process services", async () => {
    const lc = new Lifecycle();
    const order: string[] = [];
    lc.register("proc", "process", () => void order.push("process"));
    lc.register("sess", "session", () => void order.push("session"));
    lc.register("eng", "engine", () => void order.push("engine"));
    lc.setSessionCloser(() => void order.push("close"));
    lc.setConnected(true);
    const lease = work.begin("autonomousCycle", "test-cycle");
    const done = lc.shutdown("restart", { drainMs: 5_000 });
    await new Promise((r) => setTimeout(r, 20));
    expect(lc.state).toBe("draining");
    expect(lc.stopping).toBe(true);
    expect(order).toEqual(["engine"]); // the engine stops at once, the rest waits for the work
    lease.end();
    await done;
    expect(order).toEqual(["engine", "session", "close", "process"]);
    expect(lc.state).toBe("stopped");
    expect(lc.serviceNames()).toEqual([]);
  });

  it("runs the cancel hooks when the drain bound is reached", async () => {
    const lc = new Lifecycle();
    const lease = work.begin("aiRun", "stuck");
    let cancelled = false;
    lc.onDrainTimeout(() => {
      cancelled = true;
      lease.end();
    });
    await lc.shutdown("update", { drainMs: 10, cancelGraceMs: 1_000 });
    expect(cancelled).toBe(true);
    expect(lc.state).toBe("stopped");
  });

  it("is idempotent and keeps the first reason", async () => {
    const lc = new Lifecycle();
    const a = lc.shutdown("replaced", { drainMs: 0 });
    const b = lc.shutdown("restart", { drainMs: 0 });
    expect(a).toBe(b);
    await a;
    expect(lc.reason).toBe("replaced");
  });

  it("a disconnect stops only the session services", async () => {
    const lc = new Lifecycle();
    const stopped: string[] = [];
    lc.register("s", "session", () => void stopped.push("s"));
    lc.register("e", "engine", () => void stopped.push("e"));
    lc.setConnected(true);
    lc.setConnected(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(stopped).toEqual(["s"]);
    expect(lc.has("e")).toBe(true);
    expect(lc.state).toBe("connecting");
  });
});
