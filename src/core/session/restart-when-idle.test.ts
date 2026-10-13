/**
 * Tests for the operator restart: it fires at once when idle, waits for a busy command / an in-flight
 * AI run otherwise, and ignores a repeat request.
 */
import { describe, expect, it, vi } from "vitest";
import { SessionBus } from "./session-bus";
import { RestartWhenIdle } from "./restart-when-idle";

describe("RestartWhenIdle", () => {
  it("restarts at once when idle", () => {
    const bus = new SessionBus();
    const restart = vi.spyOn(bus, "requestRestart");
    new RestartWhenIdle(bus, () => 0).request();
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it("waits for the busy command to end", () => {
    const bus = new SessionBus();
    const restart = vi.spyOn(bus, "requestRestart");
    bus.startBusy("job");
    const r = new RestartWhenIdle(bus, () => 0);
    r.request();
    r.request();
    expect(restart).not.toHaveBeenCalled();
    bus.endBusy("job");
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it("waits for in-flight AI runs (polled)", () => {
    vi.useFakeTimers();
    try {
      const bus = new SessionBus();
      const restart = vi.spyOn(bus, "requestRestart");
      let runs = 1;
      new RestartWhenIdle(bus, () => runs).request();
      vi.advanceTimersByTime(5_000);
      expect(restart).not.toHaveBeenCalled();
      runs = 0;
      vi.advanceTimersByTime(2_000);
      expect(restart).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
