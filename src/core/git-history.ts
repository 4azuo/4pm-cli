/**
 * Read-only git history browsing on the worker (ADR-0089, git.repos/log/commit/
 * commit-diff channels): discover repos under the physic project, list commit history,
 * show a commit's changed files, and diff one file parent↔commit — so the dashboard Git
 * tab can render history without caching anything in the DB. All operations are scoped to
 * the cli's serving physic-project root; a `repo` subdir escaping the root is clamped back.
 * Never throws — failures map to empty results.
 */
import { execFile } from "node:child_process";
import { resolve, sep } from "node:path";
import { promisify } from "node:util";
import type {
  GitCommitFile,
  GitCommitReply,
  GitDiffReply,
  GitLogEntry,
  GitLogReply,
  GitReposReply,
} from "@4pm/ws";

const run = promisify(execFile);
/** Unit separator + record separator — safe field/line delimiters for `git --pretty`. */
const FS = "\x1f";
const RS = "\x1e";

/** Resolve a repo subdir inside the physic root; clamp anything that escapes back to root. */
function resolveRepo(root: string | null, repo: string): string | null {
  if (!root) return null;
  const base = resolve(root);
  const requested = resolve(base, repo && repo.trim() ? repo : ".");
  return requested === base || requested.startsWith(base + sep) ? requested : base;
}

/** Run a git command in `cwd`; empty stdout on failure (never throws). */
async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await run("git", args, {
      cwd,
      timeout: 15_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return stdout;
  } catch {
    return "";
  }
}

/**
 * The physic project's repos (ADR-0314, single-repo): the project **root itself** (the one repo)
 * plus each of its **git submodules** (`git submodule status`) — multi-repo is the user's own
 * submodules, not a 4PM-managed repo set. The root reports `subdir: ""`; each submodule reports its
 * path as `subdir`. Each repo reports its `origin` remote. Empty when the root isn't a git repo yet.
 */
export async function gitRepos(root: string | null): Promise<GitReposReply> {
  if (!root) return { repos: [] };
  const base = resolve(root);
  // The root must itself be a git repo (it IS the project repo — ADR-0314).
  const top = (await git(base, ["rev-parse", "--show-toplevel"])).trim();
  if (!top || !(top === base || top.startsWith(base + sep))) return { repos: [] };
  const repos: GitReposReply["repos"] = [];
  const rootRemote = (await git(base, ["remote", "get-url", "origin"])).trim();
  const rootBranch = (await git(base, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  repos.push({ subdir: "", name: "", remote: rootRemote || null, branch: rootBranch || null });
  // Git submodules of the root — `git submodule status` lists each as "<flag><sha> <path> (<ref>)".
  const subOut = await git(base, ["submodule", "status"]);
  for (const line of subOut.split("\n")) {
    const m = line.trim().match(/^[-+U ]?[0-9a-f]{7,40}\s+(\S+)/);
    const subPath = m?.[1];
    if (!subPath) continue;
    const abs = resolve(base, subPath);
    if (!(abs === base || abs.startsWith(base + sep))) continue; // clamp to the physic root
    const remote = (await git(abs, ["remote", "get-url", "origin"])).trim();
    const branch = (await git(abs, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    repos.push({ subdir: subPath, name: subPath, remote: remote || null, branch: branch || null });
  }
  return { repos };
}

/** A page of commit history (HEAD branch) for one repo, with a `hasMore` flag. */
export async function gitLog(
  root: string | null,
  repo: string,
  skip: number,
  limit: number,
): Promise<GitLogReply> {
  const cwd = resolveRepo(root, repo);
  if (!cwd) return { entries: [], hasMore: false };
  const capped = Math.min(Math.max(limit, 1), 200);
  const format = ["%H", "%h", "%an", "%aI", "%s"].join(FS) + RS;
  // Fetch one extra to detect whether older commits remain.
  const stdout = await git(cwd, [
    "log",
    `--skip=${Math.max(skip, 0)}`,
    `-n`,
    String(capped + 1),
    `--pretty=format:${format}`,
  ]);
  const rows = stdout.split(RS).map((r) => r.replace(/^\n/, "")).filter((r) => r.length > 0);
  const entries: GitLogEntry[] = rows.slice(0, capped).map((row) => {
    const [hash = "", shortHash = "", author = "", date = "", subject = ""] = row.split(FS);
    return { hash, shortHash, author, date, subject };
  });
  return { entries, hasMore: rows.length > capped };
}

/** A commit's metadata + the files it changed (`git show --name-status`). */
export async function gitCommit(
  root: string | null,
  repo: string,
  hash: string,
): Promise<GitCommitReply> {
  const cwd = resolveRepo(root, repo);
  const empty: GitCommitReply = { hash, author: "", date: "", subject: "", files: [] };
  if (!cwd || !hash) return empty;
  const format = ["%H", "%an", "%aI", "%s"].join(FS);
  const stdout = await git(cwd, [
    "show",
    "--name-status",
    "-M",
    `--pretty=format:${format}`,
    hash,
  ]);
  if (!stdout) return empty;
  const lines = stdout.split("\n");
  const [full = hash, author = "", date = "", subject = ""] = (lines[0] ?? "").split(FS);
  const files: GitCommitFile[] = [];
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    const status = (parts[0] ?? "").charAt(0);
    if (!status) continue;
    if (status === "R" || status === "C") {
      // rename/copy: <status>\t<oldPath>\t<newPath>
      files.push({ path: parts[2] ?? "", status, oldPath: parts[1] ?? undefined });
    } else {
      files.push({ path: parts[1] ?? "", status });
    }
  }
  return { hash: full, author, date, subject, files };
}

/** Parent↔commit content of one file (Monaco diff for a specific commit). */
export async function gitCommitDiff(
  root: string | null,
  repo: string,
  hash: string,
  path: string,
): Promise<GitDiffReply> {
  const cwd = resolveRepo(root, repo);
  if (!cwd || !hash || !path) return { path, oldContent: "", newContent: "" };
  // `<hash>^:<path>` fails on a root commit or an added file ⇒ empty old content;
  // `<hash>:<path>` fails on a deleted file ⇒ empty new content.
  const oldContent = await git(cwd, ["show", `${hash}^:${path}`]);
  const newContent = await git(cwd, ["show", `${hash}:${path}`]);
  return { path, oldContent, newContent };
}
