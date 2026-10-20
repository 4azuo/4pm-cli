/**
 * Repo provisioning heals a folder an older cli wrote into before any clone: a `.git` without `HEAD` is removed, and
 * when only cli leftovers (`.4pm`, `.claude/rag`) remain they are removed too; other content is left alone.
 * @adr 0572 @adr 0573
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureReposCloned } from "./scaffold";

describe("ensureReposCloned over repo-less leftovers", () => {
  let base: string;
  let remote: string;
  let root: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "4pm-leftover-"));
    // A tiny origin with one commit on `main`.
    const seed = join(base, "seed");
    mkdirSync(seed);
    const git = (cwd: string, args: string[]): void => void execFileSync("git", args, { cwd, stdio: "ignore" });
    git(seed, ["init", "-q", "-b", "main"]);
    writeFileSync(join(seed, "README.md"), "hi\n");
    git(seed, ["add", "."]);
    git(seed, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init"]);
    remote = join(base, "remote.git");
    git(base, ["clone", "-q", "--bare", seed, remote]);
    // The folder an empty-folder tick left behind.
    root = join(base, "project");
    mkdirSync(join(root, ".git", "info"), { recursive: true });
    writeFileSync(join(root, ".git", "info", "exclude"), "/.4pm/logs/\n");
    mkdirSync(join(root, ".4pm", "logs"), { recursive: true });
    writeFileSync(join(root, ".4pm", "logs", "autonomous-tick.log"), "[skip]\n");
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it("removes the stray .git and the leftovers, then clones", async () => {
    mkdirSync(join(root, ".claude", "rag"), { recursive: true });
    writeFileSync(join(root, ".claude", "rag", "settings.json"), "{}\n");
    await ensureReposCloned(root, [{ primary: true, url: remote, branch: "main" }]);
    expect(existsSync(join(root, ".git", "HEAD"))).toBe(true);
    expect(existsSync(join(root, "README.md"))).toBe(true);
    expect(existsSync(join(root, ".4pm", "logs", "autonomous-tick.log"))).toBe(false);
    expect(existsSync(join(root, ".claude", "rag"))).toBe(false);
  });

  it("clones over leftovers without any .git", async () => {
    rmSync(join(root, ".git"), { recursive: true, force: true });
    await ensureReposCloned(root, [{ primary: true, url: remote, branch: "main" }]);
    expect(existsSync(join(root, "README.md"))).toBe(true);
    expect(existsSync(join(root, ".4pm"))).toBe(false);
  });

  it("keeps other content (the clone then fails)", async () => {
    writeFileSync(join(root, "notes.txt"), "mine\n");
    await expect(ensureReposCloned(root, [{ primary: true, url: remote, branch: "main" }])).rejects.toThrow();
    expect(existsSync(join(root, "notes.txt"))).toBe(true);
    expect(existsSync(join(root, ".4pm", "logs", "autonomous-tick.log"))).toBe(true);
  });
});
