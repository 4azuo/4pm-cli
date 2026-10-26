/**
 * Tests for the self-update's bad-version handling: a boot back on an older version marks the trial's
 * version bad and queues a report, and every update path skips a bad version (a mandatory one blocks so
 * `4pm start` waits instead of exiting).
 * @adr 0644
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchCliVersion = vi.fn();

vi.mock("../version", () => ({ CLI_VERSION: "1.122.0" }));
vi.mock("../services/api", () => ({ fetchCliVersion }));

const { checkAndUpdate, settleUpdateTrialAtBoot, updateToLatest } = await import("./update");
const state = await import("./update-state");

/** A server answer whose latest is 1.123.0 and whose minimum is `min`. */
function meta(min: string): unknown {
  return {
    latest: "1.123.0",
    minSupported: min,
    source: { tarballUrl: "https://example.invalid/cli.tgz", checksum: "x", signature: "y" },
  };
}

describe("bad versions", () => {
  let dir: string;
  const fetchSpy = vi.spyOn(globalThis, "fetch");

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "4pm-bad-version-"));
    state.useUpdateStateDir(dir);
    fetchCliVersion.mockReset();
    fetchSpy.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("marks a newer trial version bad when the boot is back on an older one", () => {
    state.beginUpdateTrial("1.122.0", "1.123.0");
    settleUpdateTrialAtBoot();
    expect(state.activeBadVersion("1.123.0")?.reason).toMatch(/did not start/);
    expect(state.readUpdateState().trial).toBeUndefined();
    expect(state.takeUpdateReport()).toMatchObject({ fromVersion: "1.122.0", toVersion: "1.123.0" });
  });

  it("keeps a trial for the running version and drops one for an older version", () => {
    state.beginUpdateTrial("1.121.0", "1.122.0");
    settleUpdateTrialAtBoot();
    expect(state.readUpdateState().trial?.to).toBe("1.122.0");
    state.beginUpdateTrial("1.120.0", "1.121.0");
    settleUpdateTrialAtBoot();
    expect(state.readUpdateState().trial).toBeUndefined();
    expect(state.activeBadVersion("1.121.0")).toBeNull();
  });

  it("refuses a forced update to a bad version without downloading", async () => {
    state.markBadVersion("1.123.0", "failed to load: boom");
    fetchCliVersion.mockResolvedValue(meta("1.0.0"));
    const result = await updateToLatest("https://api.example", true);
    expect(result).toMatchObject({ action: "failed", toVersion: "1.123.0" });
    expect(result.action === "failed" && result.error).toMatch(/failed on this worker \(failed to load: boom\)/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("keeps running on an optional bad version and blocks (not locked) on a mandatory one", async () => {
    state.markBadVersion("1.123.0", "x");
    fetchCliVersion.mockResolvedValue(meta("1.0.0"));
    expect(await checkAndUpdate("https://api.example", true)).toEqual({ action: "none" });
    fetchCliVersion.mockResolvedValue(meta("1.123.0"));
    const blocked = await checkAndUpdate("https://api.example", true);
    expect(blocked).toEqual({ action: "blocked", minSupported: "1.123.0" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
