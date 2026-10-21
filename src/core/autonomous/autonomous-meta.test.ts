/**
 * Tests of the book metadata in the cli: AI_TODO's `Actions` column, `Tags` / `Due` kept on
 * rewrites, `Assignees` kept on rewrites, and metadata-only edits allowed on a row under a live claim.
 * @adr 0543 @adr 0585
 */
import { describe, expect, it } from "vitest";
import * as B from "./autonomous-books";
import { checkRowGuards } from "./autonomous-row-guards";

const TODO = "| ID | Priority | Actions | Depends | Group | Task description | Notes |\n|---|---|---|---|---|---|---|\n| TSK-000001-001 | High | UpdateSpecFromDB | | G | a | |\n";
const TTL = { claimTtlHours: 6, runTimeoutMinutes: 60 };

describe("AI_TODO Actions column", () => {
  it("keeps Tags / Due through a rewrite and adds the columns when needed", () => {
    const { tasks } = B.parseTasks(TODO);
    const md = B.writeTasks(TODO, [{ ...tasks[0]!, tags: "billing", due: "2026-11-01" }]);
    expect(md).toContain("| ID | Tags | Due | Priority | Actions |");
    const again = B.parseTasks(B.writeTasks(md, B.parseTasks(md).tasks));
    expect(again.tasks[0]).toMatchObject({ tags: "billing", due: "2026-11-01", tag: "UpdateSpecFromDB" });
  });

  it("keeps Assignees through a rewrite, after Due", () => {
    const id = "0b6f6c1e-2d1a-4c55-9e1f-3a9c1b2d4e5f";
    const { tasks } = B.parseTasks(TODO);
    const md = B.writeTasks(TODO, [{ ...tasks[0]!, tags: "billing", assignees: id }]);
    expect(md).toContain("| ID | Tags | Due | Assignees | Priority |");
    const again = B.parseTasks(B.writeTasks(md, B.parseTasks(md).tasks));
    expect(again.tasks[0]).toMatchObject({ tags: "billing", assignees: id });
  });
});

describe("metadata on a claimed row", () => {
  const req = "| ID | Group | Depends | Request | Tags | Due |\n|---|---|---|---|---|---|\n| REQ-000002-001 | | | do x | | |\n";
  const stamp = new Date(Date.now() - 5 * 60_000).toISOString().slice(0, 16).replace("T", " ");
  const progress = `| Started | ID | Team | Worker | Claim | Attempt | Task description |\n|---|---|---|---|---|---|---|\n| ${stamp} | REQ-000002-001 | | w1 | c | 1 | Intake |\n`;

  it("allows changing only Tags / Due", () => {
    const next = req.replace("| do x | | |", "| do x | billing | 2026-11-01 |");
    expect(checkRowGuards(req, next, [next], progress, TTL)).toBeNull();
  });

  it("allows changing only Assignees", () => {
    const withCol = req.replace("| Tags | Due |\n|---|---|---|---|---|---|", "| Tags | Due | Assignees |\n|---|---|---|---|---|---|---|").replace("| do x | | |", "| do x | | | |");
    const next = withCol.replace("| do x | | | |", "| do x | | | 0b6f6c1e-2d1a-4c55-9e1f-3a9c1b2d4e5f |");
    expect(checkRowGuards(withCol, next, [next], progress, TTL)).toBeNull();
  });

  it("still refuses a content edit", () => {
    const next = req.replace("do x", "do y");
    expect(checkRowGuards(req, next, [next], progress, TTL)?.code).toBe("BOOK_ROW_CLAIMED");
  });
});
