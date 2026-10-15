/**
 * Tests for the multi-worker autonomous authority on the cli: the policy overlays the project-scoped
 * knobs, blocks cycles while the project switch is off / the worker is not allowed, is persisted, and
 * config writes are patches that record who paused the worker and never revert each other.
 * @adr 0507
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  autonomousPolicy,
  loadAutonomousPolicy,
  policyBlockReason,
  resetAutonomousPolicyForTest,
  setAutonomousPolicy,
} from "./autonomous-policy";
import {
  patchAutonomousConfig,
  pauseAutonomous,
  readAutonomousConfig,
  readAutonomousConfigText,
  readWorkerAutonomousConfig,
  writeAutonomousConfig,
} from "./autonomous-config";

describe("autonomous policy", () => {
  let dir: string;
  beforeEach(() => {
    resetAutonomousPolicyForTest();
    dir = mkdtempSync(join(tmpdir(), "4pm-pol-"));
    loadAutonomousPolicy(dir);
  });
  afterEach(() => {
    resetAutonomousPolicyForTest();
    rmSync(dir, { recursive: true, force: true });
  });

  it("no policy ⇒ blocked (not assigned) and the worker file's knobs apply", async () => {
    writeFileSync(join(dir, "autonomous.config.json"), JSON.stringify({ paused: false, claimTtlHours: 9 }));
    expect(policyBlockReason()).toBe("notAssigned");
    expect((await readAutonomousConfig(dir)).claimTtlHours).toBe(9);
  });

  it("overlays the project knobs, blocks while off / not allowed, and is persisted", async () => {
    writeFileSync(join(dir, "autonomous.config.json"), JSON.stringify({ paused: false, claimTtlHours: 9, cronSchedule: "*/5 * * * *" }));
    setAutonomousPolicy({ projectEnabled: false, allowed: true, reason: "projectDisabled", settings: { claimTtlHours: 3 } });
    expect(policyBlockReason()).toBe("projectDisabled");
    const cfg = await readAutonomousConfig(dir);
    expect(cfg.claimTtlHours).toBe(3); // the project's value wins
    expect(cfg.cronSchedule).toBe("*/5 * * * *"); // worker-scoped stays the worker's
    setAutonomousPolicy({ projectEnabled: true, allowed: false, reason: "projectPaused", settings: {} });
    expect(policyBlockReason()).toBe("projectPaused");
    // A restart (offline) reads the persisted policy back.
    resetAutonomousPolicyForTest();
    loadAutonomousPolicy(dir);
    expect(autonomousPolicy()?.reason).toBe("projectPaused");
    // The editor text carries the worker-scoped keys only once a policy exists.
    expect(JSON.parse(await readAutonomousConfigText(dir))).not.toHaveProperty("claimTtlHours");
  });

  it("records who paused, clears it on resume, and patches never revert other keys", async () => {
    await writeAutonomousConfig(dir, { paused: false, cronSchedule: "*/10 * * * *" });
    await writeAutonomousConfig(dir, { paused: true });
    let cfg = await readWorkerAutonomousConfig(dir);
    expect(cfg.pausedBy).toBe("user");
    expect(cfg.cronSchedule).toBe("*/10 * * * *");
    await writeAutonomousConfig(dir, { paused: false });
    cfg = await readWorkerAutonomousConfig(dir);
    expect(cfg.pausedBy).toBeUndefined();
    // A concurrent Settings save and an auto-pause: both land.
    await Promise.all([patchAutonomousConfig(dir, { cronSchedule: "0 * * * *" }), pauseAutonomous(dir, "auto", "3 failures")]);
    const file = JSON.parse(readFileSync(join(dir, "autonomous.config.json"), "utf8")) as Record<string, unknown>;
    expect(file).toMatchObject({ paused: true, pausedBy: "auto", pausedReason: "3 failures", cronSchedule: "0 * * * *" });
  });
});
