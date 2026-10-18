/**
 * Intake claims in `AI_PROGRESS`: a task-claim write keeps the intake rows, a claim skips ids another worker
 * holds live (expired / own leftovers are dropped), release removes only its batch, and the waiting counts.
 * @adr 0529
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as B from "./autonomous-books";
import { applyIntakeClaim, intakeHeldByOthers, removeIntakeClaim, type IntakeClaim } from "./autonomous-intake-claims";
import { waitingCounts } from "./autonomous-tasks";

const HEADER = "| Started | ID | Team | Worker | Claim | Attempt | Task description |\n|---|---|---|---|---|---|---|\n";
const USER_TODO = `# User Todo

| ID | Group | Depends | Request |
|---|---|---|---|
| REQ-000001-001 | | | Add a login page |
| REQ-000002-001 | | | Add a menu |
`;

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "intake-claims-"));
  writeFileSync(join(root, "USER_TODO.md"), USER_TODO);
  writeFileSync(join(root, "USER_QA.md"), "# QA\n\n| ID | Group | Depends | Original request | Question / options | Answer |\n|---|---|---|---|---|---|\n");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("AI_PROGRESS rows", () => {
  it("splits task and intake claims, and a task-claim write keeps the intake rows", () => {
    const md = `# AI Progress\n\n${HEADER}| 2026-10-16 06:00:00 | REQ-000001-001 | | w1 | c1 | 1 | Intake — Add a login page |\n`;
    const parsed = B.parseClaims(md);
    expect(parsed.claims).toHaveLength(0);
    expect(parsed.intake.map((r) => r.id)).toEqual(["REQ-000001-001"]);
    const next = B.writeClaims(md, [{ started: "2026-10-16 06:01:00", id: "TSK-000003-001", worker: "w2", claim: "c2", attempt: 1, desc: "x" }]);
    const again = B.parseClaims(next);
    expect(again.intake.map((r) => r.id)).toEqual(["REQ-000001-001"]);
    expect(again.claims.map((r) => r.id)).toEqual(["TSK-000003-001"]);
  });
});

describe("applyIntakeClaim", () => {
  it("skips ids held live by another worker and drops expired / own leftover rows", async () => {
    const now = B.stamp();
    writeFileSync(
      join(root, "AI_PROGRESS.md"),
      `# AI Progress\n\n${HEADER}` +
        `| ${now} | REQ-000001-001 | | other | c-other | 1 | Intake — x |\n` +
        `| 2020-01-01 00:00:00 | REQ-000002-001 | | dead | c-dead | 1 | Intake — y |\n` +
        `| 2020-01-01 00:00:00 | QA-000009-001 | | me | c-old | 1 | Intake — z |\n`,
    );
    const prog = await B.readBook(root, "AI_PROGRESS.md");
    expect([...intakeHeldByOthers(prog, "me", 75).keys()]).toEqual(["REQ-000001-001"]);

    const mine: IntakeClaim = { claim: "c-new", worker: "me", started: now, ids: [] };
    const ok = await applyIntakeClaim(root, ["REQ-000001-001", "REQ-000002-001"], mine, 75, () => "");
    expect(ok).toBe(true);
    expect(mine.ids).toEqual(["REQ-000002-001"]);
    const rows = B.parseClaims(await B.readBook(root, "AI_PROGRESS.md")).intake;
    expect(rows.map((r) => `${r.id}:${r.claim}`)).toEqual(["REQ-000001-001:c-other", "REQ-000002-001:c-new"]);
    expect(rows[1]!.desc).toBe("Intake — Add a menu");

    expect(await removeIntakeClaim(root, "c-new")).toBe(true);
    expect(B.parseClaims(await B.readBook(root, "AI_PROGRESS.md")).intake.map((r) => r.id)).toEqual(["REQ-000001-001"]);
  });

  it("picks the batch from the ids still free, so a lost race takes the next request", async () => {
    // Another worker won REQ-000001-001; this worker's batch of one moves on to REQ-000002-001.
    writeFileSync(join(root, "AI_PROGRESS.md"), `# AI Progress\n\n${HEADER}| ${B.stamp()} | REQ-000001-001 | | other | c | 1 | Intake |\n`);
    const mine: IntakeClaim = { claim: "c-new", worker: "me", started: B.stamp(), ids: [] };
    const ok = await applyIntakeClaim(root, ["REQ-000001-001", "REQ-000002-001"], mine, 75, () => "", (free) => free.slice(0, 1));
    expect(ok).toBe(true);
    expect(mine.ids).toEqual(["REQ-000002-001"]);
  });

  it("claims nothing when every id is held or gone", async () => {
    writeFileSync(join(root, "AI_PROGRESS.md"), `# AI Progress\n\n${HEADER}| ${B.stamp()} | REQ-000001-001 | | other | c | 1 | Intake |\n`);
    const mine: IntakeClaim = { claim: "c-new", worker: "me", started: B.stamp(), ids: [] };
    expect(await applyIntakeClaim(root, ["REQ-000001-001", "REQ-000404-001"], mine, 75, () => "")).toBe(false);
    expect(mine.ids).toEqual([]);
  });
});

describe("waitingCounts", () => {
  it("counts unapproved rows and the blocking change requests it is given", async () => {
    writeFileSync(
      join(root, "AI_TODO.md"),
      "# AI Todo\n\n| ID | Priority | Tag | Depends | Group | Task description | Notes |\n|---|---|---|---|---|---|---|\n| TSK-000003-001 | High | | | GRP-000003 | A | |\n| TSK-000003-002 | High | | TSK-000003-001 | GRP-000003 | B | |\n",
    );
    const w = await waitingCounts(root, undefined, 3);
    // No approvals sidecar: two requests + two tasks wait for approval.
    expect(w).toEqual({ approval: 4, changeRequests: 3, answers: 0, dependencies: 0, blocked: 0 });
  });
});
