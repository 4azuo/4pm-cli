/**
 * Tests for the operator restart: it hands over to the lifecycle drain at once (the drain waits for
 * running work) and ignores a repeat request.
 * @adr 0497 @adr 0505
 */
import { describe, expect, it, vi } from "vitest";
import { SessionBus } from "./session-bus";
import { RestartWhenIdle } from "./restart-when-idle";
import { work } from "./work-tracker";

describe("RestartWhenIdle", () => {
  it("requests the restart at once when idle", () => {
    const bus = new SessionBus();
    const restart = vi.spyOn(bus, "requestRestart");
    new RestartWhenIdle(bus).request();
    expect(restart).toHaveBeenCalledWith("restart");
  });

  it("requests it at once while work runs too (the drain waits), and only once", () => {
    const bus = new SessionBus();
    const restart = vi.spyOn(bus, "requestRestart");
    const lease = work.begin("command", "job");
    try {
      const r = new RestartWhenIdle(bus);
      r.request();
      r.request();
      expect(restart).toHaveBeenCalledTimes(1);
    } finally {
      lease.end();
    }
  });
});
