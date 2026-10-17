/**
 * Tests of the web book-save row guards and the unapprove helpers.
 */
import { describe, expect, it } from "vitest";
import { checkRowGuards } from "./autonomous-row-guards";
import { previousTaskText, stillApproved, type LocalClaim } from "./autonomous-tasks";

const head = "| ID | Team | Priority | Depends | Group | Task description |\n|---|---|---|---|---|---|\n";
const T1 = "| TSK-000001-001 | | High | | G | a |\n";
const T2 = "| TSK-000001-002 | | High | TSK-000001-001 | G | b |\n";
const TTL = { claimTtlHours: 6, runTimeoutMinutes: 60 };

describe("checkRowGuards", () => {
  it("refuses deleting a row another row depends on", () => {
    const prev = head + T1 + T2;
    const next = head + T2;
    expect(checkRowGuards(prev, next, [next], "", TTL)).toEqual({
      code: "BOOK_ROW_HAS_DEPENDENTS",
      failedId: "TSK-000001-001",
      blockers: ["TSK-000001-002"],
    });
  });

  it("allows deleting a row with its dependent in the same save", () => {
    const prev = head + T1 + T2;
    expect(checkRowGuards(prev, head, [head], "", TTL)).toBeNull();
  });

  it("refuses editing a row under a live intake claim", () => {
    const req = "| ID | Group | Depends | Request |\n|---|---|---|---|\n| REQ-000002-001 | | | do x |\n";
    const edited = req.replace("do x", "do y");
    const stamp = new Date(Date.now() - 5 * 60_000).toISOString().slice(0, 16).replace("T", " ");
    const progress = `| Started | ID | Team | Worker | Claim | Attempt | Task description |\n|---|---|---|---|---|---|---|\n| ${stamp} | REQ-000002-001 | | w1 | c | 1 | Intake |\n`;
    expect(checkRowGuards(req, edited, [edited], progress, TTL)).toEqual({ code: "BOOK_ROW_CLAIMED", failedId: "REQ-000002-001", blockers: ["w1"] });
  });
});

describe("unapprove helpers", () => {
  it("reads a withdrawn approval as lost and an unreadable sidecar as unknown", () => {
    const entry = { approved: true, by: "u1", at: "2026-10-17T00:00:00Z" };
    expect(stillApproved(JSON.stringify({ "TSK-1": entry }), "TSK-1")).toBe(true);
    expect(stillApproved("{}", "TSK-1")).toBe(false);
    expect(stillApproved("", "TSK-1")).toBeNull();
  });

  it("reports the previous task text only when a person changed it", () => {
    const task = { id: "TSK-1", priority: "", tag: "", depends: [], group: "G", desc: "new", notes: "n" };
    const base = { id: "TSK-1", claim: "c", worker: "w", started: "", attempt: 2, branch: "b", base: "main", task } as LocalClaim;
    expect(previousTaskText({ ...base, prevTask: { ...task, notes: "n; attempt 1 ended: boom; WIP on b" } })).toBe("");
    expect(previousTaskText({ ...base, prevTask: { ...task, desc: "old" } })).toContain("old");
  });
});
