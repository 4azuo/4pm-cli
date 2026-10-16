/**
 * Autonomous git steps — everything the cycle does with git runs here, in code, never in the
 * agent: resolve each repo's `<base>` explicitly (spec / `.gitmodules`, else origin/HEAD — never the
 * checked-out branch), sync the books branch `autonomous-books/<base>` (which follows `<base>`), publish
 * the books there as an optimistic lock (a rejected non-fast-forward push = a lost race ⇒ reset +
 * re-evaluate), prepare the task branch `dev/<base>/<GROUP>/<TSK>` from `<base>` in the root and each
 * submodule, save work in progress, and deliver (push + PR into each repo's base). `<base>` itself only
 * ever changes through PRs, so it can be protected. The ER folder and the sequence diagrams are books-branch
 * only too: stripped from task branches like the sidecars.
 * @adr 0371 @adr 0448 @adr 0453
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DIAGRAM_SIDECAR_REL, DISCUSSIONS_DIR, ER_SIDECAR_REL, EVIDENCE_ROOT } from "@4pm/dto";
import { ATTEMPTS_REL } from "./autonomous-books";
import { booksBranch } from "./autonomous-tasks";
import { openPullRequest, prStateOf } from "../git/git-host";
import { attachSubmoduleBranches } from "../git/submodule-branch";
import { readFileInRoot } from "../../utils/safe-path";
import { execInProject } from "../agent/agent-spawn";

// Project git runs as the agent user when uid separation is on (ADR-0430); unchanged otherwise.
const run = execInProject;

/**
 * The book files + sidecars — with the evidence / mockup folders (`addRepoDirs`) the ONLY paths ever pushed
 * to the books branch.
 * @adr 0404 @adr 0418
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
  ER_SIDECAR_REL,
  DIAGRAM_SIDECAR_REL,
];

/**
 * The cli-owned sidecars — written only by the cli's own code (web writes, claim/finish/release/split/fold),
 * never by an agent run: an agent's edits are reverted on intake and stripped from task branches.
 * @adr 0438
 */
export const SIDECAR_PATHS = [".claude/.autonomous.approvals.json", ".claude/.autonomous.authors.json", ATTEMPTS_REL, ER_SIDECAR_REL, DIAGRAM_SIDECAR_REL];

/**
 * Put the sidecars back to their version at `ref` in the working tree + index — tracked ones restored,
 * ones absent at `ref` removed. Returns the paths that differed (an agent edited them).
 * @adr 0438
 */
async function restoreSidecars(root: string, ref: string): Promise<string[]> {
  const changed: string[] = [];
  for (const p of SIDECAR_PATHS) {
    const atRef = (await gitQuiet(root, ["ls-tree", "--name-only", ref, "--", p])).trim() !== "";
    if (atRef) {
      const diff = (await gitQuiet(root, ["diff", "--name-only", ref, "--", p])).trim();
      if (!diff) continue;
      await gitQuiet(root, ["checkout", ref, "--", p]);
      changed.push(p);
    } else if (existsSync(join(root, p))) {
      await gitQuiet(root, ["rm", "-q", "--cached", "--ignore-unmatch", "--", p]);
      await gitQuiet(root, ["clean", "-fq", "--", p]);
      changed.push(p);
    }
  }
  return changed;
}

/**
 * Put the discussion files back to `ref` — they are written only by the cli's discussion batches, never by
 * an agent run. Returns `[".4pm/discussions"]` when the agent changed them, else `[]`.
 * @adr 0454
 */
async function restoreDiscussions(root: string, ref: string): Promise<string[]> {
  return restoreDirToRef(root, ref, DISCUSSIONS_DIR);
}

/**
 * Put one repo folder back to `ref` (working tree + index): files added since are dropped, the others
 * restored. Returns `[dir]` when anything differed, else `[]`.
 * @adr 0454 @adr 0453
 */
