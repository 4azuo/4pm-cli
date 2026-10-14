/**
 * agent-user tests — removing a shared tree deletes it without following symlinks, and the run-dir path
 * is per profile, and a staged install tree gets the image's readable modes.
 * @adr 0487 @adr 0499
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentRunDirPath, readableInstallTree, removeSharedTree } from "./agent-user";

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

describe.skipIf(process.platform === "win32")("readableInstallTree", () => {
  const mode = (p: string): number => statSync(p).mode & 0o777;

  /** A staged-update-like tree written under umask 077. */
  function lockedTree(): string {
    const root = join(tempDir(), "4pm-cli");
    mkdirSync(join(root, "dist"), { recursive: true });
    writeFileSync(join(root, "dist", "index.js"), "x");
    writeFileSync(join(root, "dist", "run.sh"), "x");
    chmodSync(join(root, "dist", "index.js"), 0o600);
    chmodSync(join(root, "dist", "run.sh"), 0o700);
    chmodSync(join(root, "dist"), 0o700);
    chmodSync(root, 0o700);
    return root;
  }

  afterEach(() => {
    delete process.env.FOURPM_AGENT_USER;
  });

  it("opens folders 0755 and files 0644 / 0755 (executable) when separation is on", () => {
    const root = lockedTree();
    process.env.FOURPM_AGENT_USER = "agent";
    readableInstallTree(root);
    expect(mode(root)).toBe(0o755);
    expect(mode(join(root, "dist"))).toBe(0o755);
    expect(mode(join(root, "dist", "index.js"))).toBe(0o644);
    expect(mode(join(root, "dist", "run.sh"))).toBe(0o755);
  });

  it("leaves the tree alone when separation is off", () => {
    const root = lockedTree();
    readableInstallTree(root);
    expect(mode(root)).toBe(0o700);
    expect(mode(join(root, "dist", "index.js"))).toBe(0o600);
  });
});
