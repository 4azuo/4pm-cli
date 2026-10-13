/**
 * agent-user tests — removing a shared tree deletes it without following symlinks, and the run-dir path
 * is per profile.
 * @adr 0487
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentRunDirPath, removeSharedTree } from "./agent-user";

const dirs: string[] = [];

/** A fresh temp dir removed after the test. */
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "4pm-agent-user-"));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("removeSharedTree", () => {
  it("deletes the tree but never the target of a symlink inside it", () => {
    const outside = tempDir();
    const keep = join(outside, "keep.txt");
    writeFileSync(keep, "x");
    const tree = join(tempDir(), "ws");
    mkdirSync(join(tree, "project", "sub"), { recursive: true });
    writeFileSync(join(tree, "project", "sub", "a.txt"), "a");
    symlinkSync(outside, join(tree, "project", "link"));
    removeSharedTree(tree);
    expect(existsSync(tree)).toBe(false);
    expect(existsSync(keep)).toBe(true);
  });

  it("is a no-op for a missing folder", () => {
    expect(() => removeSharedTree(join(tempDir(), "missing"))).not.toThrow();
  });
});

describe("agentRunDirPath", () => {
  it("is ~/.4pm/run/<profile name>", () => {
    expect(agentRunDirPath("/x/profiles/mcacc2")).toBe(join(homedir(), ".4pm", "run", "mcacc2"));
  });
});
