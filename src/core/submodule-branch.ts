/**
 * Re-attach submodules to their declared branch after `git submodule update --init`. That command leaves
 * each submodule on a **detached HEAD** at the recorded gitlink, so the worker's clone shows no branch even
 * when it sits exactly on the `.gitmodules` branch's tip. This helper only **names** the position — it never
 * moves HEAD or rewrites a branch that holds other commits — so it is safe after any submodule update.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/** Run git in `cwd` and return stdout, or "" on any failure (callers treat "" as "no"). */
async function gitQuiet(cwd: string, args: string[]): Promise<string> {
  try {
    return (await execFileP("git", args, { cwd, timeout: 60_000, windowsHide: true })).stdout;
  } catch {
    return "";
  }
}

/** One `.gitmodules` entry: its folder + declared branch ("" when none). */
interface SubmoduleBranch {
  dir: string;
  branch: string;
}

/** Read every submodule folder with its declared `branch` from `.gitmodules`. */
async function declaredBranches(root: string): Promise<SubmoduleBranch[]> {
  if (!existsSync(join(root, ".gitmodules"))) return [];
  const lines = (await gitQuiet(root, ["config", "-f", ".gitmodules", "--get-regexp", "^submodule\\..*\\.path$"])).split("\n").filter(Boolean);
  const out: SubmoduleBranch[] = [];
  for (const line of lines) {
    const [key = "", ...rest] = line.split(" ");
    const name = key.replace(/^submodule\./, "").replace(/\.path$/, "");
    const branch = (await gitQuiet(root, ["config", "-f", ".gitmodules", `submodule.${name}.branch`])).trim();
    out.push({ dir: rest.join(" "), branch });
  }
  return out;
}

/**
 * Attach one detached submodule to `branch` when HEAD is exactly `origin/<branch>`'s tip: creates (or keeps)
 * the local branch tracking `origin/<branch>`. Skips (stays detached) when HEAD is elsewhere, the tree is
 * dirty, or a local `<branch>` already points at a different commit. Returns whether it attached.
 */
export async function attachSubmoduleBranch(abs: string, branch: string): Promise<boolean> {
  if (!branch || !existsSync(join(abs, ".git"))) return false;
  if ((await gitQuiet(abs, ["rev-parse", "--abbrev-ref", "HEAD"])).trim() !== "HEAD") return false; // already on a branch
  if ((await gitQuiet(abs, ["status", "--porcelain"])).trim()) return false;
  const head = (await gitQuiet(abs, ["rev-parse", "HEAD"])).trim();
  const remote = (await gitQuiet(abs, ["rev-parse", "--verify", "-q", `refs/remotes/origin/${branch}`])).trim();
  if (!head || remote !== head) return false;
  const local = (await gitQuiet(abs, ["rev-parse", "--verify", "-q", `refs/heads/${branch}`])).trim();
  if (local && local !== head) return false; // never reset a local branch that holds other commits
  const args = local ? ["checkout", "-q", branch] : ["checkout", "-q", "-b", branch, "--track", `origin/${branch}`];
  await gitQuiet(abs, args);
  return (await gitQuiet(abs, ["rev-parse", "--abbrev-ref", "HEAD"])).trim() === branch;
}

/** Attach every submodule of `root` (or only `dirs`) that sits detached on its declared branch's tip. Never throws. */
export async function attachSubmoduleBranches(root: string, dirs?: string[]): Promise<void> {
  for (const s of await declaredBranches(root)) {
    if (dirs && !dirs.includes(s.dir)) continue;
    await attachSubmoduleBranch(join(root, s.dir), s.branch).catch(() => false);
  }
}
