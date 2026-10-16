/**
 * Tests for the evidence guide given to the agents: read from `origin/<base>` over the working tree, the whole
 * file for intake, the needed sections for implement, a placeholder without a guide.
 * @adr 0532
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { implementEvidenceGuide, intakeEvidenceGuide } from "./autonomous-evidence-guide";

let tmp: string;
let root: string;

/** Run git in `cwd` (identity fixed). */
function g(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();
}

const GUIDE = "# G\n\n## General\n- remote\n\n## Mockups\n- dark\n\n## Task evidence\n- screenshots\n";

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "4pm-eg-"));
  const remote = join(tmp, "remote.git");
  root = join(tmp, "work");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  execFileSync("git", ["clone", "-q", remote, root]);
  g(root, "checkout", "-q", "-b", "main");
  writeFileSync(join(root, "EVIDENCE_GUIDE.md"), GUIDE);
  g(root, "add", "-A");
  g(root, "commit", "-q", "-m", "init");
  g(root, "push", "-q", "origin", "main");
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("evidence guide for the agents", () => {
  it("reads origin/<base> over a local edit and picks sections for implement", async () => {
    writeFileSync(join(root, "EVIDENCE_GUIDE.md"), "## General\n- local\n");
    expect(await intakeEvidenceGuide(root, "main")).toContain("- remote");
    const impl = await implementEvidenceGuide(root, "main", { mockups: false, sequence: false, er: false, diagram: false });
    expect(impl).toBe("## General\n- remote\n\n## Task evidence\n- screenshots");
    expect(await implementEvidenceGuide(root, "main", { mockups: true, sequence: false, er: false, diagram: false })).toContain("## Mockups");
  });

  it("falls back to the working tree, then to a placeholder", async () => {
    expect(await intakeEvidenceGuide(root, "")).toContain("## General");
    rmSync(join(root, "EVIDENCE_GUIDE.md"));
    expect(await intakeEvidenceGuide(root, "")).toMatch(/^\(none/);
  });
});
