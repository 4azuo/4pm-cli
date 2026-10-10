/**
 * Tests for the agent secret-path deny rules: every claude run denies Read+Edit on
 * the fixed credential locations and on each configured AI profile dir (anchored with `//`), keeps
 * the served workspaces readable, and non-claude CLIs get no `--settings` args.
 * @adr 0347 @adr 0430
 */
import { describe, expect, it } from "vitest";
import { agentDenyRules, denySettingsArgs } from "./agent-deny";

describe("agentDenyRules", () => {
  it("denies Read and Edit on the fixed home secrets", () => {
    const rules = agentDenyRules();
    for (const p of ["~/.4pm/profiles/**", "~/.ssh/**", "~/.git-credentials", "~/.claude*/**"]) {
      expect(rules).toContain(`Read(${p})`);
      expect(rules).toContain(`Edit(${p})`);
    }
  });

  it("never denies the served workspaces (the agent's own project)", () => {
    expect(agentDenyRules().some((r) => r.includes("workspaces"))).toBe(false);
    expect(agentDenyRules()).not.toContain("Read(~/.4pm/**)");
  });

  it("adds each profile dir as a root-anchored rule, dropping blanks and duplicates", () => {
    const rules = agentDenyRules(["/srv/ai/claude-2/", null, " ", undefined, "/srv/ai/claude-2"]);
    expect(rules.filter((r) => r === "Read(//srv/ai/claude-2/**)")).toHaveLength(1);
    expect(rules).toContain("Edit(//srv/ai/claude-2/**)");
  });
});

describe("denySettingsArgs", () => {
  it("passes the rules as a single --settings JSON value for claude (also by path)", () => {
    const args = denySettingsArgs("/usr/local/bin/claude", ["/p"]);
    expect(args[0]).toBe("--settings");
    expect(args).toHaveLength(2);
    const parsed = JSON.parse(args[1]!) as { permissions: { deny: string[] } };
    expect(parsed.permissions.deny).toContain("Read(//p/**)");
  });

  it("returns nothing for other AI CLIs", () => {
    expect(denySettingsArgs("codex")).toEqual([]);
  });
});
