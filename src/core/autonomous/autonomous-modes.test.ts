/**
 * Tests of the project-mode steps of the engine: the security-review reply parser and its evidence, the automatic AI
 * Verify answers and the rows `auto` may approve.
 * @adr 0608
 */
import { describe, expect, it } from "vitest";
import { findingsText, parseSecurityReply, securityMarkdown } from "./autonomous-security";
import { applyVerifyAnswers, parseVerifyAnswers, parseVerifyFollowUps, verifyEntries } from "./autonomous-verify";
import { defaultAssignees } from "./autonomous-books";
import { autoApprovableIds } from "./autonomous-auto-approve";

const TODO = "| ID | Group | Depends | Task description |\n|---|---|---|---|\n| TSK-000001-001 | Login | | Add the login form |\n| TSK-000001-002 | Login | | Add the logout |\n";

describe("security review", () => {
  it("fails on a high finding whatever the stated verdict", () => {
    const v = parseSecurityReply('```json\n{"verdict":"pass","findings":[{"severity":"high","file":"a.ts","line":3,"issue":"SQL injection","fix":"bind"}]}\n```');
    expect(v?.verdict).toBe("fail");
    expect(findingsText(v!.findings)).toContain("a.ts:3");
  });

  it("passes with low findings and writes the evidence table", () => {
    const v = parseSecurityReply('{"verdict":"pass","findings":[{"severity":"low","file":"b.ts","issue":"x|y","fix":"z"}]}');
    expect(v?.verdict).toBe("pass");
    expect(securityMarkdown("TSK-000001-001", v!, "2026-10-23")).toContain("x\\|y");
  });

  it("returns null for an unusable reply", () => {
    expect(parseSecurityReply("no json here")).toBeNull();
    expect(parseSecurityReply('{"verdict":"maybe"}')).toBeNull();
  });
});

describe("automatic AI verify", () => {
  it("builds entries, parses answers + follow-ups and fills the AI verify column", () => {
    expect(verifyEntries(TODO, ["TSK-000001-002"])).toBe("[TSK-000001-002] Group: Login · Task description: Add the logout");
    const answers = parseVerifyAnswers("[TSK-000001-001] OK\nFOLLOWUP [TSK-000001-001] add a test\n[TSK-999999-001] other", ["TSK-000001-001"]);
    expect(answers).toEqual({ "TSK-000001-001": "🤖 OK — follow-up: add a test" });
    const md = applyVerifyAnswers(TODO, answers);
    expect(md).toContain("| AI verify |");
    expect(md).toContain("| 🤖 OK — follow-up: add a test |");
  });
});

describe("automatic approvals", () => {
  it("lists requests and AI Todo rows without an approval, never questions", () => {
    const books = {
      userTodo: "| ID | Group | Depends | Request |\n|---|---|---|---|\n| REQ-000002-001 | | | Do it |\n",
      userQa: "| ID | Question | Answer |\n|---|---|---|\n| QA-000001-001 | Why? | |\n",
      aiTodo: TODO,
    };
    expect(autoApprovableIds(books, {})).toEqual(["REQ-000002-001", "TSK-000001-001", "TSK-000001-002"]);
  });
});

describe("follow-up proposals", () => {
  it("keeps the FOLLOWUP lines per row", () => {
    expect(parseVerifyFollowUps("[TSK-000001-001] OK\nFOLLOWUP [TSK-000001-001] add a test\nFOLLOWUP [TSK-000001-001] fix logout", ["TSK-000001-001"])).toEqual({
      "TSK-000001-001": ["add a test", "fix logout"],
    });
  });
});

describe("default assignees", () => {
  const me = "11111111-2222-3333-4444-555555555555";
  it("assigns a new row without assignee to its requester, keeps old rows and set assignees", () => {
    const next = TODO + "| TSK-000001-003 | Login | | Add remember me |\n";
    const out = defaultAssignees(TODO, next, me);
    expect(out).toContain("| Assignees |");
    expect(out).toMatch(/TSK-000001-003.*11111111-2222-3333-4444-555555555555/);
    expect(out).not.toMatch(/TSK-000001-001.*11111111/);
  });
  it("leaves the book unchanged for a non-user writer", () => {
    expect(defaultAssignees(TODO, TODO + "| TSK-000001-003 | Login | | x |\n", "auto")).toBe(TODO + "| TSK-000001-003 | Login | | x |\n");
  });
});