export async function restoreDirToRef(root: string, ref: string, dir: string): Promise<string[]> {
  const atRef = new Set((await gitQuiet(root, ["ls-tree", "-r", "--name-only", ref, "--", dir])).split("\n").filter(Boolean));
  const atHead = (await gitQuiet(root, ["ls-files", "--", dir])).split("\n").filter(Boolean);
  const dirty =
    (await gitQuiet(root, ["status", "--porcelain", "--", dir])).trim() !== "" ||
    (await gitQuiet(root, ["diff", "--name-only", ref, "--", dir])).trim() !== "";
  if (!dirty) return [];
  // Files the agent added (tracked now, absent at ref) leave the index; the others go back to ref.
  const added = atHead.filter((p) => !atRef.has(p));
  if (added.length) await gitQuiet(root, ["rm", "-q", "--cached", "--", ...added]);
  if (atRef.size) await gitQuiet(root, ["checkout", ref, "--", dir]);
  await gitQuiet(root, ["clean", "-fdq", "--", dir]);
  return [dir];
}

/**
 * Remove an agent's sidecar changes from a task branch before it is pushed: restore the sidecars to the
 * branch's fork point with `origin/<base>` (not the base tip — a restore to the tip would make the PR
 * rewrite whatever changed on `<base>` since) and commit the restore when anything differed, so
 * neither the branch nor its PR carries sidecar changes. Returns the reverted paths.
 * @adr 0438
 */
export async function stripSidecarsFromBranch(root: string, base: string, taskId: string, dirs: readonly string[] = []): Promise<string[]> {
  if (!(await hasRemoteBranch(root, base))) return [];
  const fork = (await gitQuiet(root, ["merge-base", "HEAD", `origin/${base}`])).trim();
  if (!fork) return [];
  // `dirs`: the books-branch-only folders (ER + sequences — ADR-0453).
  const changed = [...(await restoreSidecars(root, fork)), ...(await restoreDiscussions(root, fork))];
  for (const d of dirs) changed.push(...(await restoreDirToRef(root, fork, d)));
  if (changed.length === 0) return [];
  // Commit only the restored paths (a pathspec naming a file git does not know fails the commit).
  if ((await gitQuiet(root, ["diff", "--cached", "--name-only", "--", ...changed])).trim()) {
    await git(root, ["-c", "user.name=4PM", "-c", "user.email=noreply@4pm.app", "commit", "-q", "-m", `chore(${taskId}): restore autonomous sidecars (4PM)`, "--", ...changed]);
  }
  return changed;
}

/**
 * Stage the folders committed with the books — the evidence roots and the intake mockups:
 * additions, edits and deletions. Separate from `BOOK_PATHS` so an absent folder (nothing to
 * commit) never fails the books' own `git add`. `dirs` defaults to the default evidence root.
 * @adr 0404 @adr 0418
 */
