/**
 * Tests for the per-profile self-update state: boot trial, bad versions with their 24 h skip, the queued
 * failure report, and the no-op without a registered profile.
 * @adr 0644
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BAD_VERSION_TTL_MS,
  activeBadVersion,
  beginUpdateTrial,
  clearUpdateTrial,
  markBadVersion,
  queueUpdateReport,
  readUpdateState,
  takeUpdateReport,
  useUpdateStateDir,
} from "./update-state";

describe("update-state", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "4pm-update-state-"));
    useUpdateStateDir(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps the trial until the same version clears it", () => {
    beginUpdateTrial("1.122.0", "1.123.0");
    clearUpdateTrial("1.122.0");
    expect(readUpdateState().trial?.to).toBe("1.123.0");
    clearUpdateTrial("1.123.0");
    expect(readUpdateState().trial).toBeUndefined();
  });

  it("skips a bad version for 24 h only", () => {
    markBadVersion("1.123.0", "failed to load");
    expect(activeBadVersion("1.123.0")?.reason).toBe("failed to load");
    expect(activeBadVersion("1.123.0-b")).toBeNull();
    expect(activeBadVersion("1.123.0", Date.now() + BAD_VERSION_TTL_MS + 1)).toBeNull();
  });

  it("keeps the 5 newest bad versions, newest first, without duplicates", () => {
    for (let i = 0; i < 7; i++) markBadVersion(`1.0.${i}`, "x");
    markBadVersion("1.0.6", "again");
    const bad = readUpdateState().bad ?? [];
    expect(bad.map((b) => b.version)).toEqual(["1.0.6", "1.0.5", "1.0.4", "1.0.3", "1.0.2"]);
    expect(bad[0]?.reason).toBe("again");
  });

  it("hands a queued report out once", () => {
    queueUpdateReport({ message: "m", fromVersion: "1.0.0", toVersion: "1.1.0", at: "t" });
    expect(takeUpdateReport()?.toVersion).toBe("1.1.0");
    expect(takeUpdateReport()).toBeNull();
  });

  it("writes valid JSON and survives a corrupt file", () => {
    markBadVersion("1.1.0", "x");
    expect(JSON.parse(readFileSync(join(dir, "update-state.json"), "utf8")).bad).toHaveLength(1);
    rmSync(join(dir, "update-state.json"));
    expect(readUpdateState()).toEqual({});
  });
});
