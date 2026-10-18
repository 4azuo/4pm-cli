/**
 * Team-scoped books, party approvals and the discussion file format:
 * the `Team` column round-trips and is added on demand, served-team filtering, party merge / unapprove,
 * and render ↔ parse of a discussion file.
 * @adr 0450 @adr 0451 @adr 0454
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { approvalRowCanonical, parseDiscussionFile, renderDiscussionFile, type ApprovalPartyEntry } from "@4pm/dto";
import { parseTasks, writeTasks } from "./autonomous-books";
import { resetServedTeamsForTest, servesTeam, setServedTeams } from "./autonomous-teams";
import { mergeApprovalWrite, unapproveIds } from "./autonomous-approvals";

const TODO = `# AI Todo

| ID | Priority | Tag | Depends | Group | Task description | Notes |
|---|---|---|---|---|---|---|
| TSK-000001-001 | High | | | GRP-000001 | Add login | |
`;

describe("Team column", () => {
  it("is added after ID the first time a task carries a team, and read back", () => {
    const { tasks } = parseTasks(TODO);
    const next = writeTasks(TODO, [{ ...tasks[0]!, team: "FE" }]);
    expect(next).toContain("| ID | Team | Priority |");
    expect(parseTasks(next).tasks[0]!.team).toBe("FE");
  });

  it("joins the approval hash only when non-empty", () => {
    const untagged = approvalRowCanonical(TODO, "TSK-000001-001");
    const tagged = approvalRowCanonical(writeTasks(TODO, [{ ...parseTasks(TODO).tasks[0]!, team: "FE" }]), "TSK-000001-001");
    const emptyTeam = approvalRowCanonical(writeTasks(TODO, [{ ...parseTasks(TODO).tasks[0]!, team: "" }]), "TSK-000001-001");
    expect(untagged).toBe(emptyTeam);
    expect(tagged).toBe(`${untagged}\u0001team:FE`);
  });
});

describe("served teams", () => {
  let dir = "";
  afterEach(() => {
    resetServedTeamsForTest();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("serves every row when unrestricted, only its teams (never untagged) otherwise", () => {
    dir = mkdtempSync(join(tmpdir(), "teams-"));
    setServedTeams(null, dir);
    expect(servesTeam(dir, "")).toBe(true);
    setServedTeams(["FE"], dir);
    expect(servesTeam(dir, "FE")).toBe(true);
    expect(servesTeam(dir, "BE")).toBe(false);
    expect(servesTeam(dir, "")).toBe(false);
    resetServedTeamsForTest();
    expect(servesTeam(dir, "FE")).toBe(true); // persisted in the profile dir
  });
});

describe("party approvals", () => {
  const books = { userTodo: "", userQa: "", aiTodo: TODO };
  const h = `sha256:${"0".repeat(64)}`;

  it("refuses a party bound to other content", () => {
    const party: ApprovalPartyEntry = { by: "u1", group: "teamLead", at: "t", h };
    expect(mergeApprovalWrite({}, {}, { "TSK-000001-001": [party] }, books)).toEqual({ ok: false, staleId: "TSK-000001-001" });
  });

  it("drops only the caller's parties (and the final) on a partial unapprove", () => {
    const map: Record<string, unknown> = {
      "TSK-000001-001": { approved: true, by: "u2", at: "t", parties: [{ by: "u1", group: "teamLead" }, { by: "u2", group: "client" }] },
    };
    unapproveIds(map, ["TSK-000001-001"], "u1", false);
    expect(map["TSK-000001-001"]).toEqual({ parties: [{ by: "u2", group: "client" }] });
    unapproveIds(map, ["TSK-000001-001"], "u9", true);
    expect(map["TSK-000001-001"]).toBeUndefined();
  });
});

describe("discussion file", () => {
  it("renders and parses back the same discussion", () => {
    const file = {
      code: "DSC-20261011-0001",
      title: "Which SSO providers?",
      team: "FE",
      links: ["REQ-000001-001"],
      status: "resolved" as const,
      author: { id: "a1", label: "Acme", kind: "client" as const },
      createdAt: "2026-10-11T08:00:00.000Z",
      resolvedBy: "a1",
      resolvedAt: "2026-10-11T09:00:00.000Z",
      tags: ["auth", "urgent"],
      due: "2026-10-30",
      mentions: ["p1"],
      issues: ["jira:AUTH-1"],
      messages: [
        { id: "m1", by: "a1", label: "Acme \"QA\"", kind: "client" as const, at: "2026-10-11T08:00:00.000Z", body: "Google and Microsoft?\n\nOr only Google?" },
        { id: "m2", by: "p1", label: "PM", kind: "member" as const, at: "2026-10-11T08:20:00.000Z", body: "", deleted: "2026-10-11T08:30:00.000Z" },
      ],
    };
    expect(parseDiscussionFile(renderDiscussionFile(file))).toEqual(file);
  });
});