async function addRepoDirs(root: string, dirs: string[] = [EVIDENCE_ROOT]): Promise<void> {
  for (const d of dirs) {
    const tracked = (await gitQuiet(root, ["ls-files", "--", d])).trim();
    if (tracked || existsSync(join(root, d))) await gitQuiet(root, ["add", "-A", "--", d]);
  }
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

/**
 * ISO time of the last commit on `ref` that touched each of `paths` — one `git log --name-only` over their
 * top-level folders. An uncommitted path (or a failed log) has no entry.
 * @adr 0514
 */
export async function lastCommitTimes(cwd: string, ref: string, paths: readonly string[]): Promise<Record<string, string>> {
  const want = new Set(paths);
  const out: Record<string, string> = {};
  if (want.size === 0 || !/^[A-Za-z0-9._/-]{1,200}$/.test(ref)) return out;
  // Two leading segments (e.g. `.4pm/evidence`) keep the pathspec list short however many files there are.
  const roots = [...new Set(paths.map((p) => p.split("/").slice(0, 2).join("/")))];
  const log = await gitQuiet(cwd, ["-c", "core.quotepath=off", "log", "--no-renames", "--format=%x00%cI", "--name-only", ref, "--", ...roots]);
  let at = "";
  for (const line of log.split("\n")) {
    if (line.startsWith("\0")) at = line.slice(1).trim();
    else if (line && at && want.has(line) && !(line in out)) out[line] = at;
  }
  return out;
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
 * `branch`), falling back to the remote default — never the checked-out branch.
 */
export async function resolveBases(root: string): Promise<{ root: RepoBase; subs: RepoBase[] }> {
  let declared = "";
  let url = "";
  try {
    const spec = JSON.parse(await readFileInRoot(root, join(root, "project.spec.json"), "utf8")) as { repos?: { primary?: boolean; branch?: string; url?: string }[] };
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

/**
 * Commit everything in `cwd` as a work-in-progress snapshot; true when something was committed. The
 * cli-owned sidecars are never part of it (an agent's edits to them are discarded).
 * @adr 0438
 */
export async function wipCommit(cwd: string, message: string): Promise<boolean> {
  await gitQuiet(cwd, ["add", "-A"]);
  for (const p of SIDECAR_PATHS) {
    if ((await gitQuiet(cwd, ["ls-files", "--", p])).trim()) {
      await gitQuiet(cwd, ["reset", "-q", "--", p]);
      await gitQuiet(cwd, ["checkout", "--", p]);
    }
  }
  const staged = (await gitQuiet(cwd, ["diff", "--cached", "--name-only"])).trim();
  if (!staged) return false;
  await git(cwd, ["-c", "user.name=4PM", "-c", "user.email=noreply@4pm.app", "commit", "-q", "-m", message]).catch(() => undefined);
  return true;
}

/**
 * Make sure the books branch exists on the remote: created from `origin/<base>` the first time (a ref
 * create, no checkout; a racing creator just wins). Returns the ref to work from — `origin/<books>` —
 * or null when there is no remote `<base>` (local-only repo: the books stay on the local base).
 */
export async function ensureBooksBranch(root: string, base: string): Promise<string | null> {
  const books = booksBranch(base);
  await gitQuiet(root, ["fetch", "-q", "origin", base]);
  await gitQuiet(root, ["fetch", "-q", "origin", books]);
  if (await hasRemoteBranch(root, books)) return `origin/${books}`;
  if (!(await hasRemoteBranch(root, base))) return null;
  await gitQuiet(root, ["push", "-q", "origin", `refs/remotes/origin/${base}:refs/heads/${books}`]);
  await gitQuiet(root, ["fetch", "-q", "origin", books]);
  return (await hasRemoteBranch(root, books)) ? `origin/${books}` : null;
}

/**
 * Bring `origin/<base>` into the checked-out books branch when `<base>` moved, so intake plans against
 * current code. Only book paths differ between the two branches, so a conflict can only be in them —
 * the books side wins (`-X ours`). A merge that still fails is aborted (the books stay usable).
 */
async function mergeBaseIntoBooks(root: string, base: string): Promise<void> {
  if (!(await hasRemoteBranch(root, base))) return;
  try {
    await git(root, ["merge-base", "--is-ancestor", `origin/${base}`, "HEAD"]);
    return; // already contains <base>
  } catch {
    // <base> moved — merge it below
  }
  try {
    await git(root, ["-c", "user.name=4PM", "-c", "user.email=noreply@4pm.app", "merge", "-q", "--no-edit", "-X", "ours", "-m", `chore(auto): sync ${base} into the books (4PM)`, `origin/${base}`]);
  } catch {
    await gitQuiet(root, ["merge", "--abort"]);
  }
}

/**
 * Phase 1: leave the working tree on a fresh books branch (current books + current `<base>` code). A
 * dirty task branch is first saved (`wip:` commit — nothing is lost); a dirty tree on any other branch is
 * stashed. A repo without a remote `<base>` keeps working on the local base.
 */
export async function syncBooks(root: string, base: string): Promise<string | null> {
  const cur = await currentBranch(root);
  // Uncommitted changes outside a task branch are stashed under a NAMED stash, returned so the cycle can
  // tell the managers where they went (ADR-0506) — never silently.
  let stashed: string | null = null;
  if ((await gitQuiet(root, ["status", "--porcelain"])).trim()) {
    if (cur.startsWith("dev/") || cur.includes("/dev/")) await wipCommit(root, "wip: autosave before sync (4PM)");
    else {
      const name = `4PM autosave ${new Date().toISOString()} ${cur || "detached"}`;
      await gitQuiet(root, ["stash", "push", "-u", "-m", name]);
      stashed = name;
    }
  }
  await git(root, ["fetch", "-q", "--prune", "origin"]);
  const ref = await ensureBooksBranch(root, base);
  if (ref) {
    await git(root, ["checkout", "-q", "-B", booksBranch(base), ref]);
    await mergeBaseIntoBooks(root, base);
  } else await git(root, ["checkout", "-q", base]);
  await gitQuiet(root, ["submodule", "update", "--init", "-q"], 300_000);
  await attachSubmoduleBranches(root);
  return stashed;
}

/** Outcome of a books publish. */
export type PublishResult = "pushed" | "unchanged" | "aborted" | "failed";

/**
 * Publish a change to the books on the books branch: on a fresh `origin/autonomous-books/<base>` (with
 * `<base>` merged in), apply `change` (it edits the book files and returns false to abort — e.g. the task
 * is no longer free), commit only the book paths, push. A non-fast-forward rejection means another
 * worker pushed first: fetch, reset, and re-apply `change` against the new state. Up to 5 attempts.
 */
export async function publishBooks(
  root: string,
  base: string,
  message: string | (() => string),
  change: () => Promise<boolean>,
  opts: { detach?: boolean; dirs?: string[] } = {},
): Promise<PublishResult> {
  const books = booksBranch(base);
  for (let attempt = 1; attempt <= 5; attempt++) {
    const ref = await ensureBooksBranch(root, base);
    if (ref) {
      // A side worktree works detached (the books branch may be checked out in the main worktree).
      if (opts.detach) await git(root, ["checkout", "-q", "--detach", ref]);
      else await git(root, ["checkout", "-q", "-B", books, ref]);
      await mergeBaseIntoBooks(root, base);
    }
    if (!(await change())) return "aborted";
    await gitQuiet(root, ["add", "--", ...BOOK_PATHS.filter((p) => existsSync(join(root, p)))]);
    await addRepoDirs(root, opts.dirs);
    const staged = (await gitQuiet(root, ["diff", "--cached", "--name-only"])).trim();
    if (!staged) return "unchanged";
    // A message function is read after `change` (e.g. the ER version an apply produced — ADR-0453).
    await git(root, ["-c", "user.name=4PM", "-c", "user.email=noreply@4pm.app", "commit", "-q", "-m", typeof message === "string" ? message : message()]);
    try {
      await git(root, ["push", "-q", "origin", `HEAD:refs/heads/${ref ? books : base}`]);
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
 * Publish the agent's intake edits (already in the working tree on the books branch): commit the books,
 * push, and on a rejection rebase onto the fresh books branch once more; a conflict aborts and discards
 * this intake (it re-runs next cycle).
 */
export async function publishIntake(
  root: string,
  base: string,
  message: string,
  dirs?: string[],
  onGuard?: (reverted: string[]) => void | Promise<void>,
  prepare?: (ref: string) => Promise<void>,
): Promise<PublishResult> {
  // Guard (ADR-0438): drop any commit the agent made (only the staged books below are published) and
  // put the cli-owned sidecars back — an intake agent never approves, authors or counts attempts.
  const books = booksBranch(base);
  const target = (await hasRemoteBranch(root, books)) ? books : base;
  const ref = (await hasRemoteBranch(root, target)) ? `origin/${target}` : "HEAD";
  if (ref !== "HEAD") await gitQuiet(root, ["reset", "-q", ref]);
  const reverted = [...(await restoreSidecars(root, ref)), ...(await restoreDiscussions(root, ref))];
  if (reverted.length && onGuard) await onGuard(reverted);
  // The cli's own post-intake step (ADR-0453: restore the approved ER, number new change requests).
  if (prepare) await prepare(ref);
  await gitQuiet(root, ["add", "--", ...BOOK_PATHS.filter((p) => existsSync(join(root, p)))]);
  // The evidence roots + the mockup folder the intake agent may write (ADR-0418).
  await addRepoDirs(root, dirs);
  const staged = (await gitQuiet(root, ["diff", "--cached", "--name-only"])).trim();
  // Anything else the agent touched is not intake — drop it (intake edits the books only).
  await gitQuiet(root, ["checkout", "--", "."]);
  await gitQuiet(root, ["clean", "-fdq", "--", "."]);
  if (!staged) return "unchanged";
  await git(root, ["-c", "user.name=4PM", "-c", "user.email=noreply@4pm.app", "commit", "-q", "-m", message]);
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await git(root, ["push", "-q", "origin", `HEAD:refs/heads/${target}`]);
      return "pushed";
    } catch {
      await gitQuiet(root, ["fetch", "-q", "origin", target]);
      try {
        await git(root, ["rebase", "-q", `origin/${target}`]);
      } catch {
        await gitQuiet(root, ["rebase", "--abort"]);
        await gitQuiet(root, ["reset", "-q", "--hard", `origin/${target}`]);
        return "aborted";
      }
    }
  }
  return "failed";
}

/**
 * The ref the books are read from: `origin/autonomous-books/<base>`, else `origin/<base>` (before the
 * books branch exists), else null.
 */
export async function booksReadRef(cwd: string, base: string): Promise<string | null> {
  if (await hasRemoteBranch(cwd, booksBranch(base))) return `origin/${booksBranch(base)}`;
  return (await hasRemoteBranch(cwd, base)) ? `origin/${base}` : null;
}

/** A book's text as on the remote books branch (read without switching branches). */
export async function remoteBook(cwd: string, base: string, rel: string): Promise<string> {
  await gitQuiet(cwd, ["fetch", "-q", "origin", base]);
  await gitQuiet(cwd, ["fetch", "-q", "origin", booksBranch(base)]);
  const ref = await booksReadRef(cwd, base);
  return ref ? gitQuiet(cwd, ["show", `${ref}:${rel}`]) : "";
}

/** Has `origin/<branch>` been merged into `<base>`? Host PR state first, then ancestry. */
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
 * Check out the task branch in one repo: its pushed WIP if any, else from `from` (the
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

/**
 * Fingerprint of the work state of the given repos (`HEAD` + `git status --porcelain` + `git diff HEAD`,
 * hashed): a changed value means the agent committed or edited something in between. Used to tell a
 * timed-out run that made progress from one that did not.
 * @adr 0452
 */
export async function workFingerprint(dirs: readonly string[]): Promise<string> {
  const h = createHash("sha256");
  for (const cwd of dirs) {
    const [head, status, diff] = await Promise.all([
      gitQuiet(cwd, ["rev-parse", "HEAD"]),
      gitQuiet(cwd, ["status", "--porcelain"]),
      gitQuiet(cwd, ["diff", "HEAD", "--binary"]),
    ]);
    h.update(`${cwd}\0${head}\0${status}\0${diff}\0`);
  }
  return h.digest("hex");
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
 * Apply a book edit made OUTSIDE the cycle (the web: approvals, book saves, posted requests) straight
 * onto the books branch without touching the worker's working tree (it may be on a task branch): a
 * temporary detached worktree of `origin/autonomous-books/<base>` runs `publishBooks`, then is removed.
 * `fn` edits the books under the given dir and returns false to abort. Returns "unchanged" when there is
 * no remote `<base>`.
 */
export async function mutateBooks(
  root: string,
  base: string,
  message: string | (() => string),
  fn: (dir: string) => Promise<boolean>,
  dirs?: string[],
): Promise<PublishResult> {
  const ref = await ensureBooksBranch(root, base);
  if (!ref) return "unchanged";
  const dir = join(root, ".git", `4pm-books-${process.pid}-${Date.now()}`);
  await git(root, ["worktree", "add", "-q", "--detach", dir, ref]);
  try {
    return await publishBooks(dir, base, message, () => fn(dir), { detach: true, dirs });
  } finally {
    await gitQuiet(root, ["worktree", "remove", "--force", dir]);
    await gitQuiet(root, ["worktree", "prune"]);
  }
}

/** Last fetch of `<base>` + its books branch per repo (reads within 15 s reuse it). */
const lastFetch = new Map<string, number>();

/**
 * The books read ref (`booksReadRef`) after a fetch of `<base>` + the books branch at most every 15 s;
 * null when there is no remote at all.
 * @adr 0453
 */
export async function freshBooksRef(root: string, base: string): Promise<string | null> {
  const key = `${root}\u0000${base}`;
  if (Date.now() - (lastFetch.get(key) ?? 0) > 15_000) {
    await gitQuiet(root, ["fetch", "-q", "origin", base]);
    await gitQuiet(root, ["fetch", "-q", "origin", booksBranch(base)]);
    lastFetch.set(key, Date.now());
  }
  return booksReadRef(root, base);
}

/**
 * A book file as on the remote books branch (else `origin/<base>` before it exists), fetched at most
 * every 15 s; null when there is no remote at all.
 */
export async function readBooksFile(root: string, base: string, rel: string): Promise<string | null> {
  const ref = await freshBooksRef(root, base);
  if (!ref) return null;
  try {
    return await git(root, ["show", `${ref}:${rel}`]);
  } catch {
    return "";
  }
}
