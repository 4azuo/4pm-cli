/**
 * Tests of the git fallback of the PR state lookup against real temporary git repos: an open branch, a merge commit,
 * a squash merge, a branch deleted after the merge (with a stale local remote ref), and an unreachable remote.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitPrState } from "./autonomous-pr-states";

/** Run git in `cwd` with a fixed identity. */
function g(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();
}

const BRANCH = "dev/main/GRP-000001/REQ-000001-001";
let dir: string;
let origin: string;
let work: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "4pm-prstate-"));
  origin = join(dir, "origin.git");
  work = join(dir, "work");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  execFileSync("git", ["clone", "-q", origin, work]);
  writeFileSync(join(work, "a.txt"), "one\n");
  g(work, "add", "-A");
  g(work, "commit", "-qm", "init");
  g(work, "push", "-q", "origin", "HEAD:main");
  // The request branch: two commits, pushed.
  g(work, "checkout", "-qb", BRANCH);
  writeFileSync(join(work, "b.txt"), "mockup\n");
  g(work, "add", "-A");
  g(work, "commit", "-qm", "mockup");
  writeFileSync(join(work, "c.txt"), "sequence\n");
  g(work, "add", "-A");
  g(work, "commit", "-qm", "sequence");
  g(work, "push", "-q", "origin", `HEAD:refs/heads/${BRANCH}`);
  g(work, "checkout", "-q", "main");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Land the branch on main through a second clone (the host's merge button), then optionally delete it. */
function landOnMain(how: "merge" | "squash", deleteBranch = false): void {
  const other = join(dir, `other-${Date.now()}`);
  execFileSync("git", ["clone", "-q", origin, other]);
  // The base moved meanwhile, so a squash commit is not a fast-forward of the branch.
  writeFileSync(join(other, "d.txt"), "other work\n");
  g(other, "add", "-A");
  g(other, "commit", "-qm", "other work");
  if (how === "merge") g(other, "merge", "-q", "--no-ff", "-m", "Merge PR #8", `origin/${BRANCH}`);
  else {
    g(other, "merge", "-q", "--squash", `origin/${BRANCH}`);
    g(other, "commit", "-qm", "REQ-000001-001 (#8)");
  }
  g(other, "push", "-q", "origin", "HEAD:main");
  if (deleteBranch) g(other, "push", "-q", "origin", "--delete", BRANCH);
}

describe("gitPrState", () => {
  it("says open while the branch is not in the base", async () => {
    expect(await gitPrState(work, BRANCH, "main")).toBe("open");
  });

  it("says merged after a merge commit, the branch kept", async () => {
    landOnMain("merge");
    expect(await gitPrState(work, BRANCH, "main")).toBe("merged");
  });

  it("says merged after a squash merge, the branch kept", async () => {
    landOnMain("squash");
    expect(await gitPrState(work, BRANCH, "main")).toBe("merged");
  });

  it("says merged when the branch was deleted, despite a stale local remote ref", async () => {
    g(work, "fetch", "-q", "origin");
    landOnMain("squash", true);
    expect(g(work, "rev-parse", "--verify", "--quiet", `refs/remotes/origin/${BRANCH}`)).not.toBe("");
    expect(await gitPrState(work, BRANCH, "main")).toBe("merged");
  });

  it("cannot tell when the remote is unreachable", async () => {
    g(work, "remote", "set-url", "origin", join(dir, "missing.git"));
    expect(await gitPrState(work, BRANCH, "main")).toBeNull();
  });
});
