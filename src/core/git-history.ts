/**
 * Read-only git history browsing on the worker (ADR-0089, git.repos/log/commit/
 * commit-diff channels): discover repos under the physic project, list commit history,
 * show a commit's changed files, and diff one file parent↔commit — so the dashboard Git
 * tab can render history without caching anything in the DB. All operations are scoped to
 * the cli's serving physic-project root; a `repo` subdir escaping the root is clamped back.
 * Never throws — failures map to empty results.
 */
import { readdir } from "node:fs/promises";
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
 * Discover git repos under the physic project root: the root itself (if a repo) plus any
 * immediate/nested subfolder that is a repo (sub-repos of a multi-repo project — ADR-0073).
 * Scans up to 2 levels deep to keep it cheap; each repo reports its `origin` remote.
 */
export async function gitRepos(root: string | null): Promise<GitReposReply> {
  if (!root) return { repos: [] };
  const base = resolve(root);
  const found = new Set<string>();
  const repos: GitReposReply["repos"] = [];
  const add = async (dir: string): Promise<void> => {
    const inside = await git(dir, ["rev-parse", "--show-toplevel"]);
    const top = inside.trim();
    if (!top || found.has(top) || !(top === base || top.startsWith(base + sep))) return;
    found.add(top);
    const subdir = top === base ? "" : top.slice(base.length + 1);
    const remote = (await git(top, ["remote", "get-url", "origin"])).trim();
    repos.push({ subdir, name: subdir || "", remote: remote || null });
  };
  await add(base);
  try {
    const lvl1 = await readdir(base, { withFileTypes: true });
    for (const d of lvl1) {
      if (!d.isDirectory() || d.name === ".git" || d.name === "node_modules") continue;
      const p1 = resolve(base, d.name);
      await add(p1);
      try {
        const lvl2 = await readdir(p1, { withFileTypes: true });
        for (const d2 of lvl2) {
          if (!d2.isDirectory() || d2.name === ".git" || d2.name === "node_modules") continue;
          await add(resolve(p1, d2.name));
        }
      } catch {
        // unreadable subdir ⇒ skip
      }
    }
  } catch {
    // unreadable root ⇒ only the root repo (if any)
  }
  repos.sort((a, b) => a.subdir.localeCompare(b.subdir));
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
