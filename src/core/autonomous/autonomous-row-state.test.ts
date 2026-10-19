/**
 * USER_TODO / USER_QA row `State`: history rows are hidden from the intake agent and put back with the rows it took
 * in, open-row helpers skip them, finished requests become `Done`, and a web save may not touch a history row.
 * @adr 0562
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as B from "./autonomous-books";
import { checkRowGuards } from "./autonomous-row-guards";
import { markDoneRows } from "./autonomous-tasks";

const TODO = `# User Todo

| ID | Title | Group | Depends | Request | State |
|---|---|---|---|---|---|
| REQ-000014-001 | Seed | | | seed roles | Taken in |
| REQ-000014-002 | Login | | | login form | |
| REQ-000014-003 | Menu | | | a menu | |
`;
const TTL = { claimTtlHours: 6, runTimeoutMinutes: 60 };

describe("row State helpers", () => {
  it("lists open ids only and strips history rows", () => {
    expect(B.openRowIds(TODO, "REQ-")).toEqual(["REQ-000014-002", "REQ-000014-003"]);
    expect(B.stripStateRows(TODO)).not.toContain("REQ-000014-001");
    expect(B.stripStateRows(TODO)).toContain("REQ-000014-002");
  });

  it("adds the State column when setting a state on a book without one", () => {
    const plain = "| ID | Request |\n|---|---|\n| REQ-000001-001 | a |\n";
    const next = B.setRowStates(plain, new Map([["REQ-000001-001", "Done"]]));
    expect(B.findTables(next)[0]!.header).toEqual(["ID", "Request", "State"]);
    expect(B.openRowIds(next, "REQ-")).toEqual([]);
    expect(B.setRowStates(next, new Map([["REQ-000001-001", "Done"]]))).toBe(next);
  });

  it("keeps a question's State through writeQa", () => {
    const qa = "| ID | Group | Depends | Original request | Question / options | Answer |\n|---|---|---|---|---|---|\n| QA-000001-001 | | | o | q | a |\n";
    const rows = B.parseQa(qa).rows.map((q) => ({ ...q, state: "Done" }));
    const next = B.writeQa(qa, rows);
    expect(B.parseQa(next).rows[0]!.state).toBe("Done");
    expect(B.parseQa(next).rows.filter(B.qaOpen)).toEqual([]);
  });
});

describe("history row guard", () => {
  it("refuses editing or deleting a history row and setting a State from a save", () => {
    const edited = TODO.replace("seed roles", "seed more");
    expect(checkRowGuards(TODO, edited, [edited], "", TTL)?.code).toBe("BOOK_ROW_HISTORY");
    const removed = TODO.replace(/\| REQ-000014-001 .*\n/, "");
    expect(checkRowGuards(TODO, removed, [removed], "", TTL)?.code).toBe("BOOK_ROW_HISTORY");
    const forged = TODO.replace("| a menu | |", "| a menu | Done |");
    expect(checkRowGuards(TODO, forged, [forged], "", TTL)).toMatchObject({ code: "BOOK_ROW_HISTORY", failedId: "REQ-000014-003" });
    const open = TODO.replace("login form", "login form v2");
    expect(checkRowGuards(TODO, open, [open], "", TTL)).toBeNull();
  });
});

describe("markDoneRows", () => {
  let root = "";
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "row-state-"));
    writeFileSync(join(root, "USER_TODO.md"), TODO);
    writeFileSync(join(root, "USER_QA.md"), "| ID | Group | Depends | Original request | Question / options | Answer |\n|---|---|---|---|---|---|\n");
    writeFileSync(join(root, "AI_DONE.md"), "| Timestamp | ID | Task description | Files | Notes |\n|---|---|---|---|---|\n| t | TSK-000015-001 | a | | |\n");
    mkdirSync(join(root, ".4pm"), { recursive: true });
    writeFileSync(join(root, ".4pm/.autonomous.lineage.json"), JSON.stringify({ "000015": { source: "REQ-000014-001", request: "seed", at: "" } }));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("marks a taken-in request Done once its groups have no open row", async () => {
    writeFileSync(join(root, "AI_TODO.md"), "| ID | Priority | Actions | Depends | Group | Task description | Notes |\n|---|---|---|---|---|---|---|\n| TSK-000015-002 | High | | | 000015 | b | |\n");
    expect(await markDoneRows(root)).toBe(false);
    writeFileSync(join(root, "AI_TODO.md"), "| ID | Priority | Actions | Depends | Group | Task description | Notes |\n|---|---|---|---|---|---|---|\n");
    expect(await markDoneRows(root)).toBe(true);
    expect(readFileSync(join(root, "USER_TODO.md"), "utf8")).toContain("| REQ-000014-001 | Seed |  |  | seed roles | Done |");
    expect(await markDoneRows(root)).toBe(false);
  });

  it("keeps a request Taken in while a task of it is in the trash, and reopens a Done one when the task comes back", async () => {
    const head = "| ID | Priority | Actions | Depends | Group | Task description | Notes |\n|---|---|---|---|---|---|---|\n";
    const trash = `\n<!-- 4pm:todo-trash {"retentionHours":24,"items":[{"id":"TSK-000015-002","deletedAt":"${new Date().toISOString()}"}]} -->\n`;
    writeFileSync(join(root, "AI_TODO.md"), head + trash);
    expect(await markDoneRows(root)).toBe(false);
    writeFileSync(join(root, "AI_TODO.md"), head);
    expect(await markDoneRows(root)).toBe(true);
    // Restored: the row is back in AI_TODO.
    writeFileSync(join(root, "AI_TODO.md"), `${head}| TSK-000015-002 | High | | | 000015 | b | |\n`);
    expect(await markDoneRows(root)).toBe(true);
    expect(readFileSync(join(root, "USER_TODO.md"), "utf8")).toContain("| seed roles | Taken in |");
  });
});
