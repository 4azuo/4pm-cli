/**
 * Tests for the books-set guard on real temp git repos (a bare remote + a clone): the books branch is created
 * books-only; a work branch loses a books-set path the
 * agent committed (restored to its fork point); a WIP commit never includes the books set and unpushed WIP snapshots
 * squash into one; the books overlay writes
 * the books into the tree without git seeing them and lifts cleanly.
 * @adr 0438 @adr 0563
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureBooksBranch, stripBooksSetFromBranch, syncBooks, wipCommit } from "./autonomous-git";
import { applyOverlay, liftOverlay } from "./autonomous-overlay";

const APPROVALS = ".4pm/.autonomous.approvals.json";
const BOOKS = "autonomous-books/main";
const DIRS = { evidenceDir: ".4pm/evidence", erDir: ".4pm/er", diagramDir: ".4pm/diagrams" };

let tmp: string;
let remote: string;
let root: string;

/** Run git in `cwd` (identity fixed). */
function g(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "4pm-guard-"));
  remote = join(tmp, "remote.git");
  root = join(tmp, "work");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  execFileSync("git", ["clone", "-q", remote, root]);
  g(root, "checkout", "-q", "-b", "main");
  writeFileSync(join(root, "app.ts"), "export {};\n");
  writeFileSync(join(root, "AI_TODO.md"), "| ID | Task description |\n|---|---|\n");
  g(root, "add", "-A");
  g(root, "commit", "-q", "-m", "init");
  g(root, "push", "-q", "origin", "main");
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("books branch", () => {
  it("is created holding only the books set", async () => {
    expect(await ensureBooksBranch(root, "main")).toBe(`origin/${BOOKS}`);
    expect(g(remote, "ls-tree", "-r", "--name-only", BOOKS).split("\n")).toEqual(["AI_TODO.md"]);
  });
});

describe("work branch guard", () => {
  it("strips a books-set path the agent committed back to the fork point and keeps its code", async () => {
    g(root, "checkout", "-q", "-b", "dev/main/GRP-000001/TSK-000001-001");
    writeFileSync(join(root, "feature.ts"), "export const x = 1;\n");
    mkdirSync(join(root, ".4pm"), { recursive: true });
    writeFileSync(join(root, APPROVALS), '{ "TSK-9": { "approved": true } }\n');
    writeFileSync(join(root, "AI_TODO.md"), "| ID | Task description |\n|---|---|\n| TSK-9 | forged |\n");
    g(root, "add", "-A");
    g(root, "commit", "-q", "-m", "agent work");
    const stripped = await stripBooksSetFromBranch(root, "main", "TSK-000001-001", DIRS);
    expect(stripped.sort()).toEqual([APPROVALS, "AI_TODO.md"].sort());
    const fork = g(root, "merge-base", "HEAD", "origin/main");
    expect(g(root, "diff", "--name-only", fork, "HEAD")).toBe("feature.ts");
  });

  it("never puts books-set edits into a WIP commit", async () => {
    writeFileSync(join(root, "feature.ts"), "export const y = 2;\n");
    writeFileSync(join(root, "AI_TODO.md"), "| ID | Task description |\n|---|---|\n| TSK-1 | x |\n");
    expect(await wipCommit(root, "wip")).toBe(true);
    expect(g(root, "show", "--name-only", "--format=", "HEAD")).toBe("feature.ts");
  });

  it("squashes unpushed WIP snapshots into one commit and never rewrites a pushed one", async () => {
    g(root, "checkout", "-q", "-b", "dev/main/GRP-000001/TSK-000001-001");
    writeFileSync(join(root, "a.ts"), "1\n");
    await wipCommit(root, "wip(TSK-000001-001): paused");
    writeFileSync(join(root, "b.ts"), "2\n");
    await wipCommit(root, "wip(TSK-000001-001): out of tokens");
    expect(g(root, "rev-list", "--count", "origin/main..HEAD")).toBe("1");
    g(root, "push", "-q", "-u", "origin", "dev/main/GRP-000001/TSK-000001-001");
    writeFileSync(join(root, "c.ts"), "3\n");
    await wipCommit(root, "feat(TSK-000001-001): done");
    expect(g(root, "rev-list", "--count", "origin/main..HEAD")).toBe("2");
    expect(g(root, "log", "-1", "--format=%s")).toBe("feat(TSK-000001-001): done");
  });
});

describe("books overlay", () => {
  it("writes the books into the tree, hidden from git, and lifts them cleanly", async () => {
    const { dir } = await syncBooks(root, "main");
    // A newer book row + an approvals sidecar on the books branch.
    mkdirSync(join(dir, ".4pm"), { recursive: true });
    writeFileSync(join(dir, APPROVALS), "{}\n");
    writeFileSync(join(dir, "AI_TODO.md"), "| ID | Task description |\n|---|---|\n| TSK-000001-001 | live |\n");
    g(dir, "add", "-A");
    g(dir, "commit", "-q", "-m", "books");
    g(dir, "push", "-q", "origin", `HEAD:refs/heads/${BOOKS}`);
    g(root, "fetch", "-q", "origin");
    g(root, "checkout", "-q", "-b", "dev/main/GRP-000001/TSK-000001-001", "origin/main");
    expect(await applyOverlay(root, `origin/${BOOKS}`, DIRS)).toBe(2);
    expect(readFileSync(join(root, "AI_TODO.md"), "utf8")).toContain("TSK-000001-001");
    expect(existsSync(join(root, APPROVALS))).toBe(true);
    expect(g(root, "status", "--porcelain")).toBe("");
    // The agent's code still commits; the books do not.
    writeFileSync(join(root, "feature.ts"), "export {};\n");
    g(root, "add", "-A");
    expect(g(root, "diff", "--cached", "--name-only")).toBe("feature.ts");
    g(root, "reset", "-q");
    await liftOverlay(root);
    expect(readFileSync(join(root, "AI_TODO.md"), "utf8")).not.toContain("TSK-000001-001");
    expect(existsSync(join(root, APPROVALS))).toBe(false);
    expect(g(root, "status", "--porcelain")).toBe("?? feature.ts");
  });
});
