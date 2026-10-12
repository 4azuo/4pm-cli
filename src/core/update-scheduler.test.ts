/**
 * Tests for the scheduled / pushed cli self-update hand-off: a successful update asks `4pm start` to
 * restart (it releases the lock first) instead of re-execing from the scheduler.
 * @adr 0473 @adr 0289
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const updateToLatest = vi.fn();
const spawn = vi.fn();

vi.mock("../version", () => ({ CLI_VERSION: "1.0.0" }));
vi.mock("../config/profile", () => ({ readProfileConfig: () => ({}) }));
vi.mock("./update", () => ({ CLI_UPDATE_LOCKED_REASON: "locked", updateToLatest }));
vi.mock("node:child_process", () => ({ spawn }));

const { SessionBus } = await import("./session/session-bus");
const { UpdateScheduler } = await import("./update-scheduler");

/** Let the scheduler's async tick settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
}

describe("UpdateScheduler restart hand-off", () => {
  beforeEach(() => {
    updateToLatest.mockReset();
    spawn.mockReset();
  });

  it("requests a restart after a pushed update instead of spawning the new binary", async () => {
    updateToLatest.mockResolvedValue({ action: "updated", version: "1.1.0" });
    const bus = new SessionBus();
    const onRestart = vi.fn();
    bus.onRestart(onRestart);
    const scheduler = new UpdateScheduler("https://api.example", "/tmp/profile", bus);

    scheduler.updateNow();
    await settle();

    expect(updateToLatest).toHaveBeenCalledWith("https://api.example", true);
    expect(onRestart).toHaveBeenCalledTimes(1);
    expect(bus.restartRequested).toBe(true);
    expect(spawn).not.toHaveBeenCalled();
    scheduler.stop();
  });

  it("does not restart when already on the latest version", async () => {
    updateToLatest.mockResolvedValue({ action: "already-latest", version: "1.0.0" });
    const bus = new SessionBus();
    const scheduler = new UpdateScheduler("https://api.example", "/tmp/profile", bus);

    scheduler.updateNow();
    await settle();

    expect(bus.restartRequested).toBe(false);
    scheduler.stop();
  });

  it("notifies a subscriber that attaches after the restart was requested", () => {
    const bus = new SessionBus();
    bus.requestRestart();
    const late = vi.fn();
    bus.onRestart(late);
    expect(late).toHaveBeenCalledTimes(1);
  });
});
