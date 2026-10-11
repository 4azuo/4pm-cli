/**
 * Tests for row-level book saves on a project with no remote base (the working-tree path): a patch
 * merges onto rows another writer changed meanwhile, a row both sides changed refuses the whole save with
 * `BOOK_CONFLICT`, a whole-file save from an older version is `BOOK_STALE`, and a posted request takes the
 * server-given id.
 * @adr 0455
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bookContentHash, diffBook } from "@4pm/dto";
import { writeAutonomous } from "./autonomous";

const HEAD = "# User todo\n\n| ID | Group | Depends | Request |\n|---|---|---|---|\n";
const A = "REQ-000001-001";
const B = "REQ-000002-001";
const BASE = `${HEAD}| ${A} | | | Add login |\n| ${B} | | | Add logout |\n`;

let root: string;
let profileDir: string;

/** The current USER_TODO. */
function book(): string {
  return readFileSync(join(root, "USER_TODO.md"), "utf8");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "4pm-patch-"));
  profileDir = mkdtempSync(join(tmpdir(), "4pm-prof-"));
  mkdirSync(join(root, ".claude"));
  writeFileSync(join(root, "USER_TODO.md"), BASE);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(profileDir, { recursive: true, force: true });
});

describe("bookSave patch", () => {
  it("merges my edit with another writer's edit of a different row", async () => {
    writeFileSync(join(root, "USER_TODO.md"), BASE.replace("Add logout", "Add logout everywhere"));
    const patch = diffBook(BASE, BASE.replace("Add login", "Add login with SSO"))!;
    const r = await writeAutonomous(root, profileDir, { kind: "bookSave", book: "userTodo", patch, by: "u1" }, "u1");
    expect(r.ok).toBe(true);
    expect(book()).toContain("Add login with SSO");
    expect(book()).toContain("Add logout everywhere");
  });

  it("refuses a row both sides changed, writing nothing", async () => {
    const theirs = BASE.replace("Add login", "Add login with passkeys");
    writeFileSync(join(root, "USER_TODO.md"), theirs);
    const patch = diffBook(BASE, BASE.replace("Add login", "Add login with SSO"))!;
    const r = await writeAutonomous(root, profileDir, { kind: "bookSave", book: "userTodo", patch, by: "u1" }, "u1");
    expect(r).toMatchObject({ ok: false, code: "BOOK_CONFLICT", conflicts: [{ id: A, kind: "changed" }] });
    expect(book()).toBe(theirs);
  });

  it("refuses a whole-file save edited from an older version", async () => {
    const baseHash = bookContentHash(BASE);
    writeFileSync(join(root, "USER_TODO.md"), BASE.replace("Add logout", "Changed"));
    const r = await writeAutonomous(root, profileDir, { kind: "bookSave", book: "userTodo", content: BASE, baseHash, by: "u1" }, "u1");
    expect(r).toMatchObject({ ok: false, code: "BOOK_STALE" });
  });
});

describe("userTodo", () => {
  it("appends the posted request under the server-given id", async () => {
    const id = "REQ-000042-001";
    const r = await writeAutonomous(root, profileDir, { kind: "userTodo", content: "Export to CSV", id, by: "c1" }, "c1");
    expect(r).toMatchObject({ ok: true, addedIds: [id] });
    expect(book()).toContain(`| ${id} |`);
  });

  it("refuses a missing or taken id", async () => {
    expect((await writeAutonomous(root, profileDir, { kind: "userTodo", content: "x", by: "c1" }, "c1")).ok).toBe(false);
    expect((await writeAutonomous(root, profileDir, { kind: "userTodo", content: "x", id: A, by: "c1" }, "c1")).ok).toBe(false);
  });
});
