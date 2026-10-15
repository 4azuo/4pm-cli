/**
 * Tests for evidence file history on real temp git repos (a bare remote + a clone): the commits that touched a
 * mockup / sequence, reading one version, and restoring it as a new books-branch commit.
 * @adr 0515
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { evidenceHistory, isVersionedEvidencePath, readEvidenceFile, restoreEvidenceVersion } from "./autonomous-evidence";
import { mutateBooks } from "./autonomous-git";

const BOOKS = "autonomous-books/main";
const SEQ = ".4pm/sequences/TSK-000001-001.md";
const DIRS = { mockupDir: ".4pm/mockups", sequenceDir: ".4pm/sequences" };

let tmp: string;
let remote: string;
let root: string;

/** Run git in `cwd` (identity fixed). */
function g(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();
}

/** Write the sequence file on the books branch through the web-write path. */
async function writeSeq(content: string): Promise<void> {
  await mutateBooks(root, "main", `seq ${content}`, async (dir) => {
    mkdirSync(join(dir, ".4pm/sequences"), { recursive: true });
    writeFileSync(join(dir, SEQ), content);
    return true;
  }, [DIRS.sequenceDir]);
  g(root, "fetch", "-q", "origin");
}

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "4pm-evhist-"));
  remote = join(tmp, "remote.git");
  root = join(tmp, "work");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  execFileSync("git", ["clone", "-q", remote, root]);
  g(root, "checkout", "-q", "-b", "main");
  writeFileSync(join(root, "AI_TODO.md"), "| ID | Task description |\n|---|---|\n");
  g(root, "add", "-A");
  g(root, "commit", "-q", "-m", "init");
  g(root, "push", "-q", "origin", "main");
  await writeSeq("v1");
  await writeSeq("v2");
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("evidence history", () => {
  it("limits history to mockups and sequences", () => {
    expect(isVersionedEvidencePath(SEQ, DIRS.mockupDir, DIRS.sequenceDir)).toBe(true);
    expect(isVersionedEvidencePath(".4pm/mockups/TSK-000001--a.html", DIRS.mockupDir, DIRS.sequenceDir)).toBe(true);
    expect(isVersionedEvidencePath(".4pm/er/changes/ERC-1.md", DIRS.mockupDir, DIRS.sequenceDir)).toBe(false);
    expect(isVersionedEvidencePath(".4pm/sequences/../x.md", DIRS.mockupDir, DIRS.sequenceDir)).toBe(false);
  });

  it("lists the versions newest first, reads one, and restores it as a new commit", async () => {
    const commits = await evidenceHistory(root, `origin/${BOOKS}`, SEQ);
    expect(commits.map((c) => c.subject)).toEqual(["seq v2", "seq v1"]);
    const v1 = commits[1]!.sha;

    const old = await readEvidenceFile(root, "main", SEQ, undefined, DIRS.mockupDir, [DIRS.sequenceDir], v1);
    expect(Buffer.from(old.contentBase64 ?? "", "base64").toString()).toBe("v1");
    expect((await readEvidenceFile(root, "main", SEQ, undefined, DIRS.mockupDir, [DIRS.sequenceDir], "zz")).error).toBeTruthy();

    expect(await restoreEvidenceVersion(root, "main", DIRS, SEQ, v1, "pm@x")).toEqual({ ok: true, result: "published" });
    expect(g(remote, "show", `${BOOKS}:${SEQ}`)).toBe("v1");
    g(root, "fetch", "-q", "origin");
    const after = await evidenceHistory(root, `origin/${BOOKS}`, SEQ);
    expect(after[0]!.subject).toBe(`evidence: restore ${SEQ} to ${v1.slice(0, 7)} (pm@x)`);
    expect(after).toHaveLength(3);

    // Restoring the same content again changes nothing.
    expect(await restoreEvidenceVersion(root, "main", DIRS, SEQ, v1, "pm@x")).toEqual({ ok: true, result: "unchanged" });
  });

  it("refuses a path outside the versioned folders", async () => {
    const r = await restoreEvidenceVersion(root, "main", DIRS, "AI_TODO.md", "abcdef1", "pm@x");
    expect(r.ok).toBe(false);
  });
});
