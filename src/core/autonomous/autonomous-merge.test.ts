/**
 * Tests of the task-branch merge helpers against real temporary git repos: merge the base, detect / judge a
 * conflict, and deliver straight into the base with a `--no-ff` merge.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { conflictResolved, directMerge, mergeRefs, mergesCleanly, resetToHead } from "./autonomous-merge";

/** Run git in `cwd` with a fixed identity. */
function g(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();
}

let dir: string;
let origin: string;
let work: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "4pm-merge-"));
  origin = join(dir, "origin.git");
  work = join(dir, "work");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  execFileSync("git", ["clone", "-q", origin, work]);
  writeFileSync(join(work, "a.txt"), "one\n");
  g(work, "add", "-A");
  g(work, "commit", "-qm", "init");
  g(work, "push", "-q", "origin", "HEAD:main");
  g(work, "checkout", "-qb", "dev/main/000001/TSK-000001-001");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Commit `text` to a.txt on main through a second clone (the base moves). */
function moveBase(text: string): void {
  const other = join(dir, `other-${Date.now()}`);
  execFileSync("git", ["clone", "-q", origin, other]);
  writeFileSync(join(other, "a.txt"), text);
  g(other, "commit", "-qam", "base change");
  g(other, "push", "-q", "origin", "HEAD:main");
}

describe("autonomous-merge", () => {
  it("merges a moved base cleanly", async () => {
    writeFileSync(join(work, "b.txt"), "task\n");
    g(work, "add", "-A");
    g(work, "commit", "-qm", "task");
    moveBase("two\n");
    g(work, "fetch", "-q", "origin");
    expect(await mergeRefs(work, ["origin/main"], "sync")).toEqual({ kind: "clean" });
  });

  it("leaves a conflict open, judges it, and resets to the pre-merge head", async () => {
    writeFileSync(join(work, "a.txt"), "task\n");
    g(work, "commit", "-qam", "task");
    const head = g(work, "rev-parse", "HEAD");
    moveBase("base\n");
    g(work, "fetch", "-q", "origin");
    const res = await mergeRefs(work, ["origin/main"], "sync");
    expect(res).toEqual({ kind: "conflict", paths: ["a.txt"] });
    expect(await conflictResolved(work, ["a.txt"])).toBe(false);
    expect(await mergesCleanly(work, "main", "HEAD")).not.toBe(true);
    writeFileSync(join(work, "a.txt"), "task + base\n");
    g(work, "add", "a.txt");
    expect(await conflictResolved(work, ["a.txt"])).toBe(true);
    await resetToHead(work, head);
    expect(g(work, "rev-parse", "HEAD")).toBe(head);
  });

  it("merges the task into the base with --no-ff", async () => {
    writeFileSync(join(work, "b.txt"), "task\n");
    g(work, "add", "-A");
    g(work, "commit", "-qm", "task");
    const out = await directMerge(work, "dev/main/000001/TSK-000001-001", "main", "Merge TSK (4PM autonomous)");
    expect(out.ok).toBe(true);
    g(work, "fetch", "-q", "origin");
    expect(g(work, "log", "-1", "--format=%s", "origin/main")).toBe("Merge TSK (4PM autonomous)");
    expect(g(work, "rev-list", "--parents", "-n1", "origin/main").split(" ")).toHaveLength(3);
  });

  it("reports a conflicting direct merge without touching the base", async () => {
    writeFileSync(join(work, "a.txt"), "task\n");
    g(work, "commit", "-qam", "task");
    moveBase("base\n");
    const before = g(work, "ls-remote", "origin", "main");
    const out = await directMerge(work, "dev/main/000001/TSK-000001-001", "main", "m");
    expect(out).toMatchObject({ ok: false, reason: "conflict" });
    expect(g(work, "ls-remote", "origin", "main")).toBe(before);
  });
});
