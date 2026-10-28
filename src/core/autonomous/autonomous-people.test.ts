/**
 * Tests for naming people on the host: the members' accounts stay in memory (never in the policy file) and only
 * well-formed ones are kept; the setting gates the step; trailers are appended only for linked people; the
 * privileged token scopes are gated. @adr 0671 @adr 0672
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hostPeople, loadAutonomousPolicy, resetAutonomousPolicyForTest, setAutonomousPolicy } from "./autonomous-policy";
import { hostPeopleAllowed, withCoAuthors, withPeopleLine } from "./autonomous-people";
import { closePrivilegedScope, openPrivilegedScope, socketMayServe } from "../git/git-auth";

const U1 = "11111111-1111-4111-8111-111111111111";
const acct = { provider: "github", host: "github.com", login: "4azuo", providerUserId: "12345678" };

describe("host people", () => {
  let dir: string;
  beforeEach(() => {
    resetAutonomousPolicyForTest();
    dir = mkdtempSync(join(tmpdir(), "4pm-people-"));
    loadAutonomousPolicy(dir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("keeps the accounts in memory only and drops malformed ones", () => {
    setAutonomousPolicy({
      projectEnabled: true,
      allowed: true,
      settings: {},
      gitAccounts: { [U1]: [acct, { ...acct, login: "-rf" }], "not-a-uuid": [acct] },
      pmUserIds: [U1, "x"],
    });
    expect(hostPeople().accounts).toEqual({ [U1]: [acct] });
    expect(hostPeople().pmUserIds).toEqual([U1]);
    const file = readFileSync(join(dir, "autonomous.policy.json"), "utf8");
    expect(file).not.toContain("gitAccounts");
    expect(file).not.toContain("4azuo");
  });

  it("the setting gates the step", async () => {
    expect(await hostPeopleAllowed("off", "https://github.com/o/r.git")).toBe(false);
    expect(await hostPeopleAllowed("on", "https://github.com/o/r.git")).toBe(true);
  });

  it("appends trailers and the requested-by line only when someone is linked", () => {
    const none = { coAuthors: [], assignees: [], reviewers: [], line: "" };
    expect(withCoAuthors("feat(TSK-1): x", none)).toBe("feat(TSK-1): x");
    expect(withPeopleLine("body", none)).toBe("body");
    const one = { coAuthors: [acct as never], assignees: ["4azuo"], reviewers: [], line: "assigned to @4azuo" };
    expect(withCoAuthors("feat(TSK-1): x", one)).toBe("feat(TSK-1): x\n\nCo-authored-by: 4azuo <12345678+4azuo@users.noreply.github.com>");
    expect(withPeopleLine("body", one)).toBe("body\n\nassigned to @4azuo");
  });

  it("privileged scopes reach the token sockets only while the cli runs them (ADR-0672)", () => {
    expect(socketMayServe("job-1")).toBe(true);
    expect(socketMayServe("pr-people:abc")).toBe(false);
    expect(socketMayServe("ci-propose:abc")).toBe(false);
    openPrivilegedScope("ci-propose:abc");
    expect(socketMayServe("ci-propose:abc")).toBe(true);
    expect(socketMayServe("ci-propose:other")).toBe(false);
    closePrivilegedScope("ci-propose:abc");
    expect(socketMayServe("ci-propose:abc")).toBe(false);
  });
});
