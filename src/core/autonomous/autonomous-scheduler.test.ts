/**
 * Tests for the "run one cycle now" trigger of the autonomous scheduler: it submits through the daemon's
 * own path only once the scheduler is started and the cli serves a project.
 * @adr 0482
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runAutonomousNow, startAutonomousScheduler } from "./autonomous-scheduler";

describe("runAutonomousNow", () => {
  it("refuses before the scheduler starts, then submits while a project is served", () => {
    expect(runAutonomousNow()).toBe(false);
    let served: string | null = null;
    const submit = vi.fn();
    startAutonomousScheduler({ profileDir: mkdtempSync(join(tmpdir(), "4pm-sched-")), servedRoot: () => served, submit });
    expect(runAutonomousNow()).toBe(false);
    expect(submit).not.toHaveBeenCalled();
    served = "/work/project";
    expect(runAutonomousNow()).toBe(true);
    expect(submit).toHaveBeenCalledTimes(1);
  });
});
