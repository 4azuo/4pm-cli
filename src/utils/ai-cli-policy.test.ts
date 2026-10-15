/**
 * Tests for `planPolicyRun` — the restricted runners' planner: the same credentials and order as a
 * dispatched run (unified list, provider scope, working-first, disabled entries dropped), the common
 * prefix + the policy's args, attempts the policy refuses dropped, and the default-env fallback.
 * @adr 0520
 */
import { describe, expect, it } from "vitest";
import { credentialKey, planPolicyRun, type AiCliConfig, type AiRunPolicy } from "./ai-cli";

/** claude gets a marker arg, codex a sandbox, anything else is refused. */
const POLICY: AiRunPolicy = {
  args: (cmd) => (cmd === "claude" ? ["--claude-only"] : cmd === "codex" ? ["--sandbox", "read-only"] : null),
};
/** claude only. */
const CLAUDE_ONLY: AiRunPolicy = { args: (cmd) => (cmd === "claude" ? [] : null) };

const unified: AiCliConfig = {
  aiCli: "",
  aiProfiles: [
    { provider: "claude", profile: "/p/c1" },
    { provider: "codex", profile: "/p/x1", model: "gpt-5" },
    { provider: "claude", profile: "/p/c2", enabled: false },
    { provider: "claude", profile: "/p/c3", apiKey: { source: "ssm", name: "/k" } },
  ],
};

describe("planPolicyRun", () => {
  it("keeps the dispatch order + provider mix and appends the policy args", () => {
    const plan = planPolicyRun("hi", unified, {}, POLICY);
    expect(plan.attempts.map((a) => [a.cmd, a.dir])).toEqual([
      ["claude", "/p/c1"],
      ["codex", "/p/x1"],
      ["claude", "/p/c3"],
    ]);
    const codex = plan.attempts[1]!;
    expect(codex.args.slice(0, 2)).toEqual(["exec", "--json"]);
    expect(codex.args).toContain("gpt-5");
    expect(codex.args.slice(-2)).toEqual(["--sandbox", "read-only"]);
    expect(codex.stdin).toBe("hi");
    expect(plan.attempts[0]!.env).toMatchObject({ CLAUDE_CONFIG_DIR: "/p/c1" });
    expect(plan.attempts[2]!.apiKey).toEqual({ source: "ssm", name: "/k" });
  });

  it("moves the working credential first", () => {
    const plan = planPolicyRun("hi", unified, { credential: credentialKey("claude", "/p/c3") }, POLICY);
    expect(plan.attempts[0]!.dir).toBe("/p/c3");
  });

  it("drops attempts the policy refuses and scopes to the active provider", () => {
    expect(planPolicyRun("hi", unified, {}, CLAUDE_ONLY).attempts.map((a) => a.dir)).toEqual(["/p/c1", "/p/c3"]);
    const codexOnly = planPolicyRun("hi", { ...unified, aiCli: "codex" }, {}, POLICY);
    expect(codexOnly.attempts.map((a) => a.dir)).toEqual(["/p/x1"]);
  });

  it("falls back to one default-env claude attempt when nothing is left", () => {
    const plan = planPolicyRun("hi", { ...unified, aiCli: "codex" }, {}, CLAUDE_ONLY);
    expect(plan.attempts).toHaveLength(1);
    expect(plan.attempts[0]).toMatchObject({ cmd: "claude", dir: null, key: null });
  });
});
