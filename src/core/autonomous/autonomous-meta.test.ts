/**
 * Tests of the book metadata in the cli: AI_TODO's `Actions` column (renamed from `Tag`), `Tags` / `Due` kept on
 * rewrites, and metadata-only edits allowed on a row under a live claim.
 * @adr 0543
 */
import { describe, expect, it } from "vitest";
import * as B from "./autonomous-books";
import { checkRowGuards } from "./autonomous-row-guards";

const LEGACY = "| ID | Priority | Tag | Depends | Group | Task description | Notes |\n|---|---|---|---|---|---|---|\n| TSK-000001-001 | High | UpdateSpecFromDB | | G | a | |\n";
const TTL = { claimTtlHours: 6, runTimeoutMinutes: 60 };

describe("AI_TODO Actions column", () => {
  it("reads a legacy Tag header and renames it on upgrade", () => {
    expect(B.hasLegacyTagHeader(LEGACY)).toBe(true);
    expect(B.parseTasks(LEGACY).tasks[0]?.tag).toBe("UpdateSpecFromDB");
    const up = B.upgradeTasksHeader(LEGACY);
    expect(up).toContain("| ID | Priority | Actions | Depends |");
    expect(B.hasLegacyTagHeader(up)).toBe(false);
    expect(B.parseTasks(up).tasks[0]?.tag).toBe("UpdateSpecFromDB");
  });

  it("keeps Tags / Due through a rewrite and adds the columns when needed", () => {
    const { tasks } = B.parseTasks(LEGACY);
    const md = B.writeTasks(LEGACY, [{ ...tasks[0]!, tags: "billing", due: "2026-11-01" }]);
    expect(md).toContain("| ID | Tags | Due | Priority | Actions |");
    const again = B.parseTasks(B.writeTasks(md, B.parseTasks(md).tasks));
    expect(again.tasks[0]).toMatchObject({ tags: "billing", due: "2026-11-01", tag: "UpdateSpecFromDB" });
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

  it("still refuses a content edit", () => {
    const next = req.replace("do x", "do y");
    expect(checkRowGuards(req, next, [next], progress, TTL)?.code).toBe("BOOK_ROW_CLAIMED");
  });
});
