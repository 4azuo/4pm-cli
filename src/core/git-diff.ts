/**
 * Git diff on the worker (git.diff channel): return a file's content at HEAD
 * (old) and in the working tree (new) so the dashboard can render a Monaco diff
 * (e.g. what the AI changed). Untracked/new files ⇒ empty old content. The path is
 * resolved **relative to the physic-project root** and clamped to it (ADR-0281) — the
 * browser addresses files by project-relative paths, never out of the served root.
 */
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { basename, dirname, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { GitDiffReply } from "@4pm/ws";

const run = promisify(execFile);

/**
 * Resolve `relPath` inside `root`; return null when there is no root or the path escapes it.
 * Accepts a relative path (the web) or an absolute path already inside the root (older clients).
 */
function resolveInRoot(root: string | null, relPath: string): string | null {
  if (!root) return null;
  const base = resolve(root);
  const target = resolve(base, relPath || ".");
  return target === base || target.startsWith(base + sep) ? target : null;
}

/** Read HEAD vs working-tree content for one file (relative to the physic root). Never throws. */
export async function gitDiff(root: string | null, path: string): Promise<GitDiffReply> {
  const target = resolveInRoot(root, path);
  if (!target) {
    return { path, oldContent: "", newContent: "" };
  }
  const dir = dirname(target);
  const base = basename(target);
  let newContent = "";
  try {
    newContent = await readFile(target, "utf8");
  } catch {
    // missing/unreadable ⇒ empty
  }
  let oldContent = "";
  try {
    const { stdout } = await run("git", ["show", `HEAD:./${base}`], {
      cwd: dir,
      timeout: 15_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    oldContent = stdout;
  } catch {
    // untracked/new file or not a git repo ⇒ no old content
  }
  return { path: target, oldContent, newContent };
}
