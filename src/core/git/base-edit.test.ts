/**
 * Tests for the base-branch web edits: commits land on `origin/<base>` without touching the working tree,
 * reads come from the remote ref, a stale `expectBlob` is refused, moves / deletes / folders work.
 * @adr 0511
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BaseEditError, commitToBase, listBaseDir, locateBase, readBaseFile, resetBaseEditForTest } from "./base-edit";
import { resetRepoLocksForTest } from "./repo-lock";

/** Run git synchronously in `cwd`. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
}

let dir: string;
let root: string;
let origin: string;

beforeEach(() => {
  resetBaseEditForTest();
  resetRepoLocksForTest();
  dir = mkdtempSync(join(tmpdir(), "base-edit-"));
  origin = join(dir, "origin.git");
  root = join(dir, "work");
  git(dir, "init", "-q", "--bare", "-b", "main", origin);
  git(dir, "clone", "-q", origin, root);
  git(root, "checkout", "-q", "-b", "main");
  writeFileSync(join(root, "README.md"), "hello\n");
  writeFileSync(join(root, "notes.md"), "notes\n");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "init");
  git(root, "push", "-q", "-u", "origin", "main");
  git(root, "remote", "set-head", "origin", "main");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("base edits", () => {
  it("commits a put on origin/<base> and fast-forwards a clean tree on <base>", async () => {
    const loc = (await locateBase(root, "README.md"))!;
    expect(loc.base).toBe("main");
    const before = await readBaseFile(root, "README.md");
    const sha = await commitToBase(root, loc, [{ op: "put", path: "README.md", data: Buffer.from("changed\n"), expectBlob: before!.blob }], {
      message: "web: update README.md",
      by: "alice",
    });
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(git(origin, "show", "main:README.md")).toBe("changed\n");
    expect(git(origin, "log", "-1", "--format=%B", "main")).toContain("4PM-Edited-By: alice");
    expect(readFileSync(join(root, "README.md"), "utf8")).toBe("changed\n");
  });

  it("leaves a working tree on another branch untouched", async () => {
    git(root, "checkout", "-q", "-b", "dev/task");
    const loc = (await locateBase(root, "notes.md"))!;
    await commitToBase(root, loc, [{ op: "put", path: "notes.md", data: Buffer.from("x\n") }], { message: "m" });
    expect(readFileSync(join(root, "notes.md"), "utf8")).toBe("notes\n");
    expect(git(root, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("dev/task");
    expect((await readBaseFile(root, "notes.md"))!.data!.toString()).toBe("x\n");
  });

  it("refuses a write based on a blob the remote no longer holds", async () => {
    const loc = (await locateBase(root, "README.md"))!;
    const stale = (await readBaseFile(root, "README.md"))!.blob;
    await commitToBase(root, loc, [{ op: "put", path: "README.md", data: Buffer.from("one\n") }], { message: "m" });
    await expect(
      commitToBase(root, loc, [{ op: "put", path: "README.md", data: Buffer.from("two\n"), expectBlob: stale }], { message: "m" }),
    ).rejects.toThrow(new BaseEditError("FILE_CHANGED_UPSTREAM"));
  });

  it("rebuilds on a lost race (someone else pushed first)", async () => {
    const other = join(dir, "other");
    git(dir, "clone", "-q", origin, other);
    writeFileSync(join(other, "other.md"), "o\n");
    git(other, "add", ".");
    git(other, "commit", "-q", "-m", "other");
    git(other, "push", "-q", "origin", "main");
    const loc = (await locateBase(root, "README.md"))!;
    await commitToBase(root, loc, [{ op: "put", path: "README.md", data: Buffer.from("mine\n") }], { message: "m" });
    expect(git(origin, "show", "main:other.md")).toBe("o\n");
    expect(git(origin, "show", "main:README.md")).toBe("mine\n");
  });

  it("moves, deletes and creates folders; lists from the remote ref", async () => {
    const loc = (await locateBase(root, "docs"))!;
    await commitToBase(root, loc, [{ op: "mkdir", path: "docs" }], { message: "m" });
    await commitToBase(root, loc, [{ op: "move", from: "notes.md", to: "docs/notes.md" }], { message: "m" });
    expect((await listBaseDir(root, "docs"))!.entries.map((e) => e.name).sort()).toEqual([".gitkeep", "notes.md"]);
    await commitToBase(root, loc, [{ op: "delete", path: "docs" }], { message: "m" });
    const top = (await listBaseDir(root, ""))!;
    expect(top.entries.map((e) => e.name)).toEqual(["README.md"]);
    expect(top.ref).toBe(`origin/${loc.base}`);
    expect(top.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it("returns undefined when nothing changes", async () => {
    const loc = (await locateBase(root, "README.md"))!;
    expect(await commitToBase(root, loc, [{ op: "put", path: "README.md", data: Buffer.from("hello\n") }], { message: "m" })).toBeUndefined();
  });

  it("is null without a remote base", async () => {
    const lone = join(dir, "lone");
    git(dir, "init", "-q", "-b", "main", lone);
    expect(await locateBase(lone, "a.md")).toBeNull();
  });
});
