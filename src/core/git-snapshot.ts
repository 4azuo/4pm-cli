/**
 * Worker git snapshots (ADR-0369, arch 0051) — builds the per-repo git state of the served project
 * (head, branches + tracking, remote-tracking refs, dirty counts/files, worker-only commits, the origin
 * window, merge-base, last fetch) from local git only, and reports it to the server on `git.snapshot`.
 * Reports are debounced (≥ 15 s apart), skipped while an AI run is active, sent on connect, after
 * settled git/AI/scaffold/provision work, and every `gitSnapshotIntervalMin` (fetching first).
 */
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  GIT_SNAPSHOT_LIMITS,
  type GitFileChange,
  type GitLocalCommit,
  type GitRepoSnapshot,
  type GitSnapshotBranch,
  type GitSnapshotCommit,
  type GitSnapshotPayload,
} from "@4pm/dto";
import { WsChannels } from "@4pm/ws";
import { readProfileConfig } from "../config/profile";
import { logger } from "../common/logger/logger";
import { gitRepos } from "./git-history";
import { activeAiRunCount } from "./ws-client/command-dispatch";

const run = promisify(execFile);
/** Field / record separators used in git format strings. */
const US = "\x1f";
const RS = "\x1e";
/** Minimum spacing between two reports. */
const MIN_SPACING_MS = 15_000;
/** Default periodic interval (minutes). */
const DEFAULT_INTERVAL_MIN = 10;

/** Run git in `cwd`; "" on any failure (a snapshot is best-effort). */
async function git(cwd: string, args: string[], timeout = 20_000): Promise<string> {
  try {
    const { stdout } = await run("git", args, { cwd, timeout, maxBuffer: 16 * 1024 * 1024 });
    return stdout;
  } catch {
    return "";
  }
}

/** Parse `%(upstream:track,nobracket)` ("ahead 1, behind 2" · "gone" · "") into counts. */
function parseTrack(track: string): { ahead: number; behind: number } {
  const ahead = /ahead (\d+)/.exec(track)?.[1];
  const behind = /behind (\d+)/.exec(track)?.[1];
  return { ahead: ahead ? Number(ahead) : 0, behind: behind ? Number(behind) : 0 };
}

/** Parse `git status --porcelain=v2` into counts + files (conflicted "U", untracked "?"). */
function parseStatus(out: string): { dirty: GitRepoSnapshot["dirty"]; files: GitFileChange[] } {
  const dirty = { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 };
  const files: GitFileChange[] = [];
  for (const line of out.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const kind = line[0];
    if (kind === "?") {
      dirty.untracked++;
      files.push({ status: "?", path: line.slice(2) });
    } else if (kind === "u") {
      dirty.conflicted++;
      files.push({ status: "U", path: line.split(" ").slice(10).join(" ") });
    } else if (kind === "1" || kind === "2") {
      const xy = line.slice(2, 4);
      const x = xy[0] ?? ".";
      const y = xy[1] ?? ".";
      if (x !== ".") dirty.staged++;
      if (y !== ".") dirty.unstaged++;
      const parts = line.split(" ");
      const path = (kind === "1" ? parts.slice(8) : parts.slice(9)).join(" ").split("\t")[0] ?? "";
      files.push({ status: y !== "." ? y : x, path });
    }
  }
  return { dirty, files };
}

/** Stamp each dirty file with its mtime (ISO; null when deleted/unreadable) — when/who in the UI (ADR-0397). */
async function withMtimes(dir: string, files: GitFileChange[]): Promise<GitFileChange[]> {
  return Promise.all(
    files.map(async (f) => {
      if (f.status === "D") return { ...f, mtime: null };
      try {
        return { ...f, mtime: (await stat(join(dir, f.path))).mtime.toISOString() };
      } catch {
        return { ...f, mtime: null };
      }
    }),
  );
}

