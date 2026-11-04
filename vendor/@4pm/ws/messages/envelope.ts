/**
 * Vendored from @4pm/ws (messages/envelope.ts) by scripts/vendor-shared.mjs — do not edit.
 */
import type { MachineHostingReport } from "./hosting";
import type { WsChannelName } from "../channels";
import type { RunQueueInfo } from "./run-slot";
import type { MarketingRunSpec } from "./marketing";
export interface AiMountReport {
    provider: string;
    profile: string;
    account?: string;
}
export interface GitLoginReport {
    tool: "gh" | "glab";
    host: string;
    expiresAt?: string | null;
    scopes?: string[];
}
export interface WsEnvelope {
    id: string;
    replyTo: string | null;
    channel: WsChannelName;
    wsToken: string;
    payload: string;
    nonce: string;
}
export interface WsHello {
    type: "hello";
    wsToken: string;
    pubkey: string;
    cliVersion?: string;
    fingerprint?: string;
    hostname?: string;
}
export interface WsHelloAck {
    type: "hello_ack";
    pubkey: string;
    workerName?: string;
    projectName?: string;
    kid?: string;
    sig?: string;
}
export interface WsError {
    type: "error";
    errorCode: string;
    message: string;
    meta?: Record<string, string>;
}
export type WsControlMessage = WsHello | WsHelloAck | WsError;
export interface MachineStatusPayload {
    status: string;
    projects?: string[];
    version: string;
    physicPath?: string | null;
    physicPathExists?: boolean;
    reposReady?: boolean;
    templateMarker?: {
        version: string | null;
    };
    aiRunTimeoutSec?: number;
    aiProfileCount?: number;
    aiAccounts?: string[];
    aiAccountKeys?: string[];
    aiMounts?: AiMountReport[];
    cliUpdateLocked?: boolean;
    egress?: "container" | "none";
    egressReason?: string;
    gitLogins?: GitLoginReport[];
    pid?: number;
    startedAt?: string;
    lifecycle?: "connected" | "draining";
    drainingFor?: string[];
    autonomous?: AutonomousSnapshotPayload;
    hosting?: MachineHostingReport;
}
export interface AutonomousSnapshotPayload {
    enabled: boolean;
    effective: boolean;
    pausedBy?: "user" | "auto" | "projectDeleted" | "migration";
    pausedReason?: string;
    pausedAt?: string;
    lastCheck?: {
        at: string;
        outcome: "run" | "skip" | "error" | "running";
        reason: string;
        detail?: AutonomousCheckDetailPayload;
    } | null;
    claim?: {
        id: string;
        since: string;
    } | null;
    step?: {
        kind: "cycle" | "intake" | "implement" | "docs" | "deliver";
        ids: string[];
        since: string;
    } | null;
    consecutiveFails: number;
}
export interface AutonomousCheckDetailPayload {
    intake?: {
        tasks: number;
        questions: number;
        changeRequests: number;
    };
    waiting?: {
        approval: number;
        changeRequests: number;
        answers: number;
        dependencies: number;
        blocked?: number;
        merge?: number;
    };
    taskId?: string;
    by?: string;
    capReached?: ("USER_TODO" | "USER_QA" | "AI_TODO")[];
}
export interface AutonomousPolicyPayload {
    projectEnabled: boolean;
    allowed: boolean;
    reason?: string;
    settings: Record<string, unknown>;
}
export type CommandOrigin = "server" | "local";
export interface CommandImageRef {
    id: string;
    placeholder: string;
    name: string;
    mime: string;
}
export interface ImageFetchRequest {
    commandId: string;
    imageId: string;
}
export interface ImageFetchReply {
    mime?: string;
    dataBase64?: string;
    error?: string;
}
export interface AiRunConfig {
    model?: string;
    thinking?: "off" | "low" | "medium" | "high";
    temperature?: number;
}
export interface CommandDispatchPayload {
    commandId: string;
    projectId?: string;
    path?: string;
    cmd: string;
    args: string[];
    env?: Record<string, string>;
    images?: CommandImageRef[];
    ai?: boolean;
    aiOneShot?: boolean;
    lockedAiClis?: string[];
    aiReadOnly?: boolean;
    aiBypass?: boolean;
    aiConfig?: AiRunConfig;
    marketing?: MarketingRunSpec;
}
export interface CommandAnnouncePayload {
    commandId: string;
    projectId?: string;
    cmd: string;
    args: string[];
    prompt?: string;
    origin: CommandOrigin;
}
export interface ConsoleWatchPayload {
    on: boolean;
}
export interface MetricsWatchPayload {
    on: boolean;
}
export interface CommandOutputPayload {
    commandId: string;
    seq: number;
    chunk: string;
    truncated?: boolean;
    done?: boolean;
    exitCode?: number;
    unavailable?: boolean;
    log?: boolean;
    reset?: boolean;
    queue?: RunQueueInfo | null;
    cancelled?: boolean;
}
export interface ToolStatus {
    id: string;
    label: string;
    category: "runtime" | "ai-cli" | "vcs";
    installed: boolean;
    version: string | null;
    installable: boolean;
    updatable: boolean;
    autoUpdate: boolean;
}
export interface ToolsListRequest {
    _?: never;
}
export interface ToolsListReply {
    catalog: ToolStatus[];
    extras: ToolStatus[];
}
export interface ToolsMutateRequest {
    opId: string;
    name: string;
    manager: "npm" | "pnpm";
}
export interface ToolsMutateReply {
    started: boolean;
    error?: string;
}
export interface ToolsProgressPayload {
    opId: string;
    line: string;
}
export interface ToolsDonePayload {
    opId: string;
    ok: boolean;
    exitCode: number;
    error?: string;
}
export interface ToolsAutoUpdateRequest {
    name: string;
    enabled: boolean;
}
export interface ToolsAutoUpdateReply {
    ok: boolean;
    error?: string;
}
export interface ToolRestoreFailureItem {
    name: string;
    version: string;
    reason: "timeout" | "network" | "not-found" | "engine" | "other";
    retryable: boolean;
}
export interface FeatureToolItem {
    id: "rag" | "playwright" | "chromium" | "vhs" | "ttyd" | "ffmpeg" | "xvfb";
    feature: "rag" | "marketing";
    label: string;
    installed: boolean;
    version: string | null;
    source: "auto" | "system" | "detect";
    detail?: string | null;
}
export interface ToolsReportPayload {
    catalog: ToolStatus[];
    extras: ToolStatus[];
    features?: FeatureToolItem[];
    restoreFailed?: ToolRestoreFailureItem[];
    trigger?: "op" | "boot" | "daily" | "manual";
}
export interface ToolManifestItem {
    name: string;
    version: string;
    manager: "npm" | "pnpm";
}
export interface ToolsRestoreRequest {
    manifest: ToolManifestItem[];
    trigger?: "boot" | "manual";
    opId?: string;
}
export interface ToolsRestoreReply {
    ok: boolean;
    error?: string;
}
export interface ConfigReadRequest {
    _?: never;
}
export interface ConfigReadReply {
    config: string;
}
export interface ConfigWriteRequest {
    config: string;
}
export interface ConfigWriteReply {
    ok: boolean;
    error?: string;
}
export type FsViewer = "client";
export type FsTarget = "base" | "worktree";
export interface FsEditor {
    by?: string;
}
export interface FsListRequest {
    path: string;
    viewer?: FsViewer;
    target?: FsTarget;
}
export interface FsListReply {
    path: string;
    entries: {
        name: string;
        type: "dir" | "file";
    }[];
    target?: FsTarget;
    ref?: string;
    commit?: string;
}
export interface FsWriteRequest extends FsEditor {
    path: string;
    content: string;
    target?: FsTarget;
    expectBlob?: string | null;
}
export interface RepoBusyInfo {
    holder: "autonomous" | "command" | "git" | "project";
    task?: string;
    branch?: string;
}
export interface FsWriteReply {
    ok: boolean;
    path: string;
    bytes: number;
    error?: string;
    repoBusy?: RepoBusyInfo;
    target?: FsTarget;
    commit?: string;
}
export type FsMutateOp = "mkdir" | "create" | "move" | "delete";
export interface FsMutateRequest extends FsEditor {
    op: FsMutateOp;
    target?: FsTarget;
    path?: string;
    content?: string;
    from?: string;
    to?: string;
}
export interface FsMutateReply {
    ok: boolean;
    path: string;
    error?: string;
    repoBusy?: RepoBusyInfo;
    target?: FsTarget;
    commit?: string;
}
export interface FsUploadRequest extends FsEditor {
    target?: FsTarget;
    path: string;
    contentBase64: string;
    contentType?: string;
}
export interface FsUploadReply {
    ok: boolean;
    path: string;
    bytes: number;
    error?: string;
    repoBusy?: RepoBusyInfo;
    target?: FsTarget;
    commit?: string;
}
export interface FsDownloadRequest {
    path: string;
    target?: FsTarget;
    viewer?: FsViewer;
}
export interface FsDownloadReply {
    contentBase64?: string;
    contentType?: string;
    name?: string;
    size?: number;
    error?: string;
}
export interface AutonomousStatus {
    paused: boolean;
    cronSchedule: string;
    lastTickAt: string | null;
    lastResult: string | null;
    consecutiveFails: number;
    todayTicks: number;
    booksProtected?: string | null;
    gitAccess?: string | null;
    effective: boolean;
    projectEnabled: boolean;
    allowed: boolean;
    allowedReason: string | null;
    pausedBy: string | null;
}
export interface ApprovalEntry {
    approved: true;
    by: string;
    byLabel?: string;
    at: string;
    h?: string;
    kid?: string;
    sig?: string;
}
export interface ApprovalPartyEntry {
    by: string;
    byLabel?: string;
    group: "teamLead" | "designated" | "client" | "member";
    at: string;
    h: string;
    kid?: string;
    sig?: string;
}
export interface BookPatchPayload {
    v: 1;
    columns: string[];
    rows: {
        id: string;
        prev: string | null;
        cells: Record<string, string> | null;
        after?: string | null;
    }[];
    rest?: {
        prev: string;
        before: string;
        after: string;
    };
}
export interface BookConflictPayload {
    id: string;
    kind: "changed" | "deleted" | "duplicateId" | "rest";
}
export interface ApprovalKeysPayload {
    keys: {
        kid: string;
        publicKey: string;
    }[];
}
export type ApprovalState = "approved" | "unsigned" | "invalid" | "stale";
export interface AutonomousBooks {
    userTodo: string;
    aiTodo: string;
    aiProgress: string;
    aiDone: string;
    userQa: string;
}
export interface AutonomousReadRequest {
    donePage?: number;
    doneSize?: number;
}
export interface AutonomousReadReply {
    settings: string;
    status: AutonomousStatus;
    books: AutonomousBooks;
    approvals: string;
    authors: string;
    attempts?: string;
    mockups?: string[];
    sequences?: string[];
    ercs?: {
        id: string;
        path: string;
        state: string;
        title: string;
        group: string;
        req: string[];
        task?: string;
        team?: string;
        source: string;
    }[];
    sdcs?: {
        id: string;
        path: string;
        state: string;
        title: string;
        group: string;
        req: string[];
        task?: string;
        team?: string;
        source: string;
    }[];
    diagramDir?: string;
    evidence?: string[];
    erDir?: string;
    sequenceDir?: string;
    modifiedAt?: Record<string, string>;
    approvalStates?: Record<string, ApprovalState>;
    docs?: string;
    doneReviews?: string;
    lineage?: string;
    delivery?: string;
    doneTotal?: number;
    evidenceRefs?: Record<string, string>;
    archivedDone?: string[];
}
export interface AutonomousArchiveRequest {
    from?: string;
    to?: string;
    book?: "USER_TODO" | "USER_QA" | "AI_DONE";
    id?: string;
    q?: string;
    team?: string;
    tag?: string;
    requester?: string;
    state?: string;
    delivery?: "open" | "merged" | "closed" | "direct";
    page?: number;
    size?: number;
}
export interface AutonomousArchiveRow {
    book: "USER_TODO" | "USER_QA" | "AI_DONE";
    month: string;
    id: string;
    title: string;
    team?: string;
    tags?: string;
    state?: string;
    delivery?: "open" | "merged" | "closed" | "direct";
    finishedAt: string;
    cells: Record<string, string>;
    approval?: unknown;
    author?: unknown;
    lineage?: unknown;
}
export interface AutonomousArchiveReply {
    rows: AutonomousArchiveRow[];
    total: number;
    page: number;
    size: number;
    error?: string;
}
export interface AutonomousLogsRequest {
    date?: string;
}
export interface AutonomousLogsReply {
    date: string;
    lines: string[];
}
export type AutonomousWriteRequest = {
    kind: "settings";
    settings: string;
} | {
    kind: "approvals";
    taskId: string;
    approved: boolean;
    by: string;
    byLabel?: string;
    byIsAdmin?: boolean;
    signed?: Record<string, ApprovalEntry>;
    parties?: Record<string, ApprovalPartyEntry[]>;
    clearAll?: boolean;
} | {
    kind: "approvalsBatch";
    approve: string[];
    unapprove: string[];
    by: string;
    byLabel?: string;
    byIsAdmin?: boolean;
    signed?: Record<string, ApprovalEntry>;
    parties?: Record<string, ApprovalPartyEntry[]>;
    clearAll?: boolean;
} | {
    kind: "userTodo";
    content: string;
    id?: string;
    by: string;
    byLabel?: string;
} | {
    kind: "bookSave";
    book: "userTodo" | "userQa" | "aiTodo" | "aiDone";
    patch?: BookPatchPayload;
    content?: string;
    baseHash?: string;
    by: string;
    byLabel?: string;
    evidence?: {
        stageId: string;
        path: string;
    }[];
    approve?: string[];
    unapprove?: string[];
    signed?: Record<string, ApprovalEntry>;
    byIsAdmin?: boolean;
    parties?: Record<string, ApprovalPartyEntry[]>;
    clearAll?: boolean;
    editableTeams?: string[] | null;
    ownRowsOnly?: boolean;
    answerOnly?: boolean;
    lineageFrom?: Record<string, string>;
} | {
    kind: "docReview";
    review: {
        id: string;
        round: number;
        decision: "proceed" | "revise";
        opinion: string;
    };
    by: string;
    byLabel?: string;
} | {
    kind: "evidenceStage";
    name: string;
    contentBase64: string;
    by: string;
    byLabel?: string;
} | {
    kind: "discussionBatch";
    batchId: string;
    opCount: number;
    files: {
        path: string;
        content: string;
        expectedSha: string | null;
    }[];
    by: string;
    byLabel?: string;
} | {
    kind: "runNow";
    by: string;
    byLabel?: string;
} | {
    kind: "evidenceRestore";
    path: string;
    rev: string;
    by: string;
    byLabel?: string;
} | {
    kind: "taskRetry";
    taskId: string;
    by: string;
    byLabel?: string;
} | {
    kind: "doneReview";
    rowId: string;
    action: "close" | "created";
    createdIds?: string[];
    by: string;
    byLabel?: string;
};
export interface AutonomousWriteReply {
    ok: boolean;
    error?: string;
    code?: string;
    failedId?: string;
    blockers?: string[];
    status?: AutonomousStatus;
    added?: number;
    addedIds?: string[];
    commitSha?: string;
    files?: {
        path: string;
        blobSha: string;
    }[];
    skipped?: {
        path: string;
        reason: "changed" | "invalid";
        currentSha: string | null;
    }[];
    stageId?: string;
    conflicts?: BookConflictPayload[];
    result?: "published" | "unchanged";
}
export interface AutonomousEvidenceRequest {
    path: string;
    ref?: string;
    rev?: string;
}
export type AutonomousEvidenceReply = FsDownloadReply;
export interface EvidenceCommit {
    sha: string;
    at: string;
    author: string;
    subject: string;
}
export interface AutonomousEvidenceHistoryRequest {
    path: string;
}
export interface AutonomousEvidenceHistoryReply {
    commits?: EvidenceCommit[];
    error?: string;
}
export type DoneFileSource = "merge" | "branch" | "head" | "pr-ref" | "deleted-tip" | "base";
export interface DoneFilesRepo {
    dir: string;
    source: DoneFileSource;
    ref: string;
    sha: string;
    baseSha?: string;
    warning?: "base-fallback";
}
export interface AutonomousDoneFilesRequest {
    rowId: string;
}
export interface AutonomousDoneFilesReply {
    repos?: DoneFilesRepo[];
    files?: {
        path: string;
        repo: string;
        status: "A" | "M" | "D" | "R" | "?";
        dir?: boolean;
    }[];
    legacy?: boolean;
    code?: "not-found";
    error?: string;
}
export interface AutonomousDoneFileRequest {
    rowId: string;
    path: string;
    side?: "after" | "before";
    list?: boolean;
}
export interface AutonomousDoneFileReply extends FsDownloadReply {
    source?: DoneFileSource;
    sha?: string;
    entries?: {
        path: string;
        type: "file" | "dir";
    }[];
    missing?: boolean;
    code?: "not-found";
}
export interface AgentSummary {
    name: string;
    description: string;
}
export interface AgentsListRequest {
    target?: FsTarget;
}
export interface AgentsListReply {
    subagents: AgentSummary[];
    skills: AgentSummary[];
}
export interface AgentReadRequest {
    kind: "subagent" | "skill";
    name: string;
    target?: FsTarget;
}
export interface AgentReadReply {
    content: string;
    memory?: {
        short: string;
        long: string;
    };
}
export interface AgentWriteRequest extends FsEditor {
    kind: "subagent" | "skill";
    target?: FsTarget;
    name: string;
    action: "write" | "delete";
    content?: string;
}
export interface AgentWriteReply {
    ok: boolean;
    error?: string;
    target?: FsTarget;
}
export interface SecretKeyStatus {
    name: string;
    set: boolean;
}
export interface SecretsReadRequest {
    _?: never;
}
export interface SecretsReadReply {
    security: string;
    placeholder: string;
    keys: SecretKeyStatus[];
}
export type SecretsWriteRequest = {
    kind: "security";
    content: string;
} | {
    kind: "placeholder";
    content: string;
} | {
    kind: "secret";
    key: string;
    value: string;
} | {
    kind: "secretDelete";
    key: string;
};
export interface SecretsWriteReply {
    ok: boolean;
    error?: string;
}
export type AgentToolsScope = "shared" | "local";
export type AgentToolsMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";
export interface AgentToolsPermissions {
    defaultMode: AgentToolsMode;
    allow: string[];
    deny: string[];
}
export interface AgentToolsReadRequest {
    scope: AgentToolsScope;
}
export interface AgentToolsReadReply {
    permissions: AgentToolsPermissions;
}
export interface AgentToolsWriteRequest {
    scope: AgentToolsScope;
    permissions: AgentToolsPermissions;
}
export interface AgentToolsWriteReply {
    ok: boolean;
    error?: string;
}
export type McpServerDefinitionWire = Record<string, unknown>;
export interface McpServerPush {
    name: string;
    definition: McpServerDefinitionWire;
}
export type McpScanRequest = Record<string, never>;
export interface McpScanReply {
    files: {
        path: string;
        servers: {
            name: string;
            definition: McpServerDefinitionWire;
            hash: string;
        }[];
        error?: string;
    }[];
    error?: string;
}
export type PackageKind = "subagent" | "skill" | "script" | "vscode-task" | "command" | "hook" | "bundle" | "guide";
export interface PackagePayloadFile {
    path: string;
    contentBase64: string;
}
export interface PackagesPackRequest {
    kind: "subagent" | "skill" | "command";
    name: string;
}
export interface PackagesPackReply {
    ok: boolean;
    files: PackagePayloadFile[];
    error?: string;
}
export interface PackagesInstallRequest {
    kind: PackageKind;
    slug: string;
    version: string;
    packageId: string;
    files: PackagePayloadFile[];
    providers?: ("claude" | "codex")[];
    requires?: string[];
    members?: {
        kind: Exclude<PackageKind, "bundle" | "guide">;
        slug: string;
        providers?: ("claude" | "codex")[];
    }[];
    guideTarget?: "CLAUDE.md" | "AGENT.md";
    guideOverwrite?: boolean;
}
export interface PackagesInstallReply {
    ok: boolean;
    sha256?: string;
    warnings?: string[];
    error?: string;
}
export interface InstalledPackageState {
    slug: string;
    kind: PackageKind;
    version: string;
    packageId: string;
    installedAt: string;
    sha256: string;
    currentSha256: string;
    providers?: ("claude" | "codex")[];
    requires?: string[];
    requiredBy?: string[];
    guideTarget?: "CLAUDE.md" | "AGENT.md";
}
export interface PackagesListRequest {
    _?: never;
}
export interface PackagesListReply {
    installed: InstalledPackageState[];
    enabledProviders?: string[];
}
export interface PackagesRemoveRequest {
    slug: string;
    kind?: PackageKind;
    force?: boolean;
}
export interface PackagesRemoveReply {
    ok: boolean;
    requiredBy?: string[];
    error?: string;
}
export type GraphLayer = "doc" | "code" | "er";
export type GraphEdgeType = "parent" | "implements" | "uses" | "extends" | "supersedes" | "tests" | "related" | "mentions" | "imports";
export interface GraphNode {
    id: string;
    label: string;
    kind: string;
    file: string;
    layer: GraphLayer;
    title?: string;
    feature?: string[];
    status?: string;
    parent?: string;
    depth?: number;
}
export interface GraphEdge {
    from: string;
    to: string;
    type: GraphEdgeType;
}
export interface GraphMetrics {
    depthScore: number;
    maxDepth: number;
    avgDepth: number;
    idealDepth: number;
    cycles: number;
    unclassified: number;
    brokenRefs: number;
    perRoot: {
        id: string;
        depthScore: number;
        maxDepth: number;
    }[];
}
export interface GraphIssue {
    id?: string;
    file: string;
    rule: string;
    severity: "error" | "warn";
    message: string;
}
export interface GraphBuildRequest {
    mode: "docs" | "code" | "all";
}
export interface GraphBuildReply {
    nodes: GraphNode[];
    edges: GraphEdge[];
    orphans: string[];
    roots: string[];
    metrics: GraphMetrics;
    issues: GraphIssue[];
}
export interface RagOption {
    id: string;
    label: string;
    model: string;
    sizeMB: number;
    recommended: boolean;
    note?: string;
    languages?: "en" | "multi" | "code";
    license?: string;
    indexesCode?: boolean;
}
export interface RagMachine {
    ramGB: number;
    cpus: number;
    diskFreeGB: number;
    gpu: boolean;
}
export interface RagPrereq {
    key: "repo" | "node" | "npm" | "sqliteExt" | "disk" | "access" | "network";
    ok: boolean;
    detail?: string;
    hint?: string;
}
export interface RagStatusRequest {
    _?: never;
}
export interface RagStatusReply {
    installed: boolean;
    installing: boolean;
    runtime: {
        node: string;
        nodeOk: boolean;
        npm: boolean;
        sqliteExt: boolean;
    };
    deps: {
        transformers: boolean;
        sqliteVec: boolean;
    };
    prereqs?: RagPrereq[];
    model: {
        present: boolean;
        name: string;
    };
    machine: RagMachine;
    options: RagOption[];
    installLog: string[];
    index: RagIndex;
    settings: RagSettings;
    reranker?: {
        ready: boolean;
        installing: boolean;
    };
}
export interface RagSettings {
    minScore: number;
    topK: number;
    rerank?: boolean;
}
export type RagSettingsRequest = RagSettings;
export interface RagSettingsReply {
    ok: boolean;
    settings: RagSettings;
    error?: string;
}
export interface RagInstallRequest {
    model: string;
}
export interface RagInstallReply {
    ok: boolean;
    started: boolean;
    error?: string;
}
export interface RagIndex {
    present: boolean;
    indexing: boolean;
    chunks: number;
    indexedAt: string;
    stale?: boolean;
    docs?: number;
}
export interface RagReindexRequest {
    _?: never;
}
export interface RagReindexReply {
    ok: boolean;
    started: boolean;
    error?: string;
}
export interface RagQueryResult {
    path: string;
    snippet: string;
    score: number;
    title?: string;
    kind?: string;
    hits: number;
    more?: {
        snippet: string;
        score: number;
    }[];
}
export interface RagQueryRequest {
    query: string;
    k?: number;
    kinds?: string[];
}
export interface RagQueryReply {
    results: RagQueryResult[];
    error?: string;
}
export interface GitDiffRequest {
    path: string;
    viewer?: FsViewer;
}
export interface GitDiffReply {
    path: string;
    hidden?: boolean;
    oldContent: string;
    newContent: string;
    isBinary?: boolean;
    contentType?: string;
    oldContentBase64?: string;
    newContentBase64?: string;
}
export interface GitReposRequest {
    repo?: string;
}
export interface GitRepoRef {
    subdir: string;
    name: string;
    remote: string | null;
    branch?: string | null;
}
export interface GitReposReply {
    repos: GitRepoRef[];
}
export interface GitLogRequest {
    repo: string;
    skip: number;
    limit: number;
}
export interface GitLogEntry {
    hash: string;
    shortHash: string;
    author: string;
    date: string;
    subject: string;
}
export interface GitLogReply {
    entries: GitLogEntry[];
    hasMore: boolean;
}
export interface GitCommitRequest {
    repo: string;
    hash: string;
}
export interface GitCommitFile {
    path: string;
    status: string;
    oldPath?: string;
}
export interface GitCommitReply {
    hash: string;
    author: string;
    date: string;
    subject: string;
    files: GitCommitFile[];
}
export interface GitCommitDiffRequest {
    repo: string;
    hash: string;
    path: string;
}
export interface FsReadRequest {
    path: string;
    target?: FsTarget;
    viewer?: FsViewer;
}
export interface FsReadReply {
    path: string;
    content: string;
    truncated: boolean;
    hidden?: boolean;
    repoBusy?: RepoBusyInfo;
    target?: FsTarget;
    blob?: string | null;
}
export interface QuotaCheckRequest {
    metric: string;
    amount?: number;
}
export interface QuotaCheckReply {
    allowed: boolean;
    remaining: number | null;
    blockedBy?: string;
}
export interface UsageReportPayload {
    events: {
        metric: string;
        amount: number;
        occurredAt: string;
        profile?: string;
        authMode?: "subscription" | "api-key";
        provider?: "claude" | "codex" | "antigravity";
        inputTokens?: number;
        outputTokens?: number;
        cacheReadTokens?: number;
        cacheCreationTokens?: number;
    }[];
}
export interface MachineUsageWindow {
    utilizationPct: number;
    resetsAt: string | null;
}
export interface MachineUsagePayload {
    plan: string;
    aiCli?: string;
    profile?: string;
    session: MachineUsageWindow;
    weekly: MachineUsageWindow;
    extra?: {
        usedCredits: number;
        currency: string;
    };
    checkedAt: string;
    network?: {
        outbound: "open" | "restricted";
        inbound: "exposed" | "isolated";
        containerized: boolean;
        checkedAt: string;
    };
}
export interface ToolHealthReport {
    tool: string;
    ok: boolean;
    message: string | null;
    at: string;
}
export interface CliUpdateResultReport {
    ok: boolean;
    code?: string | null;
    message: string | null;
    fromVersion: string;
    toVersion: string | null;
    at: string;
}
export interface LogReadRequest {
    limit?: number;
}
export interface LogReadReply {
    lines: string[];
}
export interface CommandOutputRequest {
    commandId: string;
}
export interface CommandOutputReply {
    output: string | null;
}
export interface MachineLogPayload {
    fileName: string;
    content: string;
    totalBytes: number;
}
export interface RentalFlushRequest {
    reason?: "release";
}
export interface RentalFlushReply {
    ok: boolean;
}
export interface CommandHistoryPayload {
    commandId: string;
    cmd: string;
    args: string[];
    status: string;
    exitCode?: number | null;
    tokens?: number;
    tokensBreakdown?: {
        input: number;
        output: number;
        cacheRead: number;
        cacheCreation: number;
    };
    projectId?: string | null;
    startedAt: string;
    finishedAt?: string | null;
}
export interface GitEnvRequest {
    provider: string;
}
export interface GitEnvReply {
    installed: boolean;
    authenticated: boolean;
    account: string | null;
    claudeCli: boolean;
}
export interface GitSshKeyRequest {
    op: "generate" | "get" | "delete";
}
export interface GitSshKeyReply {
    publicKey: string | null;
    fingerprint: string | null;
}
export interface ProjectCreatePayload {
    projectId: string;
    projectName: string;
    spec?: Record<string, unknown>;
    gitAuth?: string | null;
    gitAuthHost?: string | null;
}
export interface ScaffoldPublishResult {
    committed: boolean;
    pushed: boolean;
    branch: string | null;
    step: "submodule" | "commit" | "push" | null;
    error: string | null;
    submodules?: {
        dir: string;
        ok: boolean;
        error: string | null;
    }[];
}
export interface RepoProbeRequest {
    url: string;
    branch: string;
    base?: {
        kind: "default" | "branch" | "empty";
        branch?: string;
    };
    submodules?: {
        subdir: string;
        url: string;
        branch: string;
    }[];
}
export interface GitPrResolveRequest {
    repo: string;
    number: number;
    head: string;
    base: string;
    title: string;
}
export interface BranchCandidatePayload {
    name: string;
    sha: string;
    kind: "4pm" | "other";
    reasons: ("merged" | "pr-closed" | "task-gone" | "stale")[];
    lastCommitAt: string;
    author: string;
    pr: {
        number: number;
        state: "open" | "merged" | "closed";
    } | null;
}
export interface BranchDeletionPayload {
    id: string;
    repo: string;
    name: string;
    sha: string;
    reasons: BranchCandidatePayload["reasons"];
    mode: "manual" | "auto";
    by?: string;
    byLabel?: string;
    at: string;
    restoredAt?: string;
}
export interface BranchDeleteResultPayload {
    name: string;
    outcome: "deleted" | "skipped" | "failed";
    detail?: string;
    keptLocal?: boolean;
}
export type GitBranchCleanupRequest = {
    op: "list";
    repo: string;
} | {
    op: "delete";
    repo: string;
    names: string[];
    by: string;
    byLabel?: string;
} | {
    op: "log";
    repo: string;
} | {
    op: "restore";
    repo: string;
    id: string;
    by: string;
    byLabel?: string;
};
export interface GitBranchCleanupReply {
    ok: boolean;
    error?: string;
    code?: "BRANCH_EXISTS" | "BRANCH_RESTORE_UNAVAILABLE";
    candidates?: BranchCandidatePayload[];
    results?: BranchDeleteResultPayload[];
    log?: BranchDeletionPayload[];
}
export interface GitPrResolveReply {
    started: boolean;
    error?: string;
}
export interface RepoProbeReply {
    branchExists: boolean;
    defaultBranch: string | null;
    branches: string[];
    source: {
        ref: string;
        hasScaffold: boolean;
        templateVersion: string | null;
        keep: string[];
        overwrite: string[];
        tracking: string[];
        spec?: Record<string, unknown> | null;
        specError?: string | null;
        settingsModel?: string | null;
    } | null;
    protected: boolean | null;
    submodules: {
        subdir: string;
        url: string;
        branch: string;
        exists: boolean;
        protected: boolean | null;
        error: string | null;
    }[];
    error: string | null;
}
export interface AiModelsRequest {
    provider: "claude" | "codex" | "antigravity";
}
export interface AiModelsReply {
    provider: "claude" | "codex" | "antigravity";
    models: {
        value: string;
        resolvedModel: string | null;
        displayName: string;
        description: string;
    }[];
    cliMissing?: boolean;
    installing?: boolean;
    cliBlocked?: boolean;
    error: string | null;
}
export interface ProjectPublishRequest {
    projectId: string;
}
export interface ProjectPublishReply {
    publish: ScaffoldPublishResult | null;
    error?: string;
}
export interface PhysicSyncPayload {
    oldName: string | null;
    newName: string;
    replace?: boolean;
}
export interface PhysicDeletePayload {
    name: string;
}
export interface ProjectTokensPayload {
    outputLang?: string | null;
    aiRunTimeoutSec: number;
    autoClearIdleMinutes: number;
    sessionSwitchPct: number;
    perPromptTokenLimit: number;
    memory?: {
        mode: "inherit" | "on" | "off";
        budgetChars: number;
    };
    restrictToFolder?: boolean;
    gitAuth?: string | null;
    gitAuthHost?: string | null;
    mcpServers?: McpServerPush[];
    network?: NetworkPolicyPush;
    servedTeams?: string[] | null;
    projectId?: string | null;
    outboundReview?: OutboundReviewPush | null;
    repos?: RepoPush[];
    memoryText?: string;
}
export interface RepoPush {
    primary: boolean;
    url?: string;
    subdir?: string;
    branch?: string;
}
export interface OutboundReviewPush {
    enabled: boolean;
    ruleCheck: boolean;
    aiReview: boolean;
    isOutbound: boolean;
    allowedRepos: string[];
}
export interface NetworkPolicyPush {
    mode: "off" | "audit" | "enforce";
    allow: {
        target: string;
        port: number | null;
    }[];
    deny: {
        target: string;
        port: number | null;
    }[];
    orgDeny: {
        target: string;
        port: number | null;
    }[];
    projectId: string | null;
}
export interface NetworkEventAggregate {
    host: string;
    port: number;
    decision: "allowed" | "would_block" | "blocked" | "denied";
    mode: "off" | "audit" | "enforce";
    count: number;
    firstAt: string;
    lastAt: string;
    projectId: string | null;
    runId?: string;
    taskId?: string;
}
export interface NetworkEventsPayload {
    events: NetworkEventAggregate[];
    dropped?: number;
}
export interface ProjectAddRepo {
    role?: string;
    primary?: boolean;
    op?: "create" | "existing";
    provider?: "gh" | "glab";
    name?: string;
    visibility?: "private" | "public";
    url?: string;
    subdir?: string;
    branch?: string;
    defaultBranch?: string;
    gitignore?: string;
    commitConvention?: string;
}
export interface ProjectAddPayload {
    projectId: string;
    projectName: string;
    repos: ProjectAddRepo[];
    mode?: "sync" | "force";
    scaffoldRepos?: string[];
    detachSubmodules?: string[];
    spec?: Record<string, unknown>;
    gitAuth?: string | null;
    gitAuthHost?: string | null;
}
export interface ProjectJobReply {
    ok: boolean;
    path?: string;
    error?: string;
    step?: string;
    publish?: ScaffoldPublishResult;
}
export interface ProjectProgressPayload {
    projectId: string;
    step: string;
    message: string;
    failCode?: string;
    done?: boolean;
}
export interface ReviewRequestPayload {
    commandId: string;
    prompt: string;
}
export interface ReviewEvaluatePayload {
    commandId: string;
    prompt: string;
    ruleCheck: boolean;
    aiReview: boolean;
    allowedRepos: string[];
    secretPatterns?: string[];
    envPatterns?: string[];
    projectPath?: string;
}
export interface ReviewResultPayload {
    commandId: string;
    ok: boolean;
    reasons: string[];
    tokens?: number;
}
export type AutonomousAlertKind = "books-protected" | "claim-lost" | "task-failed-limit" | "task-split" | "task-question" | "sidecar-tamper" | "autosave" | "auto-paused" | "suspended" | "merge-conflict" | "pr-conflict" | "direct-merge-failed" | "pr-resolve-failed" | "docs-review" | "asset-generator" | "book-cap" | "pr-closed" | "submodule-pr-closed" | "pointer-pr-needs-merge" | "git-access" | "event";
export interface AutonomousAlertPayload {
    kind: AutonomousAlertKind;
    task?: string;
    repo?: string;
    branch?: string;
    message: string;
    event?: {
        type: string;
        fields: Record<string, string | number | boolean>;
    };
}
export interface DiscussionsReadRequest {
    list?: boolean;
    paths?: string[];
    batchId?: string;
}
export interface DiscussionsReadReply {
    files: {
        path: string;
        blobSha: string;
        content?: string;
    }[];
    batchCommit?: string | null;
    error?: string;
}
