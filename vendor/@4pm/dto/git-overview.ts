/**
 * Vendored from @4pm/dto (git-overview.ts) by scripts/vendor-shared.mjs — do not edit.
 */
export const GIT_SNAPSHOT_LIMITS = {
    localCommits: 50,
    filesPerCommit: 100,
    dirtyFiles: 200,
    remoteCommits: 200,
} as const;
export interface GitFileChange {
    status: string;
    path: string;
    mtime?: string | null;
}
export interface GitSnapshotCommit {
    sha: string;
    parents: string[];
    author: string;
    date: string;
    subject: string;
}
export interface GitLocalCommit extends GitSnapshotCommit {
    branches: string[];
    files: GitFileChange[];
    filesTruncated: boolean;
}
export interface GitSnapshotBranch {
    name: string;
    sha: string;
    upstream: string | null;
    ahead: number;
    behind: number;
}
export interface GitRepoSnapshot {
    subdir: string;
    head: {
        branch: string | null;
        sha: string | null;
        detached: boolean;
    };
    branches: GitSnapshotBranch[];
    remote: {
        name: string;
        defaultBranch: string | null;
        branches: {
            name: string;
            sha: string;
        }[];
    };
    dirty: {
        staged: number;
        unstaged: number;
        untracked: number;
        conflicted: number;
    };
    dirtyFiles: GitFileChange[];
    dirtyTruncated: boolean;
    localCommits: GitLocalCommit[];
    localTruncated: boolean;
    remoteCommits: GitSnapshotCommit[];
    baseSha: string | null;
    lastFetchAt: string | null;
}
export interface GitSnapshotPayload {
    projectId?: string;
    takenAt: string;
    repos: GitRepoSnapshot[];
}
export interface GitOrigin {
    source: "github-app" | "gitlab-token" | "worker-fetch" | "none";
    fetchedAt: string | null;
    sourceWorker: {
        machineLinkId: string;
        username: string;
    } | null;
    defaultBranch: string | null;
    branches: {
        name: string;
        sha: string;
        protected: boolean;
    }[];
    pulls: {
        number: number;
        title: string;
        head: string;
        base: string;
        author: string;
        url: string;
    }[];
    error: string | null;
}
export interface GitOverviewWorker {
    machineLinkId: string;
    username: string;
    online: boolean;
    snapshot: (GitRepoSnapshot & {
        takenAt: string;
    }) | null;
}
export interface GitGraphRef {
    kind: "origin" | "worker" | "tag";
    name: string;
    machineLinkId?: string;
}
export interface GitGraphRow {
    sha: string;
    parents: string[];
    kind: "origin" | "local" | "wip";
    on: string[];
    worker: string | null;
    refs: GitGraphRef[];
    author: string;
    date: string;
    subject: string;
    files: GitFileChange[];
}
export interface GitOverviewRepo {
    subdir: string;
    remote: string | null;
    branch: string | null;
    origin: GitOrigin;
    workers: GitOverviewWorker[];
    graph?: {
        rows: GitGraphRow[];
        truncated: boolean;
    };
}
export interface GitOverviewResponse {
    repos: GitOverviewRepo[];
}
export interface GitOriginCommitFile {
    status: string;
    path: string;
    from: string | null;
    additions?: number;
    deletions?: number;
}
export interface GitCommitFilesResponse {
    files: GitOriginCommitFile[];
    truncated: boolean;
}
export interface GitCommitTreeResponse {
    paths: string[];
    truncated: boolean;
}
export interface GitCommitDiffResponse {
    original: string;
    modified: string;
    binary: boolean;
    tooLarge: boolean;
}
