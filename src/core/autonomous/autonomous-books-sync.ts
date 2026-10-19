/**
 * Books sync — brings the books set into `<base>` so the base branch holds the whole project (code, docs, mockups,
 * sequences AND the books, sidecars, discussions, ER, diagram and archive). A 4PM branch
 * `autonomous-books-sync/<base>` carries one commit on top of `origin/<base>` that sets every books-set path to the
 * books branch's version (and removes books-set paths the books branch does not have), so
 * its diff against `<base>` is the books set only. One PR is kept open and refreshed at most every
 * `booksSyncMinutes`; with `skipPullRequest` the commit is merged directly. The sync branch is 4PM's own and is
 * rewritten on each refresh (force-with-lease) — work branches are never force-pushed. Work PRs never touch the
 * books set, so the sync PR never conflicts with them.
 * @adr 0563
 */
import { join } from "node:path";
import { isBooksSetPath } from "@4pm/dto";
import type { AutonomousConfig } from "./autonomous-config";
import { booksDirsNow, deliverPr, git, gitQuiet, hasRemoteBranch, type RepoBase } from "./autonomous-git";
import { directMerge } from "./autonomous-merge";
import { booksBranch } from "./autonomous-tasks";

/** The sync branch of a base. */
export function booksSyncBranch(base: string): string {
  return `autonomous-books-sync/${base}`;
}

/** The last refresh per served root (this process). */
const lastSync = new Map<string, number>();

/** The 4PM commit identity. */
const IDENT = ["-c", "user.name=4PM", "-c", "user.email=noreply@4pm.app"];

/** What a sync attempt did. */
export type BooksSyncResult = "skipped" | "unchanged" | "opened" | "merged" | "failed";

/**
 * Refresh the books-sync PR (or merge it directly) when the debounce allows: build the sync commit in a temporary
 * worktree, push it when its tree differs from the sync branch, then open / keep the PR. Best-effort — a failure
 * is reported, never thrown.
 * @adr 0563
 */
export async function syncBooksToBase(
  root: string,
  rootBase: RepoBase,
  cfg: Pick<AutonomousConfig, "booksSyncMinutes" | "skipPullRequest">,
  log: (line: string) => Promise<void>,
): Promise<BooksSyncResult> {
  const base = rootBase.base;
  const last = lastSync.get(root) ?? 0;
  if (Date.now() - last < cfg.booksSyncMinutes * 60_000) return "skipped";
  lastSync.set(root, Date.now());
  const books = booksBranch(base);
  const sync = booksSyncBranch(base);
  await gitQuiet(root, ["fetch", "-q", "origin", base, books]);
  await gitQuiet(root, ["fetch", "-q", "origin", sync]);
  if (!(await hasRemoteBranch(root, base)) || !(await hasRemoteBranch(root, books))) return "skipped";
  const dir = join(root, ".git", `4pm-books-sync-${process.pid}-${Date.now()}`);
  await git(root, ["worktree", "add", "-q", "--detach", dir, `origin/${base}`]);
  try {
    const dirs = booksDirsNow();
    const fromBooks = new Set((await gitQuiet(dir, ["ls-tree", "-r", "--name-only", `origin/${books}`])).split("\n").filter(Boolean));
    const onBase = (await gitQuiet(dir, ["ls-files"])).split("\n").filter(Boolean);
    const drop = onBase.filter((p) => !fromBooks.has(p) && isBooksSetPath(p, dirs));
    for (let i = 0; i < drop.length; i += 200) await gitQuiet(dir, ["rm", "-q", "--", ...drop.slice(i, i + 200)]);
    if (fromBooks.size) await git(dir, ["checkout", `origin/${books}`, "--", "."]);
    if (!(await gitQuiet(dir, ["diff", "--cached", "--name-only"])).trim()) return "unchanged";
    await git(dir, [...IDENT, "commit", "-q", "-m", `chore(books): sync the autonomous books into ${base} (4PM)`]);
    const tree = (await gitQuiet(dir, ["rev-parse", "HEAD^{tree}"])).trim();
    const remoteTree = (await hasRemoteBranch(root, sync)) ? (await gitQuiet(root, ["rev-parse", `origin/${sync}^{tree}`])).trim() : "";
    const sha = (await gitQuiet(dir, ["rev-parse", "HEAD"])).trim();
    if (tree !== remoteTree) {
      await git(dir, ["push", "-q", "--force-with-lease", "origin", `HEAD:refs/heads/${sync}`], 180_000);
      await gitQuiet(root, ["fetch", "-q", "origin", sync]);
    }
    if (cfg.skipPullRequest) {
      const merged = await directMerge(root, sha, base, `Merge the autonomous books into ${base} (4PM)`);
      if (merged.ok) {
        await log(`[books-sync] merged into ${base}: ${merged.sha.slice(0, 10)}`);
        return "merged";
      }
      await log(`[books-sync] direct merge failed (${merged.reason}) — a PR is opened instead`);
    }
    const pr = await deliverPr(
      root,
      rootBase.url,
      sync,
      base,
      `4PM: sync the autonomous books into ${base}`,
      "The books, records, discussions, ER, system diagram and archive of 4PM autonomous, as on the books branch. Only books paths change (ADR-0563).",
    );
    if (pr.error) {
      await log(`[books-sync] PR: ${pr.error}`);
      return "failed";
    }
    await log(`[books-sync] PR ${pr.url ?? "open"}`);
    return "opened";
  } catch (err) {
    await log(`[warn] books sync: ${err instanceof Error ? err.message : String(err)}`);
    return "failed";
  } finally {
    await gitQuiet(root, ["worktree", "remove", "--force", dir]);
    await gitQuiet(root, ["worktree", "prune"]);
  }
}
