/**
 * Tests of the project-mode steps of the engine: the security-review reply parser and its evidence, the automatic AI
 * Verify answers, the rows `auto` may approve, and the evidence-off prompt note.
 * @adr 0608
 */
import { describe, expect, it } from "vitest";
import { findingsText, parseSecurityReply, securityMarkdown } from "./autonomous-security";
import { applyVerifyAnswers, parseVerifyAnswers, verifyEntries } from "./autonomous-verify";
import { autoApprovableIds } from "./autonomous-auto-approve";
import { evidenceOffNote } from "./autonomous-cycle";

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

describe("evidence off", () => {
  it("adds the note only when the evidence phase is off", () => {
    expect(evidenceOffNote({ evidencePhase: true }, "intake")).toBe("");
    expect(evidenceOffNote({ evidencePhase: false }, "implement")).toContain("EVIDENCE OFF");
  });
});
