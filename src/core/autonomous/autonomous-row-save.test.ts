/**
 * Tests of the book-save row rules on a project with no remote base (the working-tree path): a delete with
 * dependents is refused, a delete drops the row's approval, a row under a live intake claim is locked, and
 * `taskRetry` releases a conflict-blocked task.
 * @adr 0538 @adr 0539
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { diffBook } from "@4pm/dto";
import { writeAutonomous } from "./autonomous";

const HEAD = "| ID | Group | Depends | Request |\n|---|---|---|---|\n";
const A = "REQ-000001-001";
const B = "REQ-000002-001";
const BASE = `${HEAD}| ${A} | | | Add login |\n| ${B} | | ${A} | Add logout |\n`;
const APPROVALS = ".4pm/.autonomous.approvals.json";

let root: string;
let profileDir: string;

/** A file under the project root. */
function read(rel: string): string {
  return readFileSync(join(root, rel), "utf8");
}

/** A UTC books stamp `minutes` ago. */
function stamp(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString().slice(0, 16).replace("T", " ");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "4pm-rows-"));
  profileDir = mkdtempSync(join(tmpdir(), "4pm-prof-"));
  mkdirSync(join(root, ".4pm"), { recursive: true });
  writeFileSync(join(root, "USER_TODO.md"), BASE);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(profileDir, { recursive: true, force: true });
});

describe("book-save row rules", () => {
  it("refuses deleting a row another row depends on", async () => {
    const patch = diffBook(BASE, BASE.replace(`| ${A} | | | Add login |\n`, ""))!;
    const r = await writeAutonomous(root, profileDir, { kind: "bookSave", book: "userTodo", patch, by: "u1" }, "u1");
    expect(r).toMatchObject({ ok: false, code: "BOOK_ROW_HAS_DEPENDENTS", failedId: A, blockers: [B] });
    expect(read("USER_TODO.md")).toBe(BASE);
  });

  it("drops the approval of a deleted row", async () => {
    writeFileSync(join(root, APPROVALS), JSON.stringify({ [B]: { approved: true, by: "u2", at: "2026-10-17T00:00:00Z" } }));
    const patch = diffBook(BASE, BASE.replace(`| ${B} | | ${A} | Add logout |\n`, ""))!;
    const r = await writeAutonomous(root, profileDir, { kind: "bookSave", book: "userTodo", patch, by: "u1" }, "u1");
    expect(r.ok).toBe(true);
    expect(JSON.parse(read(APPROVALS))).toEqual({});
  });

  it("locks a row under a live intake claim", async () => {
    writeFileSync(
      join(root, "AI_PROGRESS.md"),
      `| Started | ID | Team | Worker | Claim | Attempt | Task description |\n|---|---|---|---|---|---|---|\n| ${stamp(5)} | ${A} | | w1 | c1 | 1 | Intake |\n`,
    );
    const patch = diffBook(BASE, BASE.replace("Add login", "Add login with SSO"))!;
    const r = await writeAutonomous(root, profileDir, { kind: "bookSave", book: "userTodo", patch, by: "u1" }, "u1");
    expect(r).toMatchObject({ ok: false, code: "BOOK_ROW_CLAIMED", failedId: A, blockers: ["w1"] });
  });

  it("releases a conflict-blocked task on taskRetry, and refuses an unblocked one", async () => {
    const attempts = ".4pm/.autonomous.attempts.json";
    const blocked = { count: 0, last: "", at: "", blocked: { reason: "merge-conflict", at: "x", base: "b", head: "h" } };
    writeFileSync(join(root, attempts), JSON.stringify({ "TSK-000003-001": blocked }));
    const ok = await writeAutonomous(root, profileDir, { kind: "taskRetry", taskId: "TSK-000003-001", by: "u1" }, "u1");
    expect(ok.ok).toBe(true);
    expect(JSON.parse(read(attempts))["TSK-000003-001"].blocked).toBeUndefined();
    const again = await writeAutonomous(root, profileDir, { kind: "taskRetry", taskId: "TSK-000003-001", by: "u1" }, "u1");
    expect(again.ok).toBe(false);
  });
});
