/**
 * Keeping a task branch current with `<base>`: merge the base into the branch when a task resumes and
 * again just before delivery (merge, never rebase — the WIP is shared on the remote), detect a conflict,
 * judge whether the agent resolved it (no unmerged path, no conflict marker left), and deliver a task
 * straight into `<base>` with a `--no-ff` merge in a temporary worktree when the project skips PRs.
 * @adr 0539
 */
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { git, gitQuiet } from "./autonomous-git";

/** The committer of the cli's own merge commits (a worker may have no git identity). */
const ID = ["-c", "user.name=4PM", "-c", "user.email=noreply@4pm.app"];

/** Outcome of merging the base into a branch. */
export type MergeOutcome = { kind: "clean" } | { kind: "conflict"; paths: string[] };

/** The paths still unmerged in `cwd`. */
export async function unmergedPaths(cwd: string): Promise<string[]> {
  return (await gitQuiet(cwd, ["diff", "--name-only", "--diff-filter=U"])).split("\n").filter(Boolean);
}

/** Is a merge in progress in `cwd`? */
export async function mergeInProgress(cwd: string): Promise<boolean> {
  return (await gitQuiet(cwd, ["rev-parse", "-q", "--verify", "MERGE_HEAD"])).trim().length > 0;
}

/**
 * Merge `refs` (e.g. `origin/<base>`) into the checked-out branch of `cwd`. A clean merge is committed with
 * `message`; on a conflict the merge is LEFT IN PROGRESS and the conflicted paths are returned.
 */
export async function mergeRefs(cwd: string, refs: readonly string[], message: string): Promise<MergeOutcome> {
  const present: string[] = [];
  for (const ref of refs) if ((await gitQuiet(cwd, ["rev-parse", "-q", "--verify", ref])).trim()) present.push(ref);
  if (present.length === 0) return { kind: "clean" };
  try {
    await git(cwd, [...ID, "merge", "--no-edit", "-m", message, ...present], 300_000);
    return { kind: "clean" };
  } catch (err) {
    const paths = await unmergedPaths(cwd);
    if (paths.length) return { kind: "conflict", paths };
    // Not a conflict (e.g. unrelated histories) — leave the branch as it was.
    if (await mergeInProgress(cwd)) await gitQuiet(cwd, ["merge", "--abort"]);
    throw err;
  }
}

/** A line that opens / separates / closes a conflict hunk. */
const MARKER = /^(<{7}|={7}|>{7})(\s|$)/m;

/**
 * Did the agent resolve the conflict in `cwd`? No unmerged path and no conflict marker left in any of the
 * originally conflicted `paths` (a deleted path counts as resolved).
 */
export async function conflictResolved(cwd: string, paths: readonly string[]): Promise<boolean> {
  if ((await unmergedPaths(cwd)).length) return false;
  for (const p of paths) {
    const text = await readFile(join(cwd, p), "utf8").catch(() => "");
    if (MARKER.test(text)) return false;
  }
  return true;
}

/** Commit a resolved, still-open merge (`git add -A` + commit with the prepared message). */
export async function concludeMerge(cwd: string): Promise<void> {
  if (!(await mergeInProgress(cwd))) return;
  await git(cwd, ["add", "-A"]);
  await git(cwd, [...ID, "commit", "--no-edit", "-q"]);
}

/** Put `cwd` back to `head` (the pre-merge WIP), dropping an open merge and anything after it. */
export async function resetToHead(cwd: string, head: string): Promise<void> {
  if (await mergeInProgress(cwd)) await gitQuiet(cwd, ["merge", "--abort"]);
  await git(cwd, ["reset", "-q", "--hard", head]);
}

/** Why a direct merge into `<base>` did not happen. */
export type DirectMergeFailure = "conflict" | "protected" | "rejected";

/**
 * Merge `branch` into `origin/<base>` with `--no-ff` in a temporary detached worktree and push the result to
 * `<base>` (never forced); `pointers` move the root's submodule links to the submodules' own merge commits. A non-fast-forward rejection (the base moved) is retried up to 3 times; a conflict or
 * any other rejection returns the failure and leaves `<base>` untouched.
 */
export async function directMerge(
  cwd: string,
  branch: string,
  base: string,
  message: string,
  pointers: readonly { dir: string; sha: string }[] = [],
): Promise<{ ok: true; sha: string } | { ok: false; reason: DirectMergeFailure; detail: string }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    await git(cwd, ["fetch", "-q", "origin", base]);
    // A submodule's `.git` is a file — the temporary worktree goes under its real git dir.
    const gitDir = (await git(cwd, ["rev-parse", "--absolute-git-dir"])).trim();
    const dir = join(gitDir, `4pm-merge-${process.pid}-${Date.now()}`);
    await git(cwd, ["worktree", "add", "-q", "--detach", dir, `origin/${base}`]);
    try {
      try {
        await git(dir, [...ID, "merge", "--no-ff", "--no-edit", "-m", message, branch], 300_000);
      } catch (err) {
        return { ok: false, reason: "conflict", detail: err instanceof Error ? err.message : String(err) };
      }
      // The root's submodules point at their own new merge commits on their bases.
      if (pointers.length) {
        for (const p of pointers) await git(dir, ["update-index", "--cacheinfo", `160000,${p.sha},${p.dir}`]);
        await git(dir, [...ID, "commit", "--amend", "--no-edit", "-q"]);
      }
      const sha = (await git(dir, ["rev-parse", "HEAD"])).trim();
      try {
        await git(dir, ["push", "-q", "origin", `HEAD:refs/heads/${base}`], 180_000);
        return { ok: true, sha };
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        if (/non-fast-forward|fetch first|rejected.*\(fetch first\)/i.test(detail) && attempt < 2) continue;
        return { ok: false, reason: /protected|GH006|pre-receive|not allowed/i.test(detail) ? "protected" : "rejected", detail };
      }
    } finally {
      await gitQuiet(cwd, ["worktree", "remove", "--force", dir]);
      await gitQuiet(cwd, ["worktree", "prune"]);
    }
  }
  return { ok: false, reason: "rejected", detail: "the base kept moving" };
}

/**
 * Would `branch` merge cleanly into `origin/<base>` now? A dry run (`git merge-tree --write-tree`, nothing is
 * written to a branch). Null when the git version cannot tell.
 */
export async function mergesCleanly(cwd: string, base: string, branch: string): Promise<boolean | null> {
  try {
    await git(cwd, ["merge-tree", "--write-tree", "--quiet", `origin/${base}`, branch]);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return /usage|unknown option/i.test(msg) ? null : false;
  }
}
