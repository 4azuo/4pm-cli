/**
 * Git workspace shapes (ADR-0369, arch 0051): a worker's per-repo **git snapshot** (the cli's
 * `git.snapshot` payload, stored latest-only per physic project × repo) and the **overview** served by
 * project-0075 — origin + every serving worker's snapshot + the optional combined graph.
 */

/** Snapshot caps (ADR-0369 §5b) — the cli truncates to these and flags `*Truncated`. */
export const GIT_SNAPSHOT_LIMITS = {
  localCommits: 50,
  filesPerCommit: 100,
  dirtyFiles: 200,
  remoteCommits: 200,
} as const;

/** One changed/dirty file: a porcelain-ish status letter (A/M/D/R/U/?) + path. */
export interface GitFileChange {
  status: string;
  path: string;
}

/** A commit as carried by a snapshot / the origin window. */
export interface GitSnapshotCommit {
  sha: string;
  parents: string[];
  author: string;
  /** ISO author date. */
  date: string;
  subject: string;
}

/** A worker-only commit (reachable from a local branch, not from any remote-tracking ref). */
export interface GitLocalCommit extends GitSnapshotCommit {
  /** Local branches whose head is this commit. */
  branches: string[];
  files: GitFileChange[];
  filesTruncated: boolean;
}

/** A local branch with its upstream tracking. */
export interface GitSnapshotBranch {
  name: string;
  sha: string;
  /** e.g. `origin/main`; null = never pushed. */
  upstream: string | null;
  ahead: number;
  behind: number;
}

/** The latest git state of one repo in one worker's clone (ADR-0369). */
export interface GitRepoSnapshot {
  /** "" = the primary repo at the project root; else the submodule folder. */
  subdir: string;
  head: { branch: string | null; sha: string | null; detached: boolean };
  branches: GitSnapshotBranch[];
  /** Remote-tracking branches as of the last fetch (+ the remote's default branch from `origin/HEAD`). */
  remote: { name: string; defaultBranch: string | null; branches: { name: string; sha: string }[] };
  dirty: { staged: number; unstaged: number; untracked: number; conflicted: number };
  dirtyFiles: GitFileChange[];
  dirtyTruncated: boolean;
  localCommits: GitLocalCommit[];
  localTruncated: boolean;
  /** `git log --remotes` window (the worker's view of origin) — the self-managed origin source. */
  remoteCommits: GitSnapshotCommit[];
  /** merge-base of HEAD with its upstream (or the default branch) — anchors worker-only commits. */
  baseSha: string | null;
  /** When the clone last fetched (FETCH_HEAD mtime), ISO; null = never. */
  lastFetchAt: string | null;
}

/** `git.snapshot` (cli → server) — every repo of the served project at one point in time. */
export interface GitSnapshotPayload {
  /** Optional — the server resolves the project from the link's physic project (a mismatch is dropped). */
  projectId?: string;
  /** ISO time the cli built the snapshot. */
  takenAt: string;
  repos: GitRepoSnapshot[];
}

/** Origin of one repo as served by project-0075. */
export interface GitOrigin {
  source: "github-app" | "worker-fetch" | "none";
  fetchedAt: string | null;
  sourceWorker: { machineLinkId: string; username: string } | null;
  defaultBranch: string | null;
  branches: { name: string; sha: string; protected: boolean }[];
  pulls: { number: number; title: string; head: string; base: string; author: string; url: string }[];
  error: string | null;
}

/** One serving worker's state for a repo. */
export interface GitOverviewWorker {
  machineLinkId: string;
  username: string;
  online: boolean;
  /** The worker's snapshot for this repo; `takenAt` added by the server. Null = never reported. */
  snapshot: (GitRepoSnapshot & { takenAt: string }) | null;
}

/** A ref badge on a combined-graph row. */
export interface GitGraphRef {
  kind: "origin" | "worker" | "tag";
  name: string;
  machineLinkId?: string;
}

/** One combined-graph row (ADR-0369 §5b). */
export interface GitGraphRow {
  /** A commit SHA, or `wip:<machineLinkId>` for a worker's working tree. */
  sha: string;
  parents: string[];
  kind: "origin" | "local" | "wip";
  /** `"origin"` and/or worker machineLinkIds that have this commit. */
  on: string[];
  worker: string | null;
  refs: GitGraphRef[];
  author: string;
  date: string;
  subject: string;
  files: GitFileChange[];
}

/** One repo of the overview. */
export interface GitOverviewRepo {
  subdir: string;
  remote: string | null;
  /** The declared base branch (ADR-0370); null = the repo's default branch. */
  branch: string | null;
  origin: GitOrigin;
  workers: GitOverviewWorker[];
  graph?: { rows: GitGraphRow[]; truncated: boolean };
}

/** project-0075 response `data`. */
export interface GitOverviewResponse {
  repos: GitOverviewRepo[];
}
