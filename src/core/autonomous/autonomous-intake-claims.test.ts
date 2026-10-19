/**
 * Intake claims in `AI_PROGRESS`: a task-claim write keeps the intake rows, a claim takes ONE id and skips ids another
 * worker holds live (expired / own leftovers are dropped), `dropClaim` removes an intake row like a task row, the
 * waiting counts, and a request held back by an unfinished dependency.
 * @adr 0529 @adr 0561 @adr 0563
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as B from "./autonomous-books";
import { applyIntakeClaim, intakeHeldByOthers, type IntakeClaimDraft } from "./autonomous-intake-claims";
import { dropClaim, requestWaiting, waitingCounts, type LocalClaim } from "./autonomous-tasks";

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
    expect([...intakeHeldByOthers(prog, "me", 6).keys()]).toEqual(["REQ-000001-001"]);

    const mine: IntakeClaimDraft = { claim: "c-new", worker: "me", started: now, attempt: 1, id: "" };
    const ok = await applyIntakeClaim(root, ["REQ-000001-001", "REQ-000002-001"], mine, 6, () => "", () => 3);
    expect(ok).toBe(true);
    expect(mine.id).toBe("REQ-000002-001");
    expect(mine.attempt).toBe(3);
    const rows = B.parseClaims(await B.readBook(root, "AI_PROGRESS.md")).intake;
    expect(rows.map((r) => `${r.id}:${r.claim}:${r.attempt}`)).toEqual(["REQ-000001-001:c-other:1", "REQ-000002-001:c-new:3"]);
    expect(rows[1]!.desc).toBe("Intake — Add a menu");

    const claim = { id: "REQ-000002-001", claim: "c-new" } as LocalClaim;
    expect(await dropClaim(root, claim)).toBe(true);
    expect(B.parseClaims(await B.readBook(root, "AI_PROGRESS.md")).intake.map((r) => r.id)).toEqual(["REQ-000001-001"]);
  });

  it("claims one id: a lost race takes the next free request", async () => {
    writeFileSync(join(root, "AI_PROGRESS.md"), `# AI Progress\n\n${HEADER}| ${B.stamp()} | REQ-000001-001 | | other | c | 1 | Intake |\n`);
    const mine: IntakeClaimDraft = { claim: "c-new", worker: "me", started: B.stamp(), attempt: 1, id: "" };
    expect(await applyIntakeClaim(root, ["REQ-000001-001", "REQ-000002-001"], mine, 6, () => "", () => 1)).toBe(true);
    expect(mine.id).toBe("REQ-000002-001");
    expect(B.parseClaims(await B.readBook(root, "AI_PROGRESS.md")).intake).toHaveLength(2);
  });

  it("claims nothing when every id is held or gone", async () => {
    writeFileSync(join(root, "AI_PROGRESS.md"), `# AI Progress\n\n${HEADER}| ${B.stamp()} | REQ-000001-001 | | other | c | 1 | Intake |\n`);
    const mine: IntakeClaimDraft = { claim: "c-new", worker: "me", started: B.stamp(), attempt: 1, id: "" };
    expect(await applyIntakeClaim(root, ["REQ-000001-001", "REQ-000404-001"], mine, 6, () => "", () => 1)).toBe(false);
    expect(mine.id).toBe("");
  });
});

describe("waitingCounts", () => {
  it("counts unapproved rows and the blocking change requests it is given", async () => {
    writeFileSync(
      join(root, "AI_TODO.md"),
      "# AI Todo\n\n| ID | Priority | Actions | Depends | Group | Task description | Notes |\n|---|---|---|---|---|---|---|\n| TSK-000003-001 | High | | | GRP-000003 | A | |\n| TSK-000003-002 | High | | TSK-000003-001 | GRP-000003 | B | |\n",
    );
    const w = await waitingCounts(root, undefined, 3);
    // No approvals sidecar: two requests + two tasks wait for approval.
    expect(w).toEqual({ approval: 4, changeRequests: 3, answers: 0, dependencies: 0, blocked: 0, merge: 0 });
  });
});

describe("requestWaiting", () => {
  it("holds a request back until the request it depends on is taken in and all its rows are done", async () => {
    writeFileSync(
      join(root, "USER_TODO.md"),
      "# User Todo\n\n| ID | Group | Depends | Request |\n|---|---|---|---|\n| REQ-000014-003 | | REQ-000014-001 | Login |\n| REQ-000014-004 | | REQ-000014-003 | Lockout |\n",
    );
    writeFileSync(
      join(root, "AI_TODO.md"),
      "# AI Todo\n\n| ID | Priority | Actions | Depends | Group | Task description | Notes |\n|---|---|---|---|---|---|---|\n| TSK-000015-002 | High | | | 000015 | B | |\n",
    );
    writeFileSync(join(root, "AI_DONE.md"), "# AI Done\n\n| Timestamp | ID | Task description | Files | Notes |\n|---|---|---|---|---|\n| 2026-10-19 | TSK-000015-001 | A | | |\n");
    mkdirSync(join(root, ".4pm"), { recursive: true });
    writeFileSync(join(root, ".4pm/.autonomous.lineage.json"), JSON.stringify({ "000015": { source: "REQ-000014-001", request: "Seed", at: "" } }));
    let waiting = await requestWaiting(root);
    expect(waiting("REQ-000014-003")).toEqual([{ id: "TSK-000015-002", via: "REQ-000014-001" }]);
    expect(waiting("REQ-000014-004")).toEqual([{ id: "REQ-000014-003" }]);
    writeFileSync(join(root, "AI_TODO.md"), "# AI Todo\n\n| ID | Priority | Actions | Depends | Group | Task description | Notes |\n|---|---|---|---|---|---|---|\n");
    waiting = await requestWaiting(root);
    expect(waiting("REQ-000014-003")).toEqual([]);
  });
});
