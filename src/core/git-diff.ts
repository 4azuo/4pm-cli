/**
 * Git diff on the worker (git.diff channel): return a file's content at HEAD
 * (old) and in the working tree (new) so the dashboard can render a Monaco diff
 * (e.g. what the AI changed). Untracked/new files ⇒ empty old content.
 */
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { basename, dirname, resolve } from "node:path";
import { promisify } from "node:util";
import type { GitDiffReply } from "@4pm/ws";

const run = promisify(execFile);

/** Read HEAD vs working-tree content for one file. Never throws. */
export async function gitDiff(path: string): Promise<GitDiffReply> {
  const target = resolve(path);
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
