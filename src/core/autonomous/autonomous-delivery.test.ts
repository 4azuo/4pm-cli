/**
 * Tests for the AI Done delivery record on real temp git repos (a bare remote + a clone): capturing a delivered branch,
 * seeding a record from older Notes, and the Files modal reads — the task branch while it exists, the captured head
 * once the branch is deleted, the base sha as "before", and refusing a path the row does not list.
 * @adr 0582
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DELIVERY_SIDECAR_REL, serializeDeliverySidecar } from "@4pm/dto";
import { captureRepo, readDoneFile, readDoneFiles, seedFromNotes } from "./autonomous-delivery";

const ID = "TSK-000001-001";
const BRANCH = `dev/main/GRP-000001/${ID}`;

let tmp: string;
let remote: string;
let root: string;

/** Run git in `cwd` (identity fixed). */
function g(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();
}

/** Deliver `src/a.ts` on the task branch, then record the row + its delivery record on `main` (the books read ref). */
async function deliverTask(): Promise<void> {
  g(root, "checkout", "-q", "-b", BRANCH);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/a.ts"), "hello\n");
  g(root, "add", "-A");
  g(root, "commit", "-q", "-m", "feat: a");
  g(root, "push", "-q", "origin", BRANCH);
  const cap = await captureRepo(root, { dir: ".", url: remote, branch: BRANCH, base: "main", ref: BRANCH, state: "open" });
  g(root, "checkout", "-q", "main");
  writeFileSync(
    join(root, "AI_DONE.md"),
    `| Timestamp | ID | Files | Delivery | Notes |\n|---|---|---|---|---|\n| 2026-10-21 10:00:00 | ${ID} | src/a.ts | PR open | branch: ${BRANCH}; PR: opened |\n`,
  );
  mkdirSync(join(root, ".4pm"), { recursive: true });
  writeFileSync(join(root, DELIVERY_SIDECAR_REL), serializeDeliverySidecar({ [ID]: { repos: [cap] } }));
  g(root, "add", "-A");
  g(root, "commit", "-q", "-m", "books");
  g(root, "push", "-q", "origin", "main");
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "4pm-delivery-"));
  remote = join(tmp, "remote.git");
  root = join(tmp, "work");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  execFileSync("git", ["clone", "-q", remote, root]);
  g(root, "checkout", "-q", "-b", "main");
  writeFileSync(join(root, "README.md"), "x\n");
  g(root, "add", "-A");
  g(root, "commit", "-q", "-m", "init");
  g(root, "push", "-q", "-u", "origin", "main");
  g(root, "remote", "set-head", "origin", "main");
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("delivery record", () => {
  it("captures the full file list and the shas of a delivered branch", async () => {
    await deliverTask();
    const cap = await captureRepo(root, { dir: ".", url: remote, branch: BRANCH, base: "main", ref: `origin/${BRANCH}`, state: "open" });
    expect(cap.files).toEqual([{ path: "src/a.ts", status: "A" }]);
    expect(cap.headSha).toMatch(/^[0-9a-f]{40}$/);
    expect(cap.baseSha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("reads files from the task branch while it exists", async () => {
    await deliverTask();
    const list = await readDoneFiles(root, { rowId: ID });
    expect(list.error).toBeUndefined();
    expect(list.legacy).toBe(false);
    expect(list.repos?.[0]?.source).toBe("branch");
    expect(list.files).toEqual([{ path: "src/a.ts", repo: ".", status: "A" }]);
    const file = await readDoneFile(root, { rowId: ID, path: "src/a.ts" });
    expect(Buffer.from(file.contentBase64 ?? "", "base64").toString()).toBe("hello\n");
    const before = await readDoneFile(root, { rowId: ID, path: "src/a.ts", side: "before" });
    expect(before.missing).toBe(true);
    expect((await readDoneFile(root, { rowId: ID, path: "README.md" })).error).toBe("path not in this row");
  });

  it("falls back to the captured head once the branch is deleted", async () => {
    await deliverTask();
    g(root, "push", "-q", "origin", "--delete", BRANCH);
    g(root, "branch", "-q", "-D", BRANCH);
    g(root, "fetch", "-q", "--prune", "origin");
    const list = await readDoneFiles(root, { rowId: ID });
    expect(list.repos?.[0]?.source).toBe("head");
    const file = await readDoneFile(root, { rowId: ID, path: "src/a.ts" });
    expect(Buffer.from(file.contentBase64 ?? "", "base64").toString()).toBe("hello\n");
  });

  it("seeds a record from older Notes, with submodule branches by naming", () => {
    const rec = seedFromNotes(
      `branch: ${BRANCH}; PR: https://github.com/a/b/pull/11; submodules: src: https://github.com/a/c/pull/1; PR conflicts with main (src)`,
      "PR open #11",
      { dir: "", url: "https://github.com/a/b.git", base: "main" },
      [{ dir: "src", url: "https://github.com/a/c.git", base: "develop" }],
    );
    expect(rec?.seeded).toBe(true);
    expect(rec?.repos[0]).toMatchObject({ dir: ".", branch: BRANCH, pr: "https://github.com/a/b/pull/11", state: "open" });
    expect(rec?.repos[1]).toMatchObject({ dir: "src", branch: `dev/develop/GRP-000001/${ID}`, base: "develop", conflict: true });
  });
});
