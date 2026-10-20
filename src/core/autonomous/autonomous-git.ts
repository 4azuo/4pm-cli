/**
 * Autonomous git steps — everything the cycle does with git runs here, in code, never in the
 * agent: resolve each repo's `<base>` explicitly (spec / `.gitmodules`, else origin/HEAD — never the
 * checked-out branch), keep the books branch `autonomous-books/<base>` holding only the books set (created once as
 * an orphan from the books set of `<base>`), publish the books there as an
 * optimistic lock (a rejected non-fast-forward push = a lost race ⇒ reset + re-evaluate) from a persistent side
 * worktree, prepare the REQ / DOC / TSK branch `dev/<base>/<GROUP>/<ID>` from `<base>` in the root and each
 * submodule, save work in progress, and deliver (push + PR into each repo's base). The books set never rides a
 * work branch (it is a never-committed overlay — `autonomous-overlay`); a books-set path an agent still committed
 * is restored before the push.
 * @adr 0371 @adr 0448 @adr 0563
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  BOOK_FILES,
  DIAGRAM_ROOT,
  ER_ROOT,
  EVIDENCE_ROOT,
  SIDECAR_RELS,
  BOOKS_INDEX_REL,
  booksSetDirs,
  isBooksSetPath,
  type BooksSetDirs,
} from "@4pm/dto";
import { booksBranch } from "./autonomous-tasks";
import { autonomousPolicy } from "./autonomous-policy";
import { openPullRequest, prStateOf } from "../git/git-host";
import { attachSubmoduleBranches } from "../git/submodule-branch";
import { readFileInRoot } from "../../utils/safe-path";
import { execInProject } from "../agent/agent-spawn";

// Project git runs as the agent user when uid separation is on (ADR-0430); unchanged otherwise.
const run = execInProject;

/** The 4PM commit identity. */
const IDENT = ["-c", "user.name=4PM", "-c", "user.email=noreply@4pm.app"];

/**
 * The folders that decide the books set: the project's policy folders, else the defaults (the policy is pushed by
 * the server before any cycle runs).
 * @adr 0563
 */
export function booksDirsNow(): BooksSetDirs {
  const s = autonomousPolicy()?.settings;
  return { evidenceDir: s?.evidenceDir ?? EVIDENCE_ROOT, erDir: s?.erDir ?? ER_ROOT, diagramDir: s?.diagramDir ?? DIAGRAM_ROOT };
}

/** The pathspecs of the books set: the book files, the sidecars, the layout guide and its folders (with every evidence root). */
export function booksSetPathspecs(dirs: BooksSetDirs = booksDirsNow()): string[] {
  return [...new Set([...BOOK_FILES, ...SIDECAR_RELS, BOOKS_INDEX_REL, ...booksSetDirs(dirs), EVIDENCE_ROOT, dirs.evidenceDir])];
}

/**
 * Safety net before a REQ / DOC / TSK branch is pushed: every books-set path the branch changed since its fork
 * point with `origin/<base>` (an agent force-committed an overlay file) is put back to the fork point and the
 * restore is committed, so neither the branch nor its PR carries books. Returns the restored paths.
 * @adr 0563 @adr 0438
 */
export async function stripBooksSetFromBranch(root: string, base: string, id: string, dirs: BooksSetDirs = booksDirsNow()): Promise<string[]> {
  if (!(await hasRemoteBranch(root, base))) return [];
  const fork = (await gitQuiet(root, ["merge-base", "HEAD", `origin/${base}`])).trim();
  if (!fork) return [];
  const changed = (await gitQuiet(root, ["diff", "--name-only", fork, "HEAD"]))
    .split("\n")
    .map((l) => l.trim())
    .filter((p) => p && isBooksSetPath(p, dirs));
  if (changed.length === 0) return [];
  const atFork = new Set((await gitQuiet(root, ["ls-tree", "-r", "--name-only", fork, "--", ...changed])).split("\n").filter(Boolean));
  const back = changed.filter((p) => atFork.has(p));
  const gone = changed.filter((p) => !atFork.has(p));
  if (back.length) await gitQuiet(root, ["checkout", fork, "--", ...back]);
  if (gone.length) await gitQuiet(root, ["rm", "-q", "--cached", "--ignore-unmatch", "--", ...gone]);
  if ((await gitQuiet(root, ["diff", "--cached", "--name-only"])).trim()) {
    await git(root, [...IDENT, "commit", "-q", "-m", `chore(${id}): keep the books out of the branch (4PM)`]);
  }
  return changed;
}