/** Parse `--format=<RS>%H<US>%P<US>%an<US>%aI<US>%s` (+ optional `--name-status` lines) records. */
function parseLog(out: string, withFiles: boolean): (GitSnapshotCommit & { files: GitFileChange[] })[] {
  const commits: (GitSnapshotCommit & { files: GitFileChange[] })[] = [];
  for (const rec of out.split(RS)) {
    if (!rec.trim()) continue;
    const [header = "", ...rest] = rec.split("\n");
    const [sha = "", parents = "", author = "", date = "", subject = ""] = header.split(US);
    if (!sha) continue;
    const files: GitFileChange[] = withFiles
      ? rest
          .map((l) => l.trim())
          .filter(Boolean)
          .map((l) => {
            const cols = l.split("\t");
            return { status: (cols[0] ?? "M").charAt(0), path: cols[cols.length - 1] ?? "" };
          })
      : [];
    commits.push({ sha, parents: parents.split(" ").filter(Boolean), author, date, subject, files });
  }
  return commits;
}

/** Build the snapshot of one repo at `dir` (its `subdir` under the project root). */
export async function buildRepoSnapshot(dir: string, subdir: string): Promise<GitRepoSnapshot> {
  const L = GIT_SNAPSHOT_LIMITS;
  const fmt = `--format=${RS}%H${US}%P${US}%an${US}%aI${US}%s`;
  const [abbrev, headSha, heads, remotes, remoteHead, status, gitDir] = await Promise.all([
    git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]),
    git(dir, ["rev-parse", "--verify", "HEAD"]),
    git(dir, ["for-each-ref", "refs/heads", `--format=%(refname:short)${US}%(objectname)${US}%(upstream:short)${US}%(upstream:track,nobracket)`]),
    git(dir, ["for-each-ref", "refs/remotes/origin", `--format=%(refname:short)${US}%(objectname)${US}%(symref)`]),
    git(dir, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]),
    git(dir, ["status", "--porcelain=v2", "--untracked-files=all"]),
    git(dir, ["rev-parse", "--absolute-git-dir"]),
  ]);
  const branchName = abbrev.trim();
  const detached = branchName === "HEAD";
  const branches: GitSnapshotBranch[] = heads
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [name = "", sha = "", upstream = "", track = ""] = l.split(US);
      return { name, sha, upstream: upstream || null, ...parseTrack(track) };
    });
  const remoteBranches = remotes
    .split("\n")
    .filter(Boolean)
    .map((l) => l.split(US))
    .filter(([, , symref]) => !symref)
    .map(([name = "", sha = ""]) => ({ name: name.replace(/^origin\//, ""), sha }))
    .filter((b) => b.name && b.name !== "origin");
  const { dirty, files } = parseStatus(status);

  const [localOut, remoteOut] = await Promise.all([
    git(dir, ["log", "--branches", "--not", "--remotes", "-n", String(L.localCommits + 1), "--name-status", fmt], 30_000),
    git(dir, ["log", "--remotes", "--date-order", "-n", String(L.remoteCommits), fmt], 30_000),
  ]);
  const localAll = parseLog(localOut, true);
  const localCommits: GitLocalCommit[] = localAll.slice(0, L.localCommits).map((c) => ({
    ...c,
    branches: branches.filter((b) => b.sha === c.sha).map((b) => b.name),
    files: c.files.slice(0, L.filesPerCommit),
    filesTruncated: c.files.length > L.filesPerCommit,
  }));
  const remoteCommits = parseLog(remoteOut, false).map(({ files: _f, ...c }) => c);

  // Anchor for worker-only commits: merge-base with the upstream, else with the remote default branch.
  const defaultBranch = remoteHead.trim().replace(/^origin\//, "") || null;
  const upstream = branches.find((b) => b.name === branchName)?.upstream;
  const baseRef = upstream ?? (defaultBranch ? `origin/${defaultBranch}` : null);
  const baseSha = headSha.trim() && baseRef ? (await git(dir, ["merge-base", "HEAD", baseRef])).trim() || null : null;

  let lastFetchAt: string | null = null;
  try {
    if (gitDir.trim()) lastFetchAt = (await stat(join(gitDir.trim(), "FETCH_HEAD"))).mtime.toISOString();
  } catch {
    lastFetchAt = null;
  }

  return {
    subdir,
    head: { branch: detached || !branchName ? null : branchName, sha: headSha.trim() || null, detached },
    branches,
    remote: { name: "origin", defaultBranch, branches: remoteBranches },
    dirty,
    dirtyFiles: await withMtimes(dir, files.slice(0, L.dirtyFiles)),
    dirtyTruncated: files.length > L.dirtyFiles,
    localCommits,
    localTruncated: localAll.length > L.localCommits,
    remoteCommits,
    baseSha,
    lastFetchAt,
  };
}

/** Build the snapshot of every repo (root + submodules) under the served project root. */
export async function buildGitSnapshot(root: string): Promise<GitSnapshotPayload> {
  const base = resolve(root);
  const { repos } = await gitRepos(base);
  const snaps = await Promise.all(repos.map((r) => buildRepoSnapshot(r.subdir ? resolve(base, r.subdir) : base, r.subdir)));
  return { takenAt: new Date().toISOString(), repos: snaps };
}

/** Fetch every repo of the project (`git fetch --prune`) so remote-tracking refs reflect origin now. */
async function fetchAll(root: string): Promise<void> {
  const base = resolve(root);
  const { repos } = await gitRepos(base);
  for (const r of repos) await git(r.subdir ? resolve(base, r.subdir) : base, ["fetch", "--prune", "--quiet", "origin"], 60_000);
}

/** What the reporter needs from the WS client. */
export interface SnapshotHost {
  /** The served project root (null = idle cli). */
  readonly physicRoot: string | null;
  readonly profileDir: string;
  send(channel: typeof WsChannels.GIT_SNAPSHOT, data: GitSnapshotPayload): void;
}

/** Reporter state — one served project per daemon. */
const state: {
  host: SnapshotHost | null;
  lastSentAt: number;
  pending: ReturnType<typeof setTimeout> | null;
  periodic: ReturnType<typeof setInterval> | null;
  running: boolean;
} = { host: null, lastSentAt: 0, pending: null, periodic: null, running: false };

/** Build + send now (skipped when idle, busy with an AI run, or already running). */
async function reportNow(fetchFirst: boolean): Promise<void> {
  const host = state.host;
  const root = host?.physicRoot;
  if (!host || !root || state.running || activeAiRunCount() > 0) return;
  state.running = true;
  try {
    if (fetchFirst) await fetchAll(root);
    const payload = await buildGitSnapshot(root);
    if (payload.repos.length === 0) return;
    host.send(WsChannels.GIT_SNAPSHOT, payload);
    state.lastSentAt = Date.now();
  } catch (err) {
    logger.warn("git.snapshot.failed", { error: String(err) });
  } finally {
    state.running = false;
  }
}

/**
 * Ask for a snapshot soon (debounced: at most one per 15 s; a request during the window is coalesced
 * into one report at the window's end). `reason` is logged only.
 */
export function requestGitSnapshot(reason: string): void {
  if (!state.host || state.pending) return;
  const wait = Math.max(0, state.lastSentAt + MIN_SPACING_MS - Date.now());
  state.pending = setTimeout(() => {
    state.pending = null;
    logger.debug("git.snapshot.request", { reason });
    void reportNow(false);
  }, wait || 1_000);
  state.pending.unref?.();
}

/**
 * Attach the reporter to the connected WS client: a snapshot now, then every `gitSnapshotIntervalMin`
 * (profile config, default 10, `0` = off) with a fetch first. Safe to call again on each reconnect.
 */
export function startGitSnapshots(host: SnapshotHost): void {
  state.host = host;
  if (state.periodic) clearInterval(state.periodic);
  state.periodic = null;
  const raw = readProfileConfig(host.profileDir).gitSnapshotIntervalMin;
  const minutes = typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_INTERVAL_MIN;
  if (minutes > 0) {
    state.periodic = setInterval(() => void reportNow(true), minutes * 60_000);
    state.periodic.unref?.();
  }
  requestGitSnapshot("connect");
}

/** Detach on disconnect / shutdown (timers cleared; the last snapshot stays on the server). */
export function stopGitSnapshots(): void {
  if (state.pending) clearTimeout(state.pending);
  if (state.periodic) clearInterval(state.periodic);
  state.pending = null;
  state.periodic = null;
  state.host = null;
}
