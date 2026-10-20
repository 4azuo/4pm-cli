/**
 * Leaving the served project: the held task returns to `AI_TODO` unchanged with no attempt counted, and the
 * worker's Last check / claim mirror are stamped with the served project and dropped when it serves another one —
 * live, on connect after an offline move, never for a legacy (unstamped) file of the same project.
 * @adr 0570
 */
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as B from "./autonomous-books";
import {
  autonomousStep,
  clearAutonomousProjectState,
  lastAutonomousCheck,
  loadAutonomousPolicy,
  recordLastCheck,
  resetAutonomousPolicyForTest,
  setAutonomousServedProject,
  setAutonomousStep,
} from "./autonomous-policy";
import { applyLeaveRelease, readLocalClaim, writeLocalClaim, type LocalClaim } from "./autonomous-tasks";

const HEADER = "| Started | ID | Team | Worker | Claim | Attempt | Task description |\n|---|---|---|---|---|---|---|\n";

let dir = "";

beforeEach(() => {
  resetAutonomousPolicyForTest();
  dir = mkdtempSync(join(tmpdir(), "4pm-leave-"));
  loadAutonomousPolicy(dir);
});

afterEach(() => {
  resetAutonomousPolicyForTest();
  rmSync(dir, { recursive: true, force: true });
});

/** A claim mirror for `TSK-000001-001`. */
function claim(): LocalClaim {
  const task: B.TaskRow = { id: "TSK-000001-001", priority: "P2", tag: "", depends: [], group: "GRP-000001", desc: "Build the login page", notes: "" };
  return { id: task.id, claim: "c1", worker: "w1", started: B.stamp(), attempt: 1, branch: "dev/main/GRP-000001/TSK-000001-001", base: "main", task };
}

describe("applyLeaveRelease", () => {
  it("returns the row to AI_TODO unchanged, drops the claim and counts no attempt", async () => {
    const mine = claim();
    copyFileSync(join(__dirname, "../../../book-templates/AI_TODO.empty.md"), join(dir, "AI_TODO.md"));
    copyFileSync(join(__dirname, "../../../book-templates/AI_DONE.empty.md"), join(dir, "AI_DONE.md"));
    writeFileSync(join(dir, "AI_PROGRESS.md"), `# AI Progress\n\n${HEADER}| ${mine.started} | ${mine.id} | | w1 | c1 | 1 | ${mine.task.desc} |\n`);
    expect(await applyLeaveRelease(dir, mine)).toBe(true);
    expect(B.parseClaims(await B.readBook(dir, "AI_PROGRESS.md")).claims).toHaveLength(0);
    const back = B.parseTasks(await B.readBook(dir, "AI_TODO.md")).tasks.find((t) => t.id === mine.id);
    expect(back?.desc).toBe("Build the login page");
    expect(back?.notes).toBe("");
    expect((await B.readAttempts(dir))[mine.id]).toBeUndefined();
    expect(await B.readBook(dir, "AI_DONE.md")).toContain("w1 left the project while running TSK-000001-001");
  });

  it("publishes nothing when the claim is no longer this worker's", async () => {
    writeFileSync(join(dir, "AI_PROGRESS.md"), `# AI Progress\n\n${HEADER}| ${B.stamp()} | TSK-000001-001 | | w2 | c2 | 1 | x |\n`);
    expect(await applyLeaveRelease(dir, claim())).toBe(false);
  });
});

describe("project-stamped autonomous state", () => {
  it("stamps the last check and the claim mirror with the served project", async () => {
    setAutonomousServedProject("pA");
    recordLastCheck("skip", "no work");
    await writeLocalClaim(dir, claim());
    expect(JSON.parse(readFileSync(join(dir, "autonomous.lastcheck.json"), "utf8")).projectId).toBe("pA");
    expect((await readLocalClaim(dir))?.projectId).toBe("pA");
  });

  it("a live switch drops the last check, the step and the claim", async () => {
    setAutonomousServedProject("pA");
    recordLastCheck("skip", "no work");
    setAutonomousStep("implement", ["TSK-000001-001"]);
    await writeLocalClaim(dir, claim());
    expect(setAutonomousServedProject("pB")).toBe(true);
    expect(lastAutonomousCheck()).toBeNull();
    expect(autonomousStep()).toBeNull();
    expect(await readLocalClaim(dir)).toBeNull();
    expect(existsSync(join(dir, "autonomous.lastcheck.json"))).toBe(false);
  });

  it("drops another project's stamped state on connect after a restart (offline move)", async () => {
    setAutonomousServedProject("pA");
    recordLastCheck("skip", "no work");
    await writeLocalClaim(dir, claim());
    resetAutonomousPolicyForTest();
    loadAutonomousPolicy(dir);
    expect(lastAutonomousCheck()?.reason).toBe("no work");
    setAutonomousServedProject("pB");
    expect(lastAutonomousCheck()).toBeNull();
    expect(await readLocalClaim(dir)).toBeNull();
  });

  it("keeps the same project's state on connect, and adopts a legacy unstamped file", async () => {
    writeFileSync(join(dir, "autonomous.lastcheck.json"), JSON.stringify({ at: "t", outcome: "skip", reason: "no work" }));
    writeFileSync(join(dir, "autonomous-claim.json"), JSON.stringify(claim()));
    loadAutonomousPolicy(dir);
    expect(setAutonomousServedProject("pA")).toBe(false);
    expect(lastAutonomousCheck()?.reason).toBe("no work");
    expect((await readLocalClaim(dir))?.id).toBe("TSK-000001-001");
  });

  it("clearAutonomousProjectState drops everything at once", async () => {
    setAutonomousServedProject("pA");
    recordLastCheck("run", "done");
    await writeLocalClaim(dir, claim());
    clearAutonomousProjectState();
    expect(lastAutonomousCheck()).toBeNull();
    expect(await readLocalClaim(dir)).toBeNull();
  });
});
