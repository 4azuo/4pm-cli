/**
 * Autonomous git steps (ADR-0371) — everything the cycle does with git runs here, in code, never in the
 * agent: resolve each repo's `<base>` explicitly (spec / `.gitmodules`, else origin/HEAD — never the
 * checked-out branch), sync `<base>`, publish the books to `<base>` as an optimistic lock (a rejected
 * non-fast-forward push = a lost race ⇒ reset + re-evaluate), prepare the task branch
 * `dev/<base>/<GROUP>/<TSK>` in the root and each submodule, save work in progress, and deliver
 * (push + PR into each repo's base).
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { EVIDENCE_ROOT } from "@4pm/dto";
import { ATTEMPTS_REL } from "./autonomous-books";
import { openPullRequest, prStateOf } from "./git-host";
import { attachSubmoduleBranches } from "./submodule-branch";

const run = promisify(execFile);

/**
 * The book files + sidecars — with the evidence folder (`addEvidence`, ADR-0404) the ONLY paths ever pushed
 * straight to `<base>` (ADR-0371 §1).
 */
export const BOOK_PATHS = [
  "AI_TODO.md",
  "AI_DONE.md",
  "AI_PROGRESS.md",
  "USER_TODO.md",
  "USER_QA.md",
  ".claude/.autonomous.approvals.json",
  ".claude/.autonomous.authors.json",
  ATTEMPTS_REL,
];

/**
 * Stage the book evidence folder (ADR-0404) — additions, edits and deletions. Separate from `BOOK_PATHS`
 * so an absent folder (nothing to commit) never fails the books' own `git add`.
 */
async function addEvidence(root: string): Promise<void> {
  const tracked = (await gitQuiet(root, ["ls-files", "--", EVIDENCE_ROOT])).trim();
  if (tracked || existsSync(join(root, EVIDENCE_ROOT))) await gitQuiet(root, ["add", "-A", "--", EVIDENCE_ROOT]);
}

/** Run git; throws (with stderr in the message) on failure. */
export async function git(cwd: string, args: string[], timeout = 120_000): Promise<string> {
  try {
    const { stdout } = await run("git", args, { cwd, timeout, maxBuffer: 32 * 1024 * 1024 });
    return stdout;
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    throw new Error((e.stderr || e.message || String(err)).trim().split("\n").slice(-3).join(" "), { cause: err });
  }
}

/** Run git; "" on failure. */
export async function gitQuiet(cwd: string, args: string[], timeout = 60_000): Promise<string> {
  try {
    return await git(cwd, args, timeout);
  } catch {
    return "";
  }
}

/** One repo the cycle works in: the root ("" subdir) or a submodule. */
export interface RepoBase {
  /** "" = the project root; else the submodule folder. */
  dir: string;
  url: string;
  base: string;
}

/** The remote's default branch of a checkout (origin/HEAD), or "". */
async function remoteDefault(cwd: string): Promise<string> {
  const ref = (await gitQuiet(cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])).trim();
  if (ref) return ref.replace(/^origin\//, "");
  const out = await gitQuiet(cwd, ["ls-remote", "--symref", "origin", "HEAD"]);
  return /ref: refs\/heads\/(\S+)\s+HEAD/.exec(out)?.[1] ?? "";
}

/**
 * Resolve `<base>` for the root (the spec's primary `branch`) and each submodule (its `.gitmodules`
 * `branch`), falling back to the remote default — never the checked-out branch (ADR-0371 §1).
 */
export async function resolveBases(root: string): Promise<{ root: RepoBase; subs: RepoBase[] }> {
  let declared = "";
  let url = "";
  try {
    const spec = JSON.parse(await readFile(join(root, "project.spec.json"), "utf8")) as { repos?: { primary?: boolean; branch?: string; url?: string }[] };
    const primary = spec.repos?.find((r) => r.primary) ?? spec.repos?.[0];
    declared = primary?.branch?.trim() ?? "";
    url = primary?.url?.trim() ?? "";
  } catch {
    // no spec ⇒ remote default
  }
  if (!url) url = (await gitQuiet(root, ["remote", "get-url", "origin"])).trim();
  const rootBase: RepoBase = { dir: "", url, base: declared || (await remoteDefault(root)) };
  const subs: RepoBase[] = [];
  if (existsSync(join(root, ".gitmodules"))) {
    const paths = (await gitQuiet(root, ["config", "-f", ".gitmodules", "--get-regexp", "^submodule\\..*\\.path$"])).split("\n").filter(Boolean);
    for (const line of paths) {
      const [key = "", ...rest] = line.split(" ");
      const name = key.replace(/^submodule\./, "").replace(/\.path$/, "");
      const dir = rest.join(" ");
      const subUrl = (await gitQuiet(root, ["config", "-f", ".gitmodules", `submodule.${name}.url`])).trim();
      const b = (await gitQuiet(root, ["config", "-f", ".gitmodules", `submodule.${name}.branch`])).trim();
      const abs = join(root, dir);
      subs.push({ dir, url: subUrl, base: b || (existsSync(join(abs, ".git")) ? await remoteDefault(abs) : "") });
    }
  }
  return { root: rootBase, subs };
}

