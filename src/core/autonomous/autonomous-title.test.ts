/**
 * Tests of the book row `Title` in the cli: the column is added after `ID` before intake, kept and clamped on
 * rewrites, carried to AI_DONE, and never counted as a content edit.
 * @adr 0549
 */
import { describe, expect, it } from "vitest";
import { bookCellsContentEqual } from "@4pm/dto";
import * as B from "./autonomous-books";

const TODO = "| ID | Priority | Actions | Depends | Group | Task description | Notes |\n|---|---|---|---|---|---|---|\n| TSK-000001-001 | High | | | G | a | |\n";
const QA = "| ID | Group | Depends | Original request | Question / options | Answer |\n|---|---|---|---|---|---|\n| QA-000001-001 | G | | r | q? | |\n";
const DONE = "## Done\n\n| Timestamp | ID | Group | Depends | Task description | Files | Evidence | Notes |\n|---|---|---|---|---|---|---|---|\n";

describe("Title column", () => {
  it("is inserted right after ID before intake (rows unchanged)", () => {
    const md = B.withTitleColumns(TODO);
    expect(md).toContain("| ID | Title | Priority |");
    expect(B.parseTasks(md).tasks[0]).toMatchObject({ id: "TSK-000001-001", title: "", desc: "a" });
    expect(B.withTitleColumns(md)).toBe(md);
    expect(B.withTitleColumns(QA)).toContain("| ID | Title | Group |");
  });

  it("is written by writeTasks / writeQa and clamped to 80 chars", () => {
    const long = `${"x".repeat(90)}|y`;
    const { tasks } = B.parseTasks(TODO);
    const md = B.writeTasks(TODO, [{ ...tasks[0]!, title: long }]);
    expect(md).toContain("| ID | Title | Priority |");
    expect(B.parseTasks(md).tasks[0]?.title).toBe("x".repeat(80));
    const qa = B.writeQa(QA, [{ ...B.parseQa(QA).rows[0]!, title: "Which login?" }]);
    expect(B.parseQa(qa).rows[0]?.title).toBe("Which login?");
  });

  it("clamps the titles an agent wrote", () => {
    const md = B.withTitleColumns(TODO).replace("| TSK-000001-001 |  |", `| TSK-000001-001 | ${"y".repeat(100)} |`);
    expect(B.parseTasks(B.clampTitles(md)).tasks[0]?.title).toBe("y".repeat(80));
  });

  it("is carried to AI_DONE", () => {
    const md = B.appendDone(DONE, { id: "TSK-000001-001", title: "Login form", group: "G", depends: [], desc: "a", files: "", evidence: "", notes: "" });
    expect(md).toContain("| Timestamp | ID | Title | Group |");
    expect(md).toContain("| TSK-000001-001 | Login form | G |");
  });

  it("is metadata: a title edit is not a content change", () => {
    expect(bookCellsContentEqual({ "task description": "a", title: "x" }, { "task description": "a", title: "y" })).toBe(true);
  });
});
