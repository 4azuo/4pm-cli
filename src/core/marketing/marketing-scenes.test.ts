/**
 * Tests of the marketing scenes on a real repo (a bare remote + a clone): first save creates the orphan branch,
 * stale writes are refused, approvals bind to the shot hash, and the writer can't approve their own shot.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { approveMarketing, readMarketing, writeMarketing } from "./marketing-scenes";

const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" });

let dir = "";
let root = "";

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "mkt-test-"));
  const remote = join(dir, "remote.git");
  git(dir, "init", "-q", "--bare", "-b", "main", remote);
  root = join(dir, "work");
  git(dir, "clone", "-q", remote, root);
  git(root, "config", "user.name", "T");
  git(root, "config", "user.email", "t@t");
  writeFileSync(join(root, "README.md"), "app\n");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "init");
  git(root, "push", "-q", "origin", "main");
  git(root, "remote", "set-head", "origin", "main");
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const SHOTS = "---\ndriver: web\n---\n\n## SHOT-001 — Home\n- path: /\n";

describe("marketing scenes", () => {
  it("creates the branch on the first save and lists the set", async () => {
    const empty = await readMarketing(root, { base: "main" });
    expect(empty).toMatchObject({ ok: true, base: "main", branchExists: false, sets: [] });
    const w = await writeMarketing(root, { base: "main", path: "photos/home/SHOTS.md", content: SHOTS, baseSha: null, by: "u1", byLabel: "Ann" });
    expect(w.ok).toBe(true);
    const r = await readMarketing(root, { base: "main", set: "home" });
    expect(r.branchExists).toBe(true);
    expect(r.sets).toEqual([{ set: "home", driver: "web", shots: 1, approved: 0 }]);
    expect(r.file?.authors["SHOT-001"]?.by).toBe("u1");
    expect(r.bases).toContain("main");
    // The branch carries only the marketing folder.
    expect(git(root, "ls-tree", "-r", "--name-only", "origin/4pm/marketing/main").split("\n").every((l) => !l || l.startsWith(".4pm/marketing/"))).toBe(true);
  });

  it("refuses a write based on a stale blob", async () => {
    const w = await writeMarketing(root, { base: "main", path: "photos/home/SHOTS.md", content: SHOTS, baseSha: null, by: "u1", byLabel: "Ann" });
    expect(w).toMatchObject({ ok: false, code: "MARKETING_FILE_CHANGED" });
  });

  it("binds approvals to the hash and blocks self-approval", async () => {
    const r = await readMarketing(root, { base: "main", set: "home" });
    const { shotHashes } = await import("./marketing-scenes");
    const { parseMarketingShots } = await import("@4pm/dto");
    const hash = shotHashes(parseMarketingShots(r.file!.content)).get("SHOT-001")!;
    const self = await approveMarketing(root, { base: "main", set: "home", approve: [{ id: "SHOT-001", hash }], unapprove: [], by: "u1", byLabel: "Ann", allowSelf: false });
    expect(self).toMatchObject({ ok: false, code: "APPROVAL_SELF" });
    const stale = await approveMarketing(root, { base: "main", set: "home", approve: [{ id: "SHOT-001", hash: "0".repeat(64) }], unapprove: [], by: "u2", byLabel: "Bob", allowSelf: false });
    expect(stale).toMatchObject({ ok: false, code: "MARKETING_FILE_CHANGED" });
    const ok = await approveMarketing(root, { base: "main", set: "home", approve: [{ id: "SHOT-001", hash }], unapprove: [], by: "u2", byLabel: "Bob", allowSelf: false });
    expect(ok.ok).toBe(true);
    expect((await readMarketing(root, { base: "main" })).sets?.[0]?.approved).toBe(1);
    // Editing the shot drops the approval.
    const edited = await writeMarketing(root, { base: "main", path: "photos/home/SHOTS.md", content: SHOTS.replace("- path: /", "- path: /home"), baseSha: r.file!.sha, by: "u1", byLabel: "Ann" });
    expect(edited.ok).toBe(true);
    expect((await readMarketing(root, { base: "main" })).sets?.[0]?.approved).toBe(0);
  });

  it("refuses paths outside the marketing files and deletes a set", async () => {
    expect(await writeMarketing(root, { base: "main", path: "../x", content: "x", baseSha: null, by: "u1", byLabel: "Ann" })).toMatchObject({ ok: false });
    const r = await readMarketing(root, { base: "main", set: "home" });
    const del = await writeMarketing(root, { base: "main", path: "photos/home/SHOTS.md", content: null, baseSha: r.file!.sha, by: "u1", byLabel: "Ann" });
    expect(del.ok).toBe(true);
    expect((await readMarketing(root, { base: "main" })).sets).toEqual([]);
  });
});
