/**
 * Tests for `lastCommitTimes` on a real temp git repo: each listed path gets the time of the last commit that
 * touched it; an uncommitted path has no entry.
 * @adr 0514
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lastCommitTimes } from "./autonomous-git";

let root: string;

/** Commit everything at a fixed committer date. */
function commitAt(date: string, msg: string): void {
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"], { cwd: root });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", msg], {
    cwd: root,
    env: { ...process.env, GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date },
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "4pm-modified-"));
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  mkdirSync(join(root, ".4pm/sequences"), { recursive: true });
  mkdirSync(join(root, ".4pm/mockups"), { recursive: true });
  writeFileSync(join(root, ".4pm/sequences/TSK-000001-001.md"), "a");
  writeFileSync(join(root, ".4pm/mockups/TSK-000001--login.html"), "a");
  commitAt("2026-10-01T10:00:00Z", "first");
  writeFileSync(join(root, ".4pm/sequences/TSK-000001-001.md"), "b");
  commitAt("2026-10-02T11:00:00Z", "second");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("lastCommitTimes", () => {
  it("returns the last commit time per path and skips uncommitted ones", async () => {
    writeFileSync(join(root, ".4pm/sequences/TSK-000002-001.md"), "new");
    const out = await lastCommitTimes(root, "HEAD", [
      ".4pm/sequences/TSK-000001-001.md",
      ".4pm/mockups/TSK-000001--login.html",
      ".4pm/sequences/TSK-000002-001.md",
    ]);
    expect(Date.parse(out[".4pm/sequences/TSK-000001-001.md"]!)).toBe(Date.parse("2026-10-02T11:00:00Z"));
    expect(Date.parse(out[".4pm/mockups/TSK-000001--login.html"]!)).toBe(Date.parse("2026-10-01T10:00:00Z"));
    expect(out[".4pm/sequences/TSK-000002-001.md"]).toBeUndefined();
  });

  it("returns nothing for an unsafe ref", async () => {
    expect(await lastCommitTimes(root, "HEAD; rm -rf /", [".4pm/sequences/TSK-000001-001.md"])).toEqual({});
  });
});
