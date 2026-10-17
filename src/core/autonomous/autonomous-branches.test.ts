/**
 * Tests of the branch cleanup against real temporary git repos: list the dead branches, delete one (logged on
 * the books branch), read the log and restore it.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleBranchCleanup } from "./autonomous-branches";

/** Run git in `cwd` with a fixed identity (and optional extra env). */
function g(cwd: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8", env: { ...process.env, ...env } }).trim();
}

let dir: string;
let root: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "4pm-branches-"));
  const origin = join(dir, "origin.git");
  root = join(dir, "work");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  execFileSync("git", ["clone", "-q", origin, root]);
  writeFileSync(join(root, "a.txt"), "one\n");
  g(root, ["add", "-A"]);
  g(root, ["commit", "-qm", "init"]);
  g(root, ["push", "-q", "origin", "HEAD:main"]);
  g(root, ["remote", "set-head", "origin", "main"]);
  // A merged 4PM task branch whose task is in no book.
  g(root, ["push", "-q", "origin", "HEAD:refs/heads/dev/main/000001/TSK-000001-001"]);
  // A recent feature branch (not dead) and an old one (stale).
  g(root, ["checkout", "-qb", "feature/x"]);
  writeFileSync(join(root, "b.txt"), "x\n");
  g(root, ["add", "-A"]);
  g(root, ["commit", "-qm", "x"]);
  g(root, ["push", "-q", "origin", "feature/x"]);
  g(root, ["checkout", "-qb", "old", "main"]);
  writeFileSync(join(root, "c.txt"), "old\n");
  g(root, ["add", "-A"]);
  g(root, ["commit", "-qm", "old"], { GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z", GIT_AUTHOR_DATE: "2020-01-01T00:00:00Z" });
  g(root, ["push", "-q", "origin", "old"]);
  g(root, ["checkout", "-q", "main"]);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("branch cleanup", () => {
  it("lists dead branches, deletes one with a log entry, and restores it", async () => {
    const list = await handleBranchCleanup(root, { op: "list", repo: "" });
    expect(list.ok).toBe(true);
    const byName = new Map((list.candidates ?? []).map((c) => [c.name, c]));
    expect(byName.get("dev/main/000001/TSK-000001-001")).toMatchObject({ kind: "4pm", reasons: ["merged", "task-gone"] });
    expect(byName.get("old")?.reasons).toEqual(["stale"]);
    expect(byName.has("feature/x")).toBe(false);
    expect(byName.has("main")).toBe(false);

    const del = await handleBranchCleanup(root, { op: "delete", repo: "", names: ["dev/main/000001/TSK-000001-001", "feature/x"], by: "u1" });
    expect(del.results).toEqual([
      { name: "dev/main/000001/TSK-000001-001", outcome: "deleted" },
      { name: "feature/x", outcome: "skipped", detail: "no longer a candidate" },
    ]);
    expect(g(root, ["ls-remote", "--heads", "origin", "dev/main/000001/TSK-000001-001"])).toBe("");

    const log = await handleBranchCleanup(root, { op: "log", repo: "" });
    expect(log.log).toHaveLength(1);
    const restore = await handleBranchCleanup(root, { op: "restore", repo: "", id: log.log![0]!.id, by: "u1" });
    expect(restore).toEqual({ ok: true });
    expect(g(root, ["ls-remote", "--heads", "origin", "dev/main/000001/TSK-000001-001"])).not.toBe("");
    const again = await handleBranchCleanup(root, { op: "restore", repo: "", id: log.log![0]!.id, by: "u1" });
    expect(again.code).toBe("BRANCH_EXISTS");
  }, 60_000);
});
