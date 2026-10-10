/**
 * Tests for removing submodules on real temp git repos (bare remotes + clones): a clean submodule is
 * removed, committed and pushed; one with local work is refused and left untouched; another worker
 * drops the leftover folder after pulling the removal, but keeps one that holds local work.
 * @adr 0441
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detachSubmodules, pruneStaleSubmodules } from "./submodule-detach";

let tmp: string;
let remote: string;
let subRemote: string;
let root: string;
const noop = (): void => undefined;

/** Run git in `cwd` (identity fixed, local-path submodules allowed). */
function g(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "protocol.file.allow=always", ...args],
    { cwd, encoding: "utf8" },
  ).trim();
}

/** A bare remote with one commit on `main`. */
function bareWithCommit(name: string): string {
  const bare = join(tmp, `${name}.git`);
  const work = join(tmp, `${name}-seed`);
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
  execFileSync("git", ["clone", "-q", bare, work]);
  g(work, "checkout", "-q", "-b", "main");
  writeFileSync(join(work, "README.md"), `${name}\n`);
  g(work, "add", "-A");
  g(work, "commit", "-q", "-m", "init");
  g(work, "push", "-q", "origin", "main");
  return bare;
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "4pm-subdetach-"));
  remote = bareWithCommit("app");
  subRemote = bareWithCommit("docs");
  root = join(tmp, "worker-a");
  g(tmp, "clone", "-q", remote, root);
  g(root, "submodule", "add", "-q", subRemote, "docs");
  g(root, "commit", "-q", "-m", "add docs");
  g(root, "push", "-q", "origin", "main");
  // The test's git identity must also apply to the commit detachSubmodules makes.
  g(root, "config", "user.name", "t");
  g(root, "config", "user.email", "t@t");
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("detachSubmodules", () => {
  it("removes a clean submodule, commits and pushes the removal", async () => {
    await detachSubmodules(root, ["docs"], noop);
    expect(existsSync(join(root, "docs"))).toBe(false);
    expect(existsSync(join(root, ".git", "modules", "docs"))).toBe(false);
    expect(g(remote, "ls-tree", "--name-only", "main")).not.toContain("docs");
    expect(g(remote, "log", "-1", "--format=%s", "main")).toContain("remove git submodule docs");
  });

  it("refuses a submodule with uncommitted changes and leaves everything in place", async () => {
    writeFileSync(join(root, "docs", "draft.md"), "wip\n");
    await expect(detachSubmodules(root, ["docs"], noop)).rejects.toThrow(/uncommitted changes or unpushed commits/);
    expect(existsSync(join(root, "docs", "draft.md"))).toBe(true);
    expect(g(remote, "ls-tree", "--name-only", "main")).toContain("docs");
  });

  it("refuses a submodule with a commit no remote has", async () => {
    g(join(root, "docs"), "checkout", "-q", "-b", "local");
    writeFileSync(join(root, "docs", "x.md"), "x\n");
    g(join(root, "docs"), "add", "-A");
    g(join(root, "docs"), "commit", "-q", "-m", "local only");
    await expect(detachSubmodules(root, ["docs"], noop)).rejects.toThrow(/unpushed commits/);
  });
});

describe("pruneStaleSubmodules", () => {
  /** A second worker's clone with the submodule checked out. */
  function workerB(): string {
    const b = join(tmp, "worker-b");
    g(tmp, "clone", "-q", "--recurse-submodules", remote, b);
    return b;
  }

  it("drops the leftover folder after pulling another worker's removal", async () => {
    const b = workerB();
    expect(existsSync(join(b, "docs", "README.md"))).toBe(true);
    await detachSubmodules(root, ["docs"], noop);
    g(b, "pull", "-q", "--ff-only");
    await pruneStaleSubmodules(b, noop);
    expect(existsSync(join(b, "docs"))).toBe(false);
    expect(existsSync(join(b, ".git", "modules", "docs"))).toBe(false);
  });

  it("keeps a leftover that holds local work", async () => {
    const b = workerB();
    await detachSubmodules(root, ["docs"], noop);
    g(b, "pull", "-q", "--ff-only");
    writeFileSync(join(b, "docs", "notes.md"), "mine\n");
    const messages: string[] = [];
    await pruneStaleSubmodules(b, (_s, m) => messages.push(m));
    expect(existsSync(join(b, "docs", "notes.md"))).toBe(true);
    expect(messages.join(" ")).toMatch(/left in place/);
  });

  it("leaves declared submodules alone", async () => {
    await pruneStaleSubmodules(root, noop);
    expect(existsSync(join(root, "docs", "README.md"))).toBe(true);
  });
});