/** Does `origin/<branch>` exist (after a fetch)? */
export async function hasRemoteBranch(cwd: string, branch: string): Promise<boolean> {
  return (await gitQuiet(cwd, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`])).trim().length > 0;
}

/** Current branch name ("" when detached). */
export async function currentBranch(cwd: string): Promise<string> {
  const b = (await gitQuiet(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  return b === "HEAD" ? "" : b;
}

/** Commit everything in `cwd` as a work-in-progress snapshot; true when something was committed. */
export async function wipCommit(cwd: string, message: string): Promise<boolean> {
  await gitQuiet(cwd, ["add", "-A"]);
  const staged = (await gitQuiet(cwd, ["diff", "--cached", "--name-only"])).trim();
  if (!staged) return false;
  await git(cwd, ["-c", "user.name=4PM", "-c", "user.email=noreply@4pm.app", "commit", "-q", "-m", message]).catch(() => undefined);
  return true;
}

/**
 * Phase 1 (ADR-0371): leave the working tree on a fresh `<base>` so the books are current. A dirty task
 * branch is first saved (`wip:` commit — nothing is lost); a dirty tree on any other branch is stashed.
 */
export async function syncBase(root: string, base: string): Promise<void> {
  const cur = await currentBranch(root);
  if ((await gitQuiet(root, ["status", "--porcelain"])).trim()) {
    if (cur.includes("/dev/")) await wipCommit(root, "wip: autosave before sync (4PM)");
    else await gitQuiet(root, ["stash", "push", "-u", "-m", "4PM autosave"]);
  }
  await git(root, ["fetch", "-q", "--prune", "origin"]);
  if (await hasRemoteBranch(root, base)) await git(root, ["checkout", "-q", "-B", base, `origin/${base}`]);
  else await git(root, ["checkout", "-q", base]);
  await gitQuiet(root, ["submodule", "update", "--init", "-q"], 300_000);
  await attachSubmoduleBranches(root);
}

/** Outcome of a books publish. */
export type PublishResult = "pushed" | "unchanged" | "aborted" | "failed";

/**
 * Publish a change to the books on `<base>` (ADR-0371 §3): on a fresh `origin/<base>`, apply `change`
 * (it edits the book files and returns false to abort — e.g. the task is no longer free), commit only the
 * book paths, push. A non-fast-forward rejection means another worker pushed first: fetch, reset, and
 * re-apply `change` against the new state. Up to 5 attempts with jitter.
 */
export async function publishBooks(
  root: string,
  base: string,
  message: string,
  change: () => Promise<boolean>,
  opts: { detach?: boolean } = {},
): Promise<PublishResult> {
  for (let attempt = 1; attempt <= 5; attempt++) {
    await git(root, ["fetch", "-q", "origin", base]).catch(() => undefined);
    if (await hasRemoteBranch(root, base)) {
      // A side worktree works detached (the base branch may be checked out in the main worktree).
      if (opts.detach) await git(root, ["checkout", "-q", "--detach", `origin/${base}`]);
      else await git(root, ["checkout", "-q", "-B", base, `origin/${base}`]);
    }
    if (!(await change())) return "aborted";
    await gitQuiet(root, ["add", "--", ...BOOK_PATHS.filter((p) => existsSync(join(root, p)))]);
    await addEvidence(root);
    const staged = (await gitQuiet(root, ["diff", "--cached", "--name-only"])).trim();
    if (!staged) return "unchanged";
    await git(root, ["-c", "user.name=4PM", "-c", "user.email=noreply@4pm.app", "commit", "-q", "-m", message]);
    try {
      await git(root, ["push", "-q", "origin", `HEAD:refs/heads/${base}`]);
      return "pushed";
    } catch (err) {
      const msg = String(err);
      if (!/non-fast-forward|fetch first|rejected|stale info/i.test(msg)) return "failed";
      await new Promise((r) => setTimeout(r, 500 + Math.random() * 2000 * attempt));
    }
  }
  return "failed";
}

/**
 * Publish the agent's intake edits (already in the working tree on `<base>`): commit the books, push, and
 * on a rejection rebase onto the fresh `<base>` once more; a conflict aborts and discards this intake
 * (it re-runs next cycle).
 */
export async function publishIntake(root: string, base: string, message: string): Promise<PublishResult> {
  await gitQuiet(root, ["add", "--", ...BOOK_PATHS.filter((p) => existsSync(join(root, p)))]);
  await addEvidence(root);
  const staged = (await gitQuiet(root, ["diff", "--cached", "--name-only"])).trim();
  // Anything else the agent touched is not intake — drop it (intake edits the books only).
  await gitQuiet(root, ["checkout", "--", "."]);
  await gitQuiet(root, ["clean", "-fdq", "--", "."]);
  if (!staged) return "unchanged";
  await git(root, ["-c", "user.name=4PM", "-c", "user.email=noreply@4pm.app", "commit", "-q", "-m", message]);
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await git(root, ["push", "-q", "origin", `HEAD:refs/heads/${base}`]);
      return "pushed";
    } catch {
      await gitQuiet(root, ["fetch", "-q", "origin", base]);
      try {
        await git(root, ["rebase", "-q", `origin/${base}`]);
      } catch {
        await gitQuiet(root, ["rebase", "--abort"]);
        await gitQuiet(root, ["reset", "-q", "--hard", `origin/${base}`]);
        return "aborted";
      }
    }
  }
  return "failed";
}

/** The book text of `<base>` as on the remote (read without switching branches). */
export async function remoteBook(cwd: string, base: string, rel: string): Promise<string> {
  await gitQuiet(cwd, ["fetch", "-q", "origin", base]);
  return gitQuiet(cwd, ["show", `origin/${base}:${rel}`]);
}

/** Has `origin/<branch>` been merged into `<base>`? Host PR state first, then ancestry (ADR-0371 §5). */
export async function isMerged(cwd: string, url: string, branch: string, base: string): Promise<boolean> {
  const state = await prStateOf(url, branch);
  if (state === "merged") return true;
  if (state === "open" || state === "closed") return false;
  if (!(await hasRemoteBranch(cwd, branch))) return true; // no PR info, branch deleted ⇒ merged
  try {
    await git(cwd, ["merge-base", "--is-ancestor", `origin/${branch}`, `origin/${base}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check out the task branch in one repo (ADR-0371 §5): its pushed WIP if any, else from `from` (the
 * single unmerged dependency's branch) when it exists on the remote, else from `<base>`.
 */
export async function checkoutTaskBranch(cwd: string, branch: string, base: string, from: string | null): Promise<void> {
  await git(cwd, ["fetch", "-q", "--prune", "origin"]);
  const local = (await gitQuiet(cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])).trim();
  if (await hasRemoteBranch(cwd, branch)) {
    // Resume the pushed work in progress (a local branch ahead of it — this worker's own WIP — wins).
    if (local && (await gitQuiet(cwd, ["merge-base", "--is-ancestor", `origin/${branch}`, branch]).then(() => true, () => false))) {
      await git(cwd, ["checkout", "-q", branch]);
    } else await git(cwd, ["checkout", "-q", "-B", branch, `origin/${branch}`]);
    return;
  }
  if (local) {
    await git(cwd, ["checkout", "-q", branch]);
    return;
  }
  const start = from && (await hasRemoteBranch(cwd, from)) ? `origin/${from}` : `origin/${base}`;
  await git(cwd, ["checkout", "-q", "-B", branch, start]);
}

/** Commits on `branch` not on `origin/<base>`. */
export async function aheadOf(cwd: string, branch: string, base: string): Promise<number> {
  return Number((await gitQuiet(cwd, ["rev-list", "--count", `origin/${base}..${branch}`])).trim()) || 0;
}

/** Push a task branch (set upstream). */
export async function pushBranch(cwd: string, branch: string): Promise<void> {
  await git(cwd, ["push", "-q", "-u", "origin", `${branch}:refs/heads/${branch}`], 180_000);
}

/** Open (or find) the PR of `branch` into `base`. */
export async function deliverPr(cwd: string, url: string, branch: string, base: string, title: string, body: string): Promise<{ url: string | null; error: string | null }> {
  return openPullRequest({ url, cwd, base, head: branch, title, body });
}

/**
 * Apply a book edit made OUTSIDE the cycle (the web: approvals, book saves, posted requests — ADR-0371)
 * straight onto `<base>` without touching the worker's working tree (it may be on a task branch): a
 * temporary detached worktree of `origin/<base>` runs `publishBooks`, then is removed. `fn` edits the
 * books under the given dir and returns false to abort. Returns "unchanged" when `<base>` has no remote.
 */
export async function mutateBooksOnBase(root: string, base: string, message: string, fn: (dir: string) => Promise<boolean>): Promise<PublishResult> {
  await git(root, ["fetch", "-q", "origin", base]).catch(() => undefined);
  if (!(await hasRemoteBranch(root, base))) return "unchanged";
  const dir = join(root, ".git", `4pm-books-${process.pid}-${Date.now()}`);
  await git(root, ["worktree", "add", "-q", "--detach", dir, `origin/${base}`]);
  try {
    return await publishBooks(dir, base, message, () => fn(dir), { detach: true });
  } finally {
    await gitQuiet(root, ["worktree", "remove", "--force", dir]);
    await gitQuiet(root, ["worktree", "prune"]);
  }
}

/** Last `git fetch origin <base>` per repo (reads within 15 s reuse it). */
const lastFetch = new Map<string, number>();

/** A book file as on `origin/<base>` (fetched at most every 15 s); null when unavailable. */
export async function readBaseFile(root: string, base: string, rel: string): Promise<string | null> {
  const key = `${root}\u0000${base}`;
  if (Date.now() - (lastFetch.get(key) ?? 0) > 15_000) {
    await gitQuiet(root, ["fetch", "-q", "origin", base]);
    lastFetch.set(key, Date.now());
  }
  if (!(await hasRemoteBranch(root, base))) return null;
  try {
    return await git(root, ["show", `origin/${base}:${rel}`]);
  } catch {
    return "";
  }
}
