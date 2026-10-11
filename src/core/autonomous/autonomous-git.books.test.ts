/**
 * Tests for the dedicated books branch on real temp git repos (a bare remote + a clone): the books are
 * published to `autonomous-books/<base>` (created from `<base>` the first time) and never to `<base>`; the
 * books branch follows `<base>` (its code is merged in, the books side wins); reads use the books branch
 * and fall back to `<base>` before it exists; web writes go through a side worktree of it.
 * @adr 0448
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mutateBooks, publishBooks, readBooksFile, syncBooks } from "./autonomous-git";
import { booksBranch } from "./autonomous-tasks";

const BOOKS = "autonomous-books/main";

let tmp: string;
let remote: string;
let root: string;

/** Run git in `cwd` (identity fixed). */
function g(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();
}

/** The file at `rel` on the remote branch `branch`. */
function remoteFile(branch: string, rel: string): string {
  return g(remote, "show", `${branch}:${rel}`);
}

/** Push a code change to `main` from a second clone (a merged PR). */
function landOnMain(file: string, content: string): void {
  const other = join(tmp, `other-${Date.now()}`);
  execFileSync("git", ["clone", "-q", remote, other]);
  writeFileSync(join(other, file), content);
  g(other, "add", "-A");
  g(other, "commit", "-q", "-m", `land ${file}`);
  g(other, "push", "-q", "origin", "main");
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "4pm-books-"));
  remote = join(tmp, "remote.git");
  root = join(tmp, "work");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  execFileSync("git", ["clone", "-q", remote, root]);
  g(root, "checkout", "-q", "-b", "main");
  writeFileSync(join(root, "AI_TODO.md"), "| ID | Task description |\n|---|---|\n");
  writeFileSync(join(root, "app.ts"), "v1\n");
  g(root, "add", "-A");
  g(root, "commit", "-q", "-m", "init");
  g(root, "push", "-q", "origin", "main");
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

/** A change that appends one task row to AI_TODO.md in `dir`. */
function addTask(dir: string, id: string): () => Promise<boolean> {
  return async () => {
    const p = join(dir, "AI_TODO.md");
    writeFileSync(p, `${readFileSync(p, "utf8")}| ${id} | x |\n`);
    return true;
  };
}

describe("booksBranch", () => {
  it("puts the 4PM prefix before the base (ADR-0372 rule)", () => {
    expect(booksBranch("main")).toBe("autonomous-books/main");
    expect(booksBranch("release/1.0")).toBe("autonomous-books/release/1.0");
  });
});

describe("publishBooks", () => {
  it("creates the books branch from <base> and pushes there, never to <base>", async () => {
    const res = await publishBooks(root, "main", "chore(auto): claim", addTask(root, "TSK-000001-001"));
    expect(res).toBe("pushed");
    expect(remoteFile(BOOKS, "AI_TODO.md")).toContain("TSK-000001-001");
    expect(remoteFile("main", "AI_TODO.md")).not.toContain("TSK-000001-001");
  });

  it("merges new <base> code into the books branch and keeps the books", async () => {
    await publishBooks(root, "main", "chore(auto): claim", addTask(root, "TSK-000001-001"));
    landOnMain("app.ts", "v2\n");
    await publishBooks(root, "main", "chore(auto): claim", addTask(root, "TSK-000001-002"));
    expect(remoteFile(BOOKS, "app.ts")).toBe("v2");
    const todo = remoteFile(BOOKS, "AI_TODO.md");
    expect(todo).toContain("TSK-000001-001");
    expect(todo).toContain("TSK-000001-002");
  });
});

describe("syncBooks + readBooksFile", () => {
  it("reads <base> before the books branch exists, the books branch afterwards", async () => {
    expect(await readBooksFile(root, "main", "AI_TODO.md")).not.toContain("TSK");
    await publishBooks(root, "main", "chore(auto): claim", addTask(root, "TSK-000001-001"));
    // The read cache keeps a fetch for 15 s, so a fresh clone reads the new state.
    const other = join(tmp, "reader");
    execFileSync("git", ["clone", "-q", remote, other]);
    expect(await readBooksFile(other, "main", "AI_TODO.md")).toContain("TSK-000001-001");
  });

  it("leaves the working tree on the books branch with the current <base> code", async () => {
    await publishBooks(root, "main", "chore(auto): claim", addTask(root, "TSK-000001-001"));
    landOnMain("app.ts", "v3\n");
    await syncBooks(root, "main");
    expect(g(root, "rev-parse", "--abbrev-ref", "HEAD")).toBe(BOOKS);
    expect(readFileSync(join(root, "app.ts"), "utf8")).toBe("v3\n");
    expect(readFileSync(join(root, "AI_TODO.md"), "utf8")).toContain("TSK-000001-001");
  });
});

describe("mutateBooks (web writes)", () => {
  it("publishes through a side worktree without moving the working tree", async () => {
    g(root, "checkout", "-q", "-b", "dev/main/GRP-000001/TSK-000001-001");
    const res = await mutateBooks(root, "main", "chore(web): approve", async (dir) => addTask(dir, "TSK-000002-001")());
    expect(res).toBe("pushed");
    expect(g(root, "rev-parse", "--abbrev-ref", "HEAD")).toBe("dev/main/GRP-000001/TSK-000001-001");
    expect(remoteFile(BOOKS, "AI_TODO.md")).toContain("TSK-000002-001");
    expect(remoteFile("main", "AI_TODO.md")).not.toContain("TSK-000002-001");
  });
});
