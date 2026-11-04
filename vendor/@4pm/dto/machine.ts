/**
 * Vendored from @4pm/dto (machine.ts) by scripts/vendor-shared.mjs — do not edit.
 */
import type { McpServerDefinition } from "./mcp";
import type { ApprovalPublicKey } from "./autonomous-approval";
import type { AutonomousPolicy } from "./autonomous-policy";
import type { NetworkPolicy, NetworkPolicyRule } from "./network";
import { z } from "zod";
import type { MachineLinkScope, PhysicProjectStatus, WorkerStatus, } from "@4pm/shared-constants";
import { hexTokenSchema } from "@4pm/validation";
import { baseRequestSchema } from "./base";
import { bookPatchSchema } from "./book-patch";
import { docReviewSchema } from "./autonomous-docs";
import type { CommandOrigin } from "./command";
import type { GitAuthMethod, ProjectMemoryMode, ProjectTokenSettings, WorkerNetworkProbe, } from "./project";
export interface ProjectAiMemoryPush {
    text: string;
    mode: ProjectMemoryMode;
    budgetChars: number;
}
export const pairRequestSchema = z.object({
    hashcode1: hexTokenSchema,
    userId: z.string().guid().optional(),
});
export type PairRequest = z.infer<typeof pairRequestSchema>;
export interface PairResponse {
    hashcode2: string;
    machineLinkId: string;
}
export const confirmRequestSchema = z.object({
    hashcode2: hexTokenSchema,
    fingerprint: z.string().max(200).optional(),
    hostname: z.string().max(200).optional(),
});
export type ConfirmRequest = z.infer<typeof confirmRequestSchema>;
export interface ConfirmResponse {
    hashcode3: string;
    userId: string;
    username: string;
    scope: string;
    projectName?: string | null;
}
export const wsTokenRequestSchema = z.object({
    hashcode3: hexTokenSchema,
});
export type WsTokenRequest = z.infer<typeof wsTokenRequestSchema>;
export const pairTokenRequestSchema = z.object({
    token: z.string().min(16).max(200),
    fingerprint: z.string().max(200).optional(),
    hostname: z.string().max(200).optional(),
});
export type PairTokenRequest = z.infer<typeof pairTokenRequestSchema>;
export const issueProvisioningTokenRequestSchema = z.object({
    machineLinkId: z.string().guid(),
    ttlSec: z.number().int().min(0).max(2592000).optional(),
});
export type IssueProvisioningTokenRequest = z.infer<typeof issueProvisioningTokenRequestSchema>;
export const provisionRequestSchema = z.object({
    mode: z.enum(["sync", "force"]).optional().default("sync"),
});
export type ProvisionRequest = z.infer<typeof provisionRequestSchema>;
export const provisionForUserRequestSchema = z.object({
    userId: z.string().guid(),
    projectId: z.string().guid(),
    mode: z.enum(["sync", "force"]).optional().default("sync"),
});
export type ProvisionForUserRequest = z.infer<typeof provisionForUserRequestSchema>;
export interface IssueProvisioningTokenResponse {
    token: string;
    expiresAt: string | null;
}
export interface WsTokenResponse {
    wsToken: string;
    wsTokenExpiresAt: string;
    scope: string;
    reconnectMaxBackoffSec: number;
    autoUpdateDaily: boolean;
    autoUpdateHour: number;
    timezone: string;
    cliRetentionDays: number;
    projectTokens: ProjectTokenSettings | null;
    aiMemory: ProjectAiMemoryPush | null;
    aiRestrictToFolder: boolean;
    gitAuth: GitAuthMethod | null;
    gitAuthHost?: string | null;
    mcpServers?: {
        name: string;
        definition: McpServerDefinition;
    }[];
    approvalKeys?: ApprovalPublicKey[];
    approvalProjectId?: string | null;
    servedTeams?: string[] | null;
    autonomousPolicy?: AutonomousPolicy | null;
    network?: NetworkPolicy & {
        orgDeny: NetworkPolicyRule[];
        projectId: string | null;
    };
    maskAiAccounts?: boolean;
    outboundReview: OutboundReviewCliPolicy | null;
    machineUsername: string;
    toolRestore: WorkerToolRestorePush | null;
    wsUrl?: string;
    repos: WsTokenRepo[];
    promptOverrides?: Record<string, Record<string, string>>;
    outputLang?: string | null;
}
export interface WsTokenRepo {
    primary: boolean;
    url?: string;
    subdir?: string;
    branch?: string;
}
export interface OutboundReviewCliPolicy {
    enabled: boolean;
    ruleCheck: boolean;
    aiReview: boolean;
    isOutbound: boolean;
    allowedRepos: string[];
}
export interface WhoamiResponse {
    username: string;
    scope: string;
    roles: string[];
    teams: {
        id: string;
        name: string;
    }[];
    projects: {
        id: string;
        name: string;
    }[];
}
export interface MachineLinkResponse {
    id: string;
    userId: string;
    username: string;
    scope: MachineLinkScope;
    status: string;
    hashcode3ExpiresAt: string | null;
    lastConnectedAt: string | null;
    connected: boolean;
    workerId: string | null;
    cliVersion?: string | null;
    cliOutdated?: boolean;
    cliUnsupported?: boolean;
    cliUnsupportedFrom?: string | null;
    cliVersionNote?: string | null;
    cliUpdateLocked?: boolean;
    cliRestarting?: boolean;
    network?: WorkerNetworkProbe | null;
    failingTools?: WorkerFailingTool[];
    cliUpdateError?: WorkerCliUpdateError | null;
    aiAccounts?: string[];
    aiMounts?: AiMount[];
    aiRuns?: MachineAiRun[];
    createdAt: string;
}
export interface MachineAiRun {
    label: string;
    account?: string;
    provider: string;
    source: string;
    startedAt: string;
}
export interface WorkerGitLogin {
    tool: "gh" | "glab";
    host: string;
    expiryKnown: boolean;
    expiresAt: string | null;
    scopes: string[] | null;
}
export function readWorkerGitLogins(value: unknown): WorkerGitLogin[] {
    if (!Array.isArray(value))
        return [];
    const out: WorkerGitLogin[] = [];
    for (const v of value) {
        if (!v || typeof v !== "object")
            continue;
        const r = v as Record<string, unknown>;
        if ((r.tool !== "gh" && r.tool !== "glab") || typeof r.host !== "string" || !r.host.trim())
            continue;
        const expiryKnown = "expiresAt" in r && (r.expiresAt === null || typeof r.expiresAt === "string");
        out.push({
            tool: r.tool,
            host: r.host.trim().toLowerCase().slice(0, 255),
            expiryKnown,
            expiresAt: typeof r.expiresAt === "string" && !Number.isNaN(Date.parse(r.expiresAt)) ? new Date(r.expiresAt).toISOString() : null,
            scopes: Array.isArray(r.scopes) ? r.scopes.filter((s): s is string => typeof s === "string").map((s) => s.slice(0, 64)).slice(0, 50) : null,
        });
        if (out.length >= 20)
            break;
    }
    return out;
}
export interface AiMount {
    provider: string;
    profile: string;
    account?: string | null;
}
export function readAiMounts(value: unknown): AiMount[] {
    if (!Array.isArray(value))
        return [];
    const out: AiMount[] = [];
    for (const v of value) {
        if (!v || typeof v !== "object")
            continue;
        const { provider, profile, account } = v as Record<string, unknown>;
        if (typeof provider !== "string" || typeof profile !== "string")
            continue;
        if (!provider.trim() || !profile.trim())
            continue;
        out.push({
            provider: provider.trim().slice(0, 32),
            profile: profile.trim().slice(0, 256),
            ...(typeof account === "string" && account.trim() ? { account: account.trim().slice(0, 320) } : {}),
        });
        if (out.length >= 50)
            break;
    }
    return out;
}
export interface WorkerToolHealthEntry {
    ok: boolean;
    message: string | null;
    at: string;
}
export type WorkerToolHealth = Record<string, WorkerToolHealthEntry>;
export interface WorkerFailingTool {
    tool: string;
    message: string;
    at: string;
}
export function readFailingTools(usageSnapshot: unknown): WorkerFailingTool[] {
    const th = (usageSnapshot as {
        toolHealth?: WorkerToolHealth;
    } | null | undefined)?.toolHealth;
    if (!th || typeof th !== "object")
        return [];
    return Object.entries(th)
        .filter(([, v]) => v && typeof v === "object" && v.ok === false)
        .map(([tool, v]) => ({ tool, message: v.message ?? "", at: v.at }))
        .sort((a, b) => (a.at < b.at ? 1 : -1));
}
export interface WorkerCliUpdateEntry {
    ok: boolean;
    code?: CliUpdateErrorCode | null;
    message: string | null;
    fromVersion: string;
    toVersion: string | null;
    at: string;
}
export const CLI_UPDATE_ERROR_CODES = [
    "noSigningKey",
    "signatureMissing",
    "signatureInvalid",
    "checksumMismatch",
    "downloadFailed",
    "downloadTimeout",
    "stageFailed",
    "extractFailed",
    "loadFailed",
    "notApplied",
    "badVersion",
    "didNotStart",
    "locked",
    "unknown",
] as const;
export type CliUpdateErrorCode = (typeof CLI_UPDATE_ERROR_CODES)[number];
export interface WorkerCliUpdateError {
    code: CliUpdateErrorCode | null;
    message: string;
    at: string;
}
export function isCliUpdateErrorCode(value: unknown): value is CliUpdateErrorCode {
    return typeof value === "string" && (CLI_UPDATE_ERROR_CODES as readonly string[]).includes(value);
}
export interface CliUpdateAllTarget {
    id: string;
    label: string;
}
export type CliUpdateAllSkipReason = "autonomous" | "failed" | "locked";
export interface CliUpdateAllSkip extends CliUpdateAllTarget {
    reason: CliUpdateAllSkipReason;
}
export interface CliUpdateAllResponse {
    queued: CliUpdateAllTarget[];
    skipped: CliUpdateAllSkip[];
}
export const autonomousAllRequestSchema = z.object({ paused: z.boolean() });
export type AutonomousAllBody = z.infer<typeof autonomousAllRequestSchema>;
export interface AutonomousAllSkip extends CliUpdateAllTarget {
    reason: "failed";
}
export interface AutonomousAllResponse {
    done: CliUpdateAllTarget[];
    skipped: AutonomousAllSkip[];
}
export function readCliUpdateError(usageSnapshot: unknown): WorkerCliUpdateError | null {
    const cu = (usageSnapshot as {
        cliUpdate?: WorkerCliUpdateEntry;
    } | null | undefined)?.cliUpdate;
    if (!cu || typeof cu !== "object" || cu.ok !== false)
        return null;
    return {
        code: isCliUpdateErrorCode(cu.code) ? cu.code : null,
        message: (cu.message ?? "").replace(/\s*(?:\(ADR-\d+(?:\/\d+)*\)|— ADR-\d+)/g, ""),
        at: cu.at,
    };
}
export interface PhysicProjectResponse {
    id: string;
    machineLinkId: string;
    projectId: string;
    projectName: string;
    path: string | null;
    name: string;
    isAutonomous: boolean;
    autonomousPaused: boolean;
    status: PhysicProjectStatus;
    lastSeenAt: string | null;
}
export interface WorkerMachineLinkNode {
    id: string;
    userId: string;
    username: string;
    scope: string;
    connected: boolean;
    physicProject: PhysicProjectResponse | null;
    egress?: "container" | "none" | null;
    egressReason?: string | null;
    hosting?: {
        allowed: boolean;
        modes: ("process" | "compose")[];
        hostable: boolean;
        serving: {
            projectName: string;
            environmentName: string;
        }[];
    } | null;
}
export interface WorkerResources {
    cpuPct: number;
    cpuCount: number;
    memUsedMb: number;
    memTotalMb: number;
    diskUsedGb: number;
    diskTotalGb: number;
    platform: string;
    arch: string;
    source: "cgroup" | "os";
    at: string;
    cpuThrottledPct?: number;
    cpuPressurePct?: number;
    memAnonMb?: number;
    memCacheMb?: number;
    swapUsedMb?: number;
    swapTotalMb?: number | null;
    memPressurePct?: number;
    oomKills?: number;
    diskReadMbps?: number;
    diskWriteMbps?: number;
    ioPressurePct?: number;
    pidsCurrent?: number;
    pidsMax?: number | null;
    warnings?: string[];
}
export interface MachineMetricsPayload {
    fingerprint: string;
    resources: WorkerResources;
}
export interface WorkerMetricsSample {
    cpuPct: number;
    memUsedMb: number;
    memTotalMb: number;
    diskUsedGb: number;
    diskTotalGb: number;
    at: string;
    cpuThrottledPct?: number;
    cpuPressurePct?: number;
    memPressurePct?: number;
    ioPressurePct?: number;
    diskReadMbps?: number;
    diskWriteMbps?: number;
    swapUsedMb?: number;
}
export interface WorkerMetricsSeriesResponse {
    workerId: string;
    samples: WorkerMetricsSample[];
    source: "cgroup" | "os";
    resources: WorkerResources | null;
}
export interface WorkerResponse {
    id: string;
    name: string;
    fingerprint: string;
    status: WorkerStatus;
    lastSeenAt: string | null;
    machineLinks: WorkerMachineLinkNode[];
    resources?: WorkerResources | null;
}
export interface MachineUsageWindow {
    utilizationPct: number;
    resetsAt: string | null;
}
export interface MachineUsageSubscription {
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
}
export interface MachineUsageStatus {
    connected: boolean;
    scope: string;
    busy: boolean;
    aiRuns?: MachineAiRun[];
    serving: {
        projectId: string;
        name: string;
    } | null;
    cliVersion?: string | null;
    cliOutdated?: boolean;
    cliUnsupported?: boolean;
    cliUnsupportedFrom?: string | null;
    cliVersionNote?: string | null;
    cliUpdateLocked?: boolean;
    cliRestarting?: boolean;
    latestCliVersion?: string | null;
    minSupportedCliVersion?: string | null;
    cliUpdateError?: WorkerCliUpdateError | null;
}
export interface MachineProjectUsage {
    projectId: string;
    name: string;
    tokens: number;
    commands: number;
    current: boolean;
}
export interface LogReadResponse {
    lines: string[];
}
export interface CommandHistoryItem {
    id: string;
    commandId: string;
    origin: CommandOrigin;
    machineLinkId: string;
    machineUser: string;
    cmd: string;
    args: string[];
    status: string;
    exitCode: number | null;
    tokens: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
    cacheReadTokens: number | null;
    cacheCreationTokens: number | null;
    projectId: string | null;
    startedAt: string;
    finishedAt: string | null;
    egressAudited?: boolean;
}
export interface MachineUsageResponse {
    linkId: string;
    userId: string;
    username: string;
    workerId: string | null;
    status: MachineUsageStatus;
    subscription: MachineUsageSubscription | null;
    projects: MachineProjectUsage[];
    network?: WorkerNetworkProbe | null;
}
export const listWorkersQuerySchema = baseRequestSchema.extend({
    status: z.enum(["online", "offline"]).optional(),
    minCpuPct: z.coerce.number().min(0).max(100).optional(),
    minMemPct: z.coerce.number().min(0).max(100).optional(),
    minDiskPct: z.coerce.number().min(0).max(100).optional(),
    hideEmptyClis: z.enum(["true", "false"]).transform((v) => v === "true").optional(),
});
export type ListWorkersQuery = z.infer<typeof listWorkersQuerySchema>;
export const updateWorkerRequestSchema = z.object({
    name: z.string().min(1).max(100).optional(),
});
export type UpdateWorkerRequest = z.infer<typeof updateWorkerRequestSchema>;
export const putPhysicProjectRequestSchema = z.object({
    projectId: z.string().guid(),
    path: z.string().min(1).max(500).nullable().optional(),
    name: z.string().max(100).optional(),
});
export type PutPhysicProjectRequest = z.infer<typeof putPhysicProjectRequestSchema>;
export const patchPhysicProjectRequestSchema = z.object({
    name: z.string().min(1).max(100).optional(),
    projectId: z.string().guid().optional(),
    disabled: z.boolean().optional(),
});
export type PatchPhysicProjectRequest = z.infer<typeof patchPhysicProjectRequestSchema>;
export const listMachineLinksQuerySchema = baseRequestSchema.extend({
    status: z.string().max(20).optional(),
});
export type ListMachineLinksQuery = z.infer<typeof listMachineLinksQuerySchema>;
export const updateMachineLinkRequestSchema = z.object({
    hashcode3ExpiresAt: z.string().datetime().nullable(),
});
export type UpdateMachineLinkRequest = z.infer<typeof updateMachineLinkRequestSchema>;
export type FsTarget = "base" | "worktree";
export const fsTargetSchema = z.enum(["base", "worktree"]).optional();
export interface FsWriteOutcome {
    target?: FsTarget;
    commit?: string;
}
export interface FsEntry {
    name: string;
    type: "dir" | "file";
}
export interface FsListResponse {
    path: string;
    entries: FsEntry[];
    target?: FsTarget;
    ref?: string;
    commit?: string;
}
export interface RepoBusy {
    holder: "autonomous" | "command" | "git" | "project";
    task?: string;
    branch?: string;
}
export interface FsReadResponse {
    path: string;
    content: string;
    truncated: boolean;
    repoBusy?: RepoBusy;
    target?: FsTarget;
    blob?: string | null;
}
export interface ConfigReadResponse {
    config: string;
}
export interface ConfigWriteResponse {
    ok: boolean;
    error?: string;
}
export interface WorkerToolStatus {
    id: string;
    label: string;
    category: "runtime" | "ai-cli" | "vcs";
    installed: boolean;
    version: string | null;
    installable: boolean;
    updatable: boolean;
    autoUpdate: boolean;
}
export interface WorkerFeatureToolStatus {
    id: "rag" | "playwright" | "chromium" | "vhs" | "ttyd" | "ffmpeg" | "xvfb";
    feature: "rag" | "marketing";
    label: string;
    installed: boolean;
    version: string | null;
    source: "auto" | "system" | "detect";
    detail?: string | null;
}
export interface WorkerToolsResponse {
    catalog: WorkerToolStatus[];
    extras: WorkerToolStatus[];
    checkedAt: string | null;
    online: boolean;
    features?: WorkerFeatureToolStatus[];
    restoreFailed?: ToolRestoreFailure[];
}
export interface ToolManifestEntry {
    name: string;
    version: string;
    manager: "npm" | "pnpm";
}
export type ToolRestoreFailReason = "timeout" | "network" | "not-found" | "engine" | "other";
export interface ToolRestoreFailure {
    name: string;
    version: string;
    reason: ToolRestoreFailReason;
    retryable: boolean;
}
export interface WorkerToolSnapshot {
    catalog: WorkerToolStatus[];
    extras: WorkerToolStatus[];
    features?: WorkerFeatureToolStatus[];
    restoreFailed?: ToolRestoreFailure[];
}
export interface WorkerToolRestorePush {
    manifest: ToolManifestEntry[];
    autoUpdate: string[];
}
export const workerToolCopySchema = z.object({
    sourceLinkId: z.string().guid(),
    targetLinkIds: z.array(z.string().guid()).min(1).max(200),
});
export type WorkerToolCopyRequest = z.infer<typeof workerToolCopySchema>;
export type WorkerToolCopyTargetStatus = "online" | "queued" | "skipped";
export interface WorkerToolCopyResponse {
    results: {
        targetLinkId: string;
        status: WorkerToolCopyTargetStatus;
    }[];
}
export const adminPoolToolsCopySchema = z.object({
    sourceUserId: z.string().guid(),
    targetUserIds: z.array(z.string().guid()).min(1).max(200),
});
export type AdminPoolToolsCopyRequest = z.infer<typeof adminPoolToolsCopySchema>;
export interface AdminPoolToolsCopyResponse {
    results: {
        targetUserId: string;
        status: WorkerToolCopyTargetStatus;
    }[];
}
export const workerToolInstallSchema = z.object({
    name: z.string().trim().min(1).max(214),
    manager: z.enum(["npm", "pnpm"]),
});
export type WorkerToolInstallRequest = z.infer<typeof workerToolInstallSchema>;
export const workerToolAutoUpdateSchema = z.object({
    name: z.string().trim().min(1).max(214),
    enabled: z.boolean(),
});
export type WorkerToolAutoUpdateRequest = z.infer<typeof workerToolAutoUpdateSchema>;
export interface WorkerToolAutoUpdateResponse {
    ok: boolean;
}
export interface WorkerToolOpResponse {
    opId: string;
}
export type WorkerToolProgressEvent = {
    type: "line";
    line: string;
} | {
    type: "done";
    ok: boolean;
    exitCode: number;
    error?: string;
};
export interface WorkerToolOpResult {
    ok: boolean;
    exitCode: number;
    lines: string[];
    error?: string;
}
export const configWriteRequestSchema = z.object({
    config: z.string().max(256 * 1024),
});
export type ConfigWriteRequestBody = z.infer<typeof configWriteRequestSchema>;
export const FILE_WRITE_MAX_BYTES = 2 * 1024 * 1024;
export const fsWriteRequestSchema = z.object({
    path: z.string().min(1).max(1024),
    content: z.string().max(FILE_WRITE_MAX_BYTES),
    target: fsTargetSchema,
    expectBlob: z.string().regex(/^[0-9a-f]{40,64}$/).nullable().optional(),
});
export type FsWriteRequestBody = z.infer<typeof fsWriteRequestSchema>;
export interface FsWriteResponse extends FsWriteOutcome {
    path: string;
    bytes: number;
    repoBusy?: RepoBusy;
}
export const fsMutateRequestSchema = z.object({
    op: z.enum(["mkdir", "create", "move", "delete"]),
    path: z.string().max(1024).optional(),
    content: z.string().max(FILE_WRITE_MAX_BYTES).optional(),
    from: z.string().max(1024).optional(),
    to: z.string().max(1024).optional(),
    target: fsTargetSchema,
});
export type FsMutateRequestBody = z.infer<typeof fsMutateRequestSchema>;
export interface FsMutateResponse extends FsWriteOutcome {
    path: string;
    repoBusy?: RepoBusy;
}
export const FS_TRANSFER_MAX_BYTES = 10 * 1024 * 1024;
const FS_TRANSFER_MAX_BASE64 = Math.ceil((FS_TRANSFER_MAX_BYTES * 4) / 3) + 16;
export const fsUploadRequestSchema = z.object({
    path: z.string().min(1).max(1024),
    contentBase64: z.string().min(1).max(FS_TRANSFER_MAX_BASE64),
    contentType: z.string().max(255).optional(),
    target: fsTargetSchema,
});
export type FsUploadRequestBody = z.infer<typeof fsUploadRequestSchema>;
export interface FsUploadResponse extends FsWriteOutcome {
    path: string;
    bytes: number;
    repoBusy?: RepoBusy;
}
export interface FsDownloadResponse {
    contentBase64: string;
    contentType: string;
    name: string;
    size: number;
}
export const taskApproveRequestSchema = z.object({
    taskId: z.string().min(1).max(64),
    approved: z.boolean(),
});
export type TaskApproveRequestBody = z.infer<typeof taskApproveRequestSchema>;
export const taskApproveEntrySchema = z.object({
    taskId: z.string().min(1).max(64),
    tags: z.array(z.string().min(1).max(64)).max(16).default([]),
});
export type TaskApproveEntry = z.infer<typeof taskApproveEntrySchema>;
export interface TaskApproveBatchResponse {
    ok: boolean;
    failedTaskId?: string;
    reason?: string;
}
export const EVIDENCE_MAX_BYTES = 5 * 1024 * 1024;
export const EVIDENCE_MAX_PER_SAVE = 20;
export const EVIDENCE_ROOT = ".4pm/evidence";
export const MOCKUP_ROOT = ".4pm/mockups";
export const EVIDENCE_BOOK_DIR = { userTodo: "USER_TODO", userQa: "USER_QA", aiTodo: "AI_TODO", aiDone: "AI_DONE" } as const;
export type EvidenceBookKey = keyof typeof EVIDENCE_BOOK_DIR;
export function isSafeRepoDir(dir: string): boolean {
    if (!/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(dir) || dir.length > 200)
        return false;
    const segs = dir.split("/");
    return !segs.some((s) => s === "." || s === "..") && segs[0] !== ".git";
}
export const SAFE_REPO_PATH_RE = /^(?!\.git\/)(?!.*(?:^|\/)\.{1,2}\/)[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+){0,15}$/;
export const EVIDENCE_PATH_RE = /^((?:[A-Za-z0-9._-]+\/){0,8}?[A-Za-z0-9._-]+)\/(USER_TODO|USER_QA|AI_TODO|AI_DONE)\/([A-Z]+-\d{6}-\d{3})\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/;
function bookSaveShapeOk(b: {
    patch?: unknown;
    content?: unknown;
    baseHash?: unknown;
}): boolean {
    return b.patch !== undefined ? b.content === undefined : typeof b.content === "string" && typeof b.baseHash === "string";
}
export const taskApproveBatchRequestSchema = z.object({
    approvals: z.array(taskApproveEntrySchema).max(500).default([]),
    unapprovals: z.array(z.string().min(1).max(64)).max(500).default([]),
    book: z
        .object({
        patch: bookPatchSchema.optional(),
        content: z.string().max(256 * 1024).optional(),
        baseHash: z.string().max(32).optional(),
        evidence: z
            .array(z.object({ stageId: z.string().guid(), path: z.string().regex(EVIDENCE_PATH_RE) }))
            .max(EVIDENCE_MAX_PER_SAVE)
            .optional(),
    })
        .refine(bookSaveShapeOk, { message: "send `patch`, or `content` with `baseHash`" })
        .optional(),
    docReview: docReviewSchema.optional(),
    lineageFrom: z.record(z.string().regex(/^\d{6}$/), z.string().regex(/^\d{6}$/)).optional(),
});
export type TaskApproveBatchRequestBody = z.infer<typeof taskApproveBatchRequestSchema>;
const EVIDENCE_LINK_RE = /(!?)\[([^\]\n]*)\]\(<?((?:[A-Za-z0-9._-]+\/){1,9}(?:USER_TODO|USER_QA|AI_TODO|AI_DONE)\/[A-Z]+-\d{6}-\d{3}\/[A-Za-z0-9][A-Za-z0-9._-]{0,127})>?\)/g;
export function isEvidencePath(path: string): boolean {
    const m = EVIDENCE_PATH_RE.exec(path);
    return Boolean(m && isSafeRepoDir(m[1] ?? ""));
}
export interface EvidenceLink {
    markdown: string;
    label: string;
    path: string;
    image: boolean;
}
export function evidenceSlug(name: string): string {
    const s = name
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[đĐ]/g, (c) => (c === "đ" ? "d" : "D"))
        .replace(/[^A-Za-z0-9._-]+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^[-.]+|-+$/g, "");
    return (s || "file").slice(-100);
}
export function evidencePath(root: string, book: EvidenceBookKey, rowId: string, k: number, name: string): string {
    return `${root}/${EVIDENCE_BOOK_DIR[book]}/${rowId}/${k}-${evidenceSlug(name)}`;
}
export function evidenceMarkdown(name: string, path: string, mime: string): string {
    const label = name.replace(/[[\]\n]/g, " ").trim() || "file";
    return `${mime.startsWith("image/") ? "!" : ""}[${label}](${path})`;
}
export function evidenceLinks(text: string): EvidenceLink[] {
    return [...text.matchAll(EVIDENCE_LINK_RE)].map((m) => ({
        markdown: m[0],
        image: m[1] === "!",
        label: m[2] ?? "",
        path: m[3] ?? "",
    }));
}
export function nextEvidenceNumber(text: string, folder: string): number {
    let max = 0;
    for (const l of evidenceLinks(text)) {
        if (!l.path.startsWith(`${folder}/`))
            continue;
        const k = Number(/^(\d+)-/.exec(l.path.slice(folder.length + 1))?.[1] ?? 0);
        max = Math.max(max, k);
    }
    return max + 1;
}
export const EVIDENCE_REV_RE = /^[0-9a-f]{7,40}$/;
export const autonomousEvidenceQuerySchema = z.object({
    path: z.string().max(400).regex(SAFE_REPO_PATH_RE),
    ref: z.string().regex(/^[A-Za-z0-9._/-]{1,200}$/).optional(),
    rev: z.string().regex(EVIDENCE_REV_RE).optional(),
});
export type AutonomousEvidenceQuery = z.infer<typeof autonomousEvidenceQuerySchema>;
export const evidenceHistoryQuerySchema = z.object({
    path: z.string().max(400).regex(SAFE_REPO_PATH_RE),
});
export type EvidenceHistoryQuery = z.infer<typeof evidenceHistoryQuerySchema>;
export const DONE_ROW_ID_RE = /^(TSK|DOC)-\d{6}-\d{3}$/;
export const doneFileQuerySchema = z.object({
    path: z.string().min(1).max(400).regex(SAFE_REPO_PATH_RE),
    side: z.enum(["after", "before"]).optional(),
    list: z
        .enum(["true", "false"])
        .optional()
        .transform((v) => v === "true"),
});
export type DoneFileQuery = z.infer<typeof doneFileQuerySchema>;
export type DoneFileSourceKind = "merge" | "branch" | "head" | "pr-ref" | "deleted-tip" | "base";
export interface DoneFilesResponse {
    repos: {
        dir: string;
        source: DoneFileSourceKind;
        ref: string;
        sha: string;
        baseSha?: string;
        warning?: "base-fallback";
    }[];
    files: {
        path: string;
        repo: string;
        status: "A" | "M" | "D" | "R" | "?";
        dir?: boolean;
    }[];
    legacy: boolean;
}
export interface DoneFileResponse {
    contentBase64?: string;
    contentType?: string;
    name?: string;
    size?: number;
    source?: DoneFileSourceKind;
    sha?: string;
    entries?: {
        path: string;
        type: "file" | "dir";
    }[];
    missing?: boolean;
}
export const evidenceRestoreSchema = z.object({
    path: z.string().max(400).regex(SAFE_REPO_PATH_RE),
    rev: z.string().regex(EVIDENCE_REV_RE),
});
export type EvidenceRestoreInput = z.infer<typeof evidenceRestoreSchema>;
const GIT_REF_RE = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/;
export const gitPrResolveSchema = z.object({
    repo: z.string().max(200).regex(/^$|^(?!\/)(?!.*\.\.)[A-Za-z0-9._/-]+$/).default(""),
    number: z.number().int().positive(),
    head: z.string().regex(GIT_REF_RE),
    base: z.string().regex(GIT_REF_RE),
    title: z.string().max(300).default(""),
});
export type GitPrResolveInput = z.infer<typeof gitPrResolveSchema>;
export interface EvidenceRestoreResponse {
    result: "published" | "unchanged";
}
export interface AutonomousEvidenceStageResponse {
    stageId: string;
    name: string;
    size: number;
}
export const autonomousWriteRequestSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("settings"), settings: z.string().max(64 * 1024) }),
    z.object({ kind: z.literal("approvals"), taskId: z.string().min(1).max(64), approved: z.boolean() }),
    z.object({
        kind: z.literal("approvalsBatch"),
        approve: z.array(z.string().min(1).max(64)).max(500),
        unapprove: z.array(z.string().min(1).max(64)).max(500),
    }),
    z.object({ kind: z.literal("userTodo"), content: z.string().min(1).max(16 * 1024) }),
    z.object({
        kind: z.literal("bookSave"),
        book: z.enum(["userTodo", "userQa", "aiTodo", "aiDone"]),
        patch: bookPatchSchema.optional(),
        content: z.string().max(256 * 1024).optional(),
        baseHash: z.string().max(32).optional(),
        evidence: z
            .array(z.object({ stageId: z.string().guid(), path: z.string().regex(EVIDENCE_PATH_RE) }))
            .max(EVIDENCE_MAX_PER_SAVE)
            .optional(),
        approve: z.array(z.string().min(1).max(64)).max(500).optional(),
        unapprove: z.array(z.string().min(1).max(64)).max(500).optional(),
        lineageFrom: z.record(z.string().regex(/^\d{6}$/), z.string().regex(/^\d{6}$/)).optional(),
    }),
]).refine((b) => b.kind !== "bookSave" || bookSaveShapeOk(b), { message: "send `patch`, or `content` with `baseHash`" });
export type AutonomousWriteBody = z.infer<typeof autonomousWriteRequestSchema>;
export const autonomousLogsQuerySchema = z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});
export type AutonomousLogsQuery = z.infer<typeof autonomousLogsQuerySchema>;
export const autonomousReadQuerySchema = z.object({
    donePage: z.coerce.number().int().min(1).max(100000).optional(),
    doneSize: z.coerce.number().int().min(1).max(200).optional(),
});
export type AutonomousReadQuery = z.infer<typeof autonomousReadQuerySchema>;
const daySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const autonomousArchiveQuerySchema = z.object({
    from: daySchema.optional(),
    to: daySchema.optional(),
    book: z.enum(["USER_TODO", "USER_QA", "AI_DONE"]).optional(),
    id: z.string().regex(/^[A-Z]{2,3}(?:-\d{1,6}(?:-\d{0,3})?)?$/).optional(),
    q: z.string().max(200).optional(),
    team: z.string().max(40).optional(),
    tag: z.string().max(60).optional(),
    requester: z.string().uuid().optional(),
    state: z.enum(["Taken in", "Done"]).optional(),
    delivery: z.enum(["open", "merged", "closed", "direct"]).optional(),
    page: z.coerce.number().int().min(1).max(100000).optional(),
    size: z.coerce.number().int().min(1).max(100).optional(),
});
export type AutonomousArchiveQuery = z.infer<typeof autonomousArchiveQuerySchema>;
const agentNameSchema = z.string().min(1).max(64).regex(/^[\w.-]+$/);
export const agentReadQuerySchema = z.object({
    kind: z.enum(["subagent", "skill"]),
    name: agentNameSchema,
    target: fsTargetSchema,
});
export type AgentReadQuery = z.infer<typeof agentReadQuerySchema>;
export const ragInstallRequestSchema = z.object({
    model: z.string().min(1).max(200),
});
export type RagInstallBody = z.infer<typeof ragInstallRequestSchema>;
export const ragQueryQuerySchema = z.object({
    q: z.string().min(1).max(2000),
    k: z.coerce.number().int().min(1).max(20).optional(),
    kinds: z
        .string()
        .max(400)
        .regex(/^[a-z][a-z0-9-]{0,31}(,[a-z][a-z0-9-]{0,31}){0,23}$/)
        .optional(),
});
export type RagQueryQuery = z.infer<typeof ragQueryQuerySchema>;
export const ragSettingsRequestSchema = z.object({
    minScore: z.number().min(0).max(1),
    topK: z.number().int().min(1).max(20),
    rerank: z.boolean().optional(),
});
export type RagSettingsBody = z.infer<typeof ragSettingsRequestSchema>;
export const graphBuildQuerySchema = z.object({
    mode: z.enum(["docs", "code", "all"]),
});
export type GraphBuildQuery = z.infer<typeof graphBuildQuerySchema>;
const secretKeySchema = z.string().min(1).max(128).regex(/^[\w.-]+$/);
export const secretsWriteRequestSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("security"), content: z.string().max(128 * 1024) }),
    z.object({ kind: z.literal("placeholder"), content: z.string().max(128 * 1024) }),
    z.object({ kind: z.literal("secret"), key: secretKeySchema, value: z.string().max(8192) }),
    z.object({ kind: z.literal("secretDelete"), key: secretKeySchema }),
]);
export type SecretsWriteBody = z.infer<typeof secretsWriteRequestSchema>;
export const agentWriteRequestSchema = z
    .object({
    kind: z.enum(["subagent", "skill"]),
    name: agentNameSchema,
    action: z.enum(["write", "delete"]),
    content: z.string().max(128 * 1024).optional(),
    target: fsTargetSchema,
})
    .superRefine((v, ctx) => {
    if (v.action === "write" && (v.content === undefined || v.content.length === 0)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["content"], message: "content is required for write" });
    }
});
export type AgentWriteBody = z.infer<typeof agentWriteRequestSchema>;
const toolRuleSchema = z.string().min(1).max(500);
const agentToolsPermissionsSchema = z.object({
    defaultMode: z.enum(["default", "acceptEdits", "plan", "bypassPermissions"]),
    allow: z.array(toolRuleSchema).max(500),
    deny: z.array(toolRuleSchema).max(500),
});
export const agentToolsReadQuerySchema = z.object({
    scope: z.enum(["shared", "local"]),
});
export type AgentToolsReadQuery = z.infer<typeof agentToolsReadQuerySchema>;
export const agentToolsWriteRequestSchema = z.object({
    scope: z.enum(["shared", "local"]),
    permissions: agentToolsPermissionsSchema,
});
export type AgentToolsWriteBody = z.infer<typeof agentToolsWriteRequestSchema>;
export interface GitDiffResponse {
    path: string;
    oldContent: string;
    newContent: string;
    isBinary?: boolean;
    contentType?: string;
    oldContentBase64?: string;
    newContentBase64?: string;
}
export interface GitRepoRef {
    subdir: string;
    name: string;
    remote: string | null;
    branch?: string | null;
}
export interface GitLogEntry {
    hash: string;
    shortHash: string;
    author: string;
    date: string;
    subject: string;
}
export interface GitLogResponse {
    entries: GitLogEntry[];
    hasMore: boolean;
}
export interface GitCommitFile {
    path: string;
    status: string;
    oldPath?: string;
}
export interface GitCommitResponse {
    hash: string;
    author: string;
    date: string;
    subject: string;
    files: GitCommitFile[];
}
export interface GitEnvResponse {
    installed: boolean;
    authenticated: boolean;
    account: string | null;
    claudeCli: boolean;
}
export interface SshDeployKeyResponse {
    publicKey: string | null;
    fingerprint: string | null;
}
export const AI_MODEL_PROVIDERS = ["claude", "codex", "antigravity"] as const;
export type AiModelProvider = (typeof AI_MODEL_PROVIDERS)[number];
export const aiModelsQuerySchema = z.object({
    provider: z.enum(AI_MODEL_PROVIDERS).optional().default("claude"),
});
export type AiModelsQuery = z.infer<typeof aiModelsQuerySchema>;
export interface AiModelOption {
    value: string;
    resolvedModel: string | null;
    displayName: string;
    description: string;
}
export interface AiModelsResponse {
    provider: AiModelProvider;
    models: AiModelOption[];
    cliMissing: boolean;
    installing: boolean;
    cliBlocked: boolean;
    error: string | null;
}
