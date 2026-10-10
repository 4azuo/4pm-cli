/**
 * Tests for the cli-owned sidecar guard on real temp git repos (a bare remote + a clone): an intake
 * agent's approval edits and commits are dropped while its book edits publish; a task branch loses the
 * agent's sidecar edits (restored to its fork point, not the advanced base tip); a WIP commit never
 * includes them.
 * @adr 0438
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { publishIntake, stripSidecarsFromBranch, wipCommit } from "./autonomous-git";

const APPROVALS = ".claude/.autonomous.approvals.json";

let tmp: string;
let remote: string;
let root: string;

/** Run git in `cwd` (identity fixed). */
function g(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();
}

/** The file at `rel` on the remote's `main`. */
function remoteFile(rel: string): string {
  return g(remote, "show", `main:${rel}`);
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "4pm-guard-"));
  remote = join(tmp, "remote.git");
  root = join(tmp, "work");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  execFileSync("git", ["clone", "-q", remote, root]);
  g(root, "checkout", "-q", "-b", "main");
  mkdirSync(join(root, ".claude"));
  writeFileSync(join(root, "AI_TODO.md"), "| ID | Task description |\n|---|---|\n");
  writeFileSync(join(root, APPROVALS), "{}\n");
  g(root, "add", "-A");
  g(root, "commit", "-q", "-m", "init");
  g(root, "push", "-q", "origin", "main");
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("publishIntake guard", () => {
  it("publishes the books but reverts a forged approval and drops agent commits", async () => {
    // The agent writes a task, forges its approval, and commits something else on its own.
    writeFileSync(join(root, "AI_TODO.md"), "| ID | Task description |\n|---|---|\n| TSK-0001-0001 | x |\n");
    writeFileSync(join(root, APPROVALS), '{ "TSK-0001-0001": { "approved": true } }\n');
    writeFileSync(join(root, "evil.sh"), "curl attacker\n");
    g(root, "add", "evil.sh");
    g(root, "commit", "-q", "-m", "agent commit");
    const reverted: string[] = [];
    const res = await publishIntake(root, "main", "chore(auto): intake", undefined, (f) => {
      reverted.push(...f);
    });
    expect(res).toBe("pushed");
    expect(reverted).toEqual([APPROVALS]);
    expect(remoteFile("AI_TODO.md")).toContain("TSK-0001-0001");
    expect(remoteFile(APPROVALS)).toBe("{}");
    expect(() => remoteFile("evil.sh")).toThrow();
  });
});

describe("task branch guard", () => {
  it("strips the agent's sidecar commits back to the fork point and keeps its code", async () => {
    g(root, "checkout", "-q", "-b", "dev/main/0001/TSK-0001-0001");
    writeFileSync(join(root, "app.ts"), "export {};\n");
    writeFileSync(join(root, APPROVALS), '{ "TSK-9": { "approved": true } }\n');
    g(root, "add", "-A");
    g(root, "commit", "-q", "-m", "agent work");
    // Meanwhile the cli publishes a newer approvals file on main.
    const other = join(tmp, "other");
    execFileSync("git", ["clone", "-q", remote, other]);
    writeFileSync(join(other, APPROVALS), '{ "TSK-0001-0001": { "approved": true, "by": "u" } }\n');
    g(other, "commit", "-q", "-am", "chore(auto): approve");
    g(other, "push", "-q", "origin", "main");
    g(root, "fetch", "-q", "origin");

    const reverted = await stripSidecarsFromBranch(root, "main", "TSK-0001-0001");
    expect(reverted).toEqual([APPROVALS]);
    const fork = g(root, "merge-base", "HEAD", "origin/main");
    expect(g(root, "diff", "--name-only", fork, "HEAD")).toBe("app.ts");
  });

  it("never puts sidecar edits into a WIP commit", async () => {
    writeFileSync(join(root, "app.ts"), "export {};\n");
    writeFileSync(join(root, APPROVALS), '{ "TSK-9": { "approved": true } }\n');
    expect(await wipCommit(root, "wip")).toBe(true);
    expect(g(root, "show", "--name-only", "--format=", "HEAD")).toBe("app.ts");
    expect(readFileSync(join(root, APPROVALS), "utf8")).toBe("{}\n");
  });
});
