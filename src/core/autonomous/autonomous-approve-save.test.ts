/**
 * Tests for a book save that carries approvals (option B of ADR-0438) on a project with no remote base
 * (the working-tree path): the editor of a row counts as its author for separation of duties, ADMIN may
 * approve its own edit, and a signed entry for other content is refused as stale — nothing written.
 * @adr 0438 @adr 0320
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeAutonomous } from "./autonomous";
import { resetApprovalTrustForTest } from "./autonomous-approvals";

const HEAD = "| ID | Group | Depends | Request |\n|---|---|---|---|\n";
const BEFORE = `${HEAD}| REQ-0001-0001 | 0001 | | Add login |\n`;
const AFTER = `${HEAD}| REQ-0001-0001 | 0001 | | Add login with SSO |\n`;

let root: string;
let profileDir: string;

/** Read a project JSON file. */
function json(rel: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, rel), "utf8")) as Record<string, unknown>;
}

beforeEach(() => {
  resetApprovalTrustForTest();
  root = mkdtempSync(join(tmpdir(), "4pm-save-"));
  profileDir = mkdtempSync(join(tmpdir(), "4pm-prof-"));
  mkdirSync(join(root, ".claude"));
  writeFileSync(join(root, "USER_TODO.md"), BEFORE);
  writeFileSync(join(root, ".claude/.autonomous.authors.json"), JSON.stringify({ "REQ-0001-0001": { by: "writer" } }));
  writeFileSync(join(root, ".claude/.autonomous.approvals.json"), "{}");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(profileDir, { recursive: true, force: true });
});

describe("bookSave with approvals", () => {
  it("blocks a non-ADMIN approving a row they just edited, writing nothing", async () => {
    const r = await writeAutonomous(root, profileDir, { kind: "bookSave", book: "userTodo", content: AFTER, approve: ["REQ-0001-0001"], by: "editor" }, "editor");
    expect(r).toMatchObject({ ok: false, code: "APPROVAL_SELF", failedId: "REQ-0001-0001" });
    expect(readFileSync(join(root, "USER_TODO.md"), "utf8")).toBe(BEFORE);
    expect(json(".claude/.autonomous.approvals.json")).toEqual({});
  });

  it("lets a non-author approve an unedited row and an ADMIN approve their own edit", async () => {
    const ok = await writeAutonomous(root, profileDir, { kind: "bookSave", book: "userTodo", content: BEFORE, approve: ["REQ-0001-0001"], by: "reviewer" }, "reviewer");
    expect(ok.ok).toBe(true);
    expect(json(".claude/.autonomous.approvals.json")["REQ-0001-0001"]).toMatchObject({ approved: true, by: "reviewer" });
    const admin = await writeAutonomous(
      root,
      profileDir,
      { kind: "bookSave", book: "userTodo", content: AFTER, approve: ["REQ-0001-0001"], by: "editor", byIsAdmin: true },
      "editor",
    );
    expect(admin.ok).toBe(true);
    expect(readFileSync(join(root, "USER_TODO.md"), "utf8")).toBe(AFTER);
  });

  it("refuses a signed entry whose hash is for other content (stale)", async () => {
    const signed = { "REQ-0001-0001": { approved: true as const, by: "reviewer", at: "t", h: `sha256:${"0".repeat(64)}`, kid: "k", sig: "ed25519:AA==" } };
    const r = await writeAutonomous(
      root,
      profileDir,
      { kind: "bookSave", book: "userTodo", content: BEFORE, approve: ["REQ-0001-0001"], signed, by: "reviewer" },
      "reviewer",
    );
    expect(r).toMatchObject({ ok: false, code: "APPROVAL_STALE", failedId: "REQ-0001-0001" });
    expect(json(".claude/.autonomous.approvals.json")).toEqual({});
  });
});