/** Stage every books-set change in a books checkout (additions, edits and deletions). */
async function stageBooksSet(dir: string, extra: readonly string[] = []): Promise<void> {
  for (const p of [...new Set([...booksSetPathspecs(), ...extra])]) {
    const tracked = (await gitQuiet(dir, ["ls-files", "--", p])).trim();
    if (tracked || existsSync(join(dir, p))) await gitQuiet(dir, ["add", "-A", "--", p]);
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
 * Is HEAD a 4PM `wip(…)` commit that no remote has yet (never pushed, not a merge)? Then the next snapshot amends it
 * instead of stacking another commit — a branch reaches the remote with one commit per stop, never a force-push.
 * @adr 0563
 */
async function unpushedWipHead(cwd: string): Promise<boolean> {
  const subject = (await gitQuiet(cwd, ["log", "-1", "--format=%s"])).trim();
  if (!subject.startsWith("wip(")) return false;
  const parents = (await gitQuiet(cwd, ["rev-list", "--parents", "-n", "1", "HEAD"])).trim().split(/\s+/);
  if (parents.length !== 2) return false;
  return !(await gitQuiet(cwd, ["branch", "-r", "--contains", "HEAD"])).trim();
}

/**
 * Commit everything in `cwd` as a work-in-progress snapshot; true when something was committed. The books set is
 * never part of it (an agent's edits of the overlay are dropped from the index). An unpushed `wip(…)` HEAD is amended
 * (the local WIP commits squash into one; a final `feat(…)` / `docs(…)` message replaces it).
 * @adr 0438 @adr 0563
 */
export async function wipCommit(cwd: string, message: string): Promise<boolean> {
  await gitQuiet(cwd, ["add", "-A"]);
  const dirs = booksDirsNow();
  const staged = (await gitQuiet(cwd, ["diff", "--cached", "--name-only"])).split("\n").filter(Boolean);
  const books = staged.filter((p) => isBooksSetPath(p, dirs));
  if (books.length) await gitQuiet(cwd, ["reset", "-q", "--", ...books]);
  const amend = await unpushedWipHead(cwd);
  if (staged.length === books.length) {
    // Nothing new, but the final message still replaces an unpushed WIP subject.
    if (amend && !message.startsWith("wip(")) await git(cwd, [...IDENT, "commit", "-q", "--amend", "-m", message]).catch(() => undefined);
    return false;
  }
  await git(cwd, [...IDENT, "commit", "-q", ...(amend ? ["--amend"] : []), "-m", message]).catch(() => undefined);
  return true;
}


/** The repository's common `.git` folder (a worktree's `.git` is only a file pointing there). */
async function commonGitDir(cwd: string): Promise<string> {
  const d = (await gitQuiet(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim();
  return d || join(cwd, ".git");
}

/**
 * Turn the tree checked out in `dir` into the books set only: every path outside it is removed. True when anything
 * changed (staged).
 * @adr 0563
 */
async function keepOnlyBooksSet(dir: string, dirs: BooksSetDirs): Promise<boolean> {
  const all = (await gitQuiet(dir, ["ls-files"])).split("\n").filter(Boolean);
  const drop = all.filter((p) => !isBooksSetPath(p, dirs));
  for (let i = 0; i < drop.length; i += 200) await gitQuiet(dir, ["rm", "-q", "--cached", "--", ...drop.slice(i, i + 200)]);
  if (drop.length) await gitQuiet(dir, ["clean", "-fdqx"]);
  return drop.length > 0;
}

/**
 * Make sure the books branch exists on the remote. Created the first time as an orphan branch holding the books set
 * `origin/<base>` carries (a racing worker that pushed first simply wins). Returns the ref to work from —
 * `origin/<books>` — or null when there is no remote `<base>` (a local-only repo keeps the books on the local base).
 * @adr 0448 @adr 0563
 */
export async function ensureBooksBranch(root: string, base: string): Promise<string | null> {
  const books = booksBranch(base);
  await gitQuiet(root, ["fetch", "-q", "origin", base]);
  await gitQuiet(root, ["fetch", "-q", "origin", books]);
  if (await hasRemoteBranch(root, books)) return `origin/${books}`;
  if (!(await hasRemoteBranch(root, base))) return null;
  const dirs = booksDirsNow();
  for (let attempt = 1; attempt <= 3; attempt++) {
    const dir = join(await commonGitDir(root), `4pm-books-init-${process.pid}-${Date.now()}`);
    await git(root, ["worktree", "add", "-q", "--detach", dir, `origin/${base}`]);
    try {
      // An orphan: the books branch shares no history with `<base>`.
      await git(dir, ["checkout", "-q", "--orphan", `4pm-books-init-${process.pid}`]);
      await keepOnlyBooksSet(dir, dirs);
      await git(dir, [...IDENT, "commit", "-q", "--allow-empty", "-m", "chore(books): the autonomous books (4PM)"]);
      const pushed = await git(dir, ["push", "-q", "origin", `HEAD:refs/heads/${books}`]).then(
        () => true,
        () => false,
      );
      await gitQuiet(root, ["fetch", "-q", "origin", books]);
      if (pushed || (await hasRemoteBranch(root, books))) break;
    } finally {
      await gitQuiet(root, ["worktree", "remove", "--force", dir]);
      await gitQuiet(root, ["worktree", "prune"]);
    }
  }
  return (await hasRemoteBranch(root, books)) ? `origin/${books}` : null;
}

/** The persistent books worktree of a checkout (detached on the books branch, never the main working tree). */
export function booksTreeDir(root: string): string {
  return join(root, ".git", "4pm-books");
}

/**
 * Reset the books worktree to `ref` (created on first use; a stale registration is pruned). Every book read and
 * write of the cycle happens there, so the main working tree stays on the work branch.
 * @adr 0563
 */
async function resetBooksTree(root: string, ref: string): Promise<string> {
  const dir = booksTreeDir(root);
  if (!existsSync(join(dir, ".git"))) {
    await gitQuiet(root, ["worktree", "prune"]);
    await git(root, ["worktree", "add", "-q", "--force", "--detach", dir, ref]);
    return dir;
  }
  await git(dir, ["checkout", "-q", "--detach", "--force", ref]);
  await gitQuiet(dir, ["reset", "-q", "--hard", ref]);
  await gitQuiet(dir, ["clean", "-fdqx"]);
  return dir;
}

/**
 * Phase 1: fetch, make sure the books branch is books-only, and reset the books worktree to it. A dirty main tree is
 * saved first: a `wip:` commit on a 4PM branch, else a NAMED stash, returned so the cycle can tell the managers. The
 * main working tree keeps its branch. A repo without a remote `<base>` works on its local checkout (`dir` = root).
 * @adr 0506 @adr 0563
 */
export async function syncBooks(root: string, base: string): Promise<{ stashed: string | null; dir: string; ref: string | null }> {
  const cur = await currentBranch(root);
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
  if (!ref) return { stashed, dir: root, ref: null };
  const dir = await resetBooksTree(root, ref);
  return { stashed, dir, ref };
}

/** Bring the main tree's submodules up to the checked-out commit and onto their branches. */
export async function updateSubmodules(root: string): Promise<void> {
  await gitQuiet(root, ["submodule", "update", "--init", "-q"], 300_000);
  await attachSubmoduleBranches(root);
}

/** Outcome of a books publish. */
export type PublishResult = "pushed" | "unchanged" | "aborted" | "failed";

/**
 * Publish a change to the books on the books branch, from a books checkout `dir` (the books worktree, or a temporary
 * one): on a fresh `origin/autonomous-books/<base>`, apply `change` (it edits the book files and returns false to
 * abort — e.g. the task is no longer free), commit only books-set paths, push. A non-fast-forward rejection means
 * another worker pushed first: fetch, reset, and re-apply `change` against the new state. Up to 5 attempts.
 * @adr 0371 @adr 0563
 */
export async function publishBooks(
  dir: string,
  base: string,
  message: string | (() => string),
  change: () => Promise<boolean>,
  opts: { dirs?: string[] } = {},
): Promise<PublishResult> {
  const books = booksBranch(base);
  for (let attempt = 1; attempt <= 5; attempt++) {
    const ref = await ensureBooksBranch(dir, base);
    if (ref) {
      await git(dir, ["checkout", "-q", "--detach", "--force", ref]);
      await gitQuiet(dir, ["reset", "-q", "--hard", ref]);
      await gitQuiet(dir, ["clean", "-fdqx"]);
    }
    if (!(await change())) return "aborted";
    await stageBooksSet(dir, opts.dirs);
    const staged = (await gitQuiet(dir, ["diff", "--cached", "--name-only"])).trim();
    if (!staged) return "unchanged";
    // A message function is read after `change` (e.g. the ER version an apply produced — ADR-0453).
    await git(dir, [...IDENT, "commit", "-q", "-m", typeof message === "string" ? message : message()]);
    try {
      await git(dir, ["push", "-q", "origin", `HEAD:refs/heads/${ref ? books : base}`]);
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

/** Open (or find) the PR of `branch` into `base` — a draft when `draft` (it waits for submodule PRs, ADR-0579). */
export async function deliverPr(cwd: string, url: string, branch: string, base: string, title: string, body: string, draft = false): Promise<{ url: string | null; error: string | null }> {
  return openPullRequest({ url, cwd, base, head: branch, title, body, draft });
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
    return await publishBooks(dir, base, message, () => fn(dir), { ...(dirs ? { dirs } : {}) });
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
