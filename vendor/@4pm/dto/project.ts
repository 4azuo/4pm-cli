/**
 * Vendored from @4pm/dto (project.ts) by scripts/vendor-shared.mjs — do not edit.
 */
import { z } from "zod";
import { UsageMetric, type PhysicProjectStatus, type ProjectStatus } from "@4pm/shared-constants";
import { ipAllowlistSchema } from "@4pm/validation";
import { baseRequestSchema, deletedFilterSchema, pinnedFilterSchema } from "./base";
import type { UserResponse } from "./user";
import { TEMPLATE_KINDS, type ProjectTemplateSelection } from "./template";
import { readMcpServers, type McpApprovedServer } from "./mcp";
import { readProjectNetworkSettings, DEFAULT_NETWORK_MODE, defaultNetworkAllowRules, type ProjectNetworkSettings } from "./network";
import { classifyProjectFailure, type ProjectFailCode } from "./project-failure";
import { DEFAULT_PROJECT_MODES, projectModesSchema, readProjectModes, type ProjectModes } from "./project-modes";
export interface ProjectManagerSummary {
    id: string;
    username: string;
}
export interface ScaffoldPublish {
    machineLinkId: string;
    committed: boolean;
    pushed: boolean;
    branch: string | null;
    step: "submodule" | "commit" | "push" | null;
    error: string | null;
    errorCode: ProjectFailCode | null;
    submodules: {
        dir: string;
        ok: boolean;
        error: string | null;
        errorCode: ProjectFailCode | null;
    }[];
    at: string;
}
export function readScaffoldPublish(raw: unknown): ScaffoldPublish | null {
    if (!raw || typeof raw !== "object")
        return null;
    const r = raw as Record<string, unknown>;
    const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
    const step = r.step === "submodule" || r.step === "commit" || r.step === "push" ? r.step : null;
    const submodules = Array.isArray(r.submodules)
        ? (r.submodules as Record<string, unknown>[]).map((x) => {
            const ok = x.ok === true;
            const error = str(x.error);
            return { dir: str(x.dir) ?? "", ok, error, errorCode: ok ? null : classifyProjectFailure(error) };
        })
        : [];
    const error = str(r.error);
    return {
        machineLinkId: str(r.machineLinkId) ?? "",
        committed: r.committed === true,
        pushed: r.pushed === true,
        branch: str(r.branch),
        step,
        error,
        errorCode: step ? classifyProjectFailure(error) : null,
        submodules,
        at: str(r.at) ?? "",
    };
}
export interface ProjectResponse {
    id: string;
    orgId: string;
    name: string;
    description: string;
    avatarUrl: string | null;
    status: ProjectStatus;
    failCode: ProjectFailCode | null;
    failRef: string | null;
    failedStep: string | null;
    scaffoldPublish: ScaffoldPublish | null;
    ipAllowlist: string[];
    messengerRetentionDays: number;
    settings: ProjectSettings;
    groupPath: string[];
    pinned: boolean;
    pm: ProjectManagerSummary | null;
    teamCount: number;
    userCount: number;
    machineCount: number;
    autonomousEnabled: boolean;
    createdAt: string;
    updatedAt: string;
}
export interface ProjectTeamMember {
    id: string;
    username: string;
    email: string;
    phone: string | null;
    avatarUrl: string | null;
    paused: boolean;
}
export interface ProjectTeamSummary {
    id: string;
    name: string;
    code: string;
    avatarUrl: string | null;
    paused: boolean;
    members: ProjectTeamMember[];
}
export interface ProjectCliInfo {
    machineLinkId: string;
    path: string | null;
    status: PhysicProjectStatus;
    userId: string | null;
    isRented: boolean;
    network: WorkerNetworkProbe | null;
}
export interface ProjectMembersResponse {
    users: UserResponse[];
}
export interface ProjectDetailResponse extends ProjectResponse {
    teams: ProjectTeamSummary[];
    users: UserResponse[];
    pm: UserResponse | null;
    cli: ProjectCliInfo | null;
    pausedMemberIds: string[];
    pausedTeamIds: string[];
}
export const listProjectsQuerySchema = baseRequestSchema.extend({
    pinned: pinnedFilterSchema,
    teamId: z.string().guid().optional(),
    deleted: deletedFilterSchema,
});
export type ListProjectsQuery = z.infer<typeof listProjectsQuerySchema>;
export const recentProjectsQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(20).default(5),
});
export type RecentProjectsQuery = z.infer<typeof recentProjectsQuerySchema>;
export const createProjectRequestSchema = z.object({
    name: z.string().min(1).max(100),
    description: z.string().max(2000).optional(),
    machineUserId: z.string().guid().optional(),
    modes: projectModesSchema.optional(),
});
export type CreateProjectRequest = z.infer<typeof createProjectRequestSchema>;
export const copyProjectRequestSchema = z.object({
    name: z.string().min(1).max(100),
});
export type CopyProjectRequest = z.infer<typeof copyProjectRequestSchema>;
export interface ProjectTokenSettings {
    sessionSwitchPct: number;
    perPromptTokenLimit: number;
    aiRunTimeoutSec: number;
    autoClearIdleMinutes: number;
}
export const PROJECT_ALERT_KINDS = ["budgetPercent", "absolute"] as const;
export type ProjectAlertKind = (typeof PROJECT_ALERT_KINDS)[number];
export const projectAlertRuleSchema = z.object({
    id: z.string().min(1).max(64),
    kind: z.enum(PROJECT_ALERT_KINDS),
    metric: z.enum([UsageMetric.AI_TOKENS, UsageMetric.COMMANDS]),
    threshold: z.number().int().min(1),
    email: z.union([z.string().email(), z.literal("")]).optional(),
    notifyUserId: z.union([z.string().guid(), z.literal("")]).optional(),
    enabled: z.boolean().default(true),
});
export type ProjectAlertRule = z.infer<typeof projectAlertRuleSchema>;
export const projectAlertsSchema = z.object({
    rules: z.array(projectAlertRuleSchema).max(100).default([]),
});
export type ProjectAlerts = z.infer<typeof projectAlertsSchema>;
export function readProjectAlertRules(settings: Record<string, unknown> | null | undefined): ProjectAlertRule[] {
    const parsed = projectAlertsSchema.safeParse((settings ?? {})["alerts"] ?? { rules: [] });
    return parsed.success ? parsed.data.rules : [];
}
export interface OutboundReviewSettings {
    enabled: boolean;
    ruleCheck: boolean;
    aiReview: boolean;
    outboundLinkIds: string[];
    outboundPoolIds: string[];
    allowedRepos: string[];
    blockImages: boolean;
    rules: OutboundReviewRules;
}
export interface OutboundReviewRules {
    secret: string[];
    environment: string[];
}
export const DEFAULT_OUTBOUND_RULES: OutboundReviewRules = {
    secret: [
        String.raw `/\b(api[_-]?key|secret|password|passwd|access[_-]?token|bearer)\b\s*[:=]\s*\S+/i`,
        String.raw `/AKIA[0-9A-Z]{16}/`,
        String.raw `/\b(gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9]{20,})\b/`,
        String.raw `/-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/`,
        String.raw `/\b[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)\s*=\s*\S{6,}/`,
    ],
    environment: [
        String.raw `/\b(?:ssh|scp|rsync)\s+[\w.-]+@/i`,
        String.raw `/\bsudo\b/i`,
        String.raw `/\bkubectl\b/i`,
        String.raw `/\bdocker\s+(?:push|-H|--host)\b/i`,
        String.raw `/\b(?:aws|gcloud|az)\s+\w+/i`,
        String.raw `/\bcurl\b[^\n]*\bhttps?:\/\/(?!localhost|127\.0\.0\.1)/i`,
    ],
};
export function compileRulePattern(entry: string): RegExp {
    const literal = /^\/(.+)\/([gimsuy]*)$/s.exec(entry.trim());
    if (literal)
        return new RegExp(literal[1] ?? "", literal[2] ?? "");
    return new RegExp(entry.trim());
}
export interface WorkerNetworkProbe {
    outbound: "open" | "restricted";
    inbound: "exposed" | "isolated";
    containerized: boolean;
    checkedAt: string;
}
export function readWorkerNetwork(snapshot: unknown): WorkerNetworkProbe | null {
    const n = (snapshot as {
        network?: unknown;
    } | null)?.network as Partial<WorkerNetworkProbe> | undefined;
    if (!n || (n.outbound !== "open" && n.outbound !== "restricted"))
        return null;
    return {
        outbound: n.outbound,
        inbound: n.inbound === "exposed" ? "exposed" : "isolated",
        containerized: n.containerized === true,
        checkedAt: typeof n.checkedAt === "string" ? n.checkedAt : "",
    };
}
export interface ProjectAiScopeSettings {
    restrictToFolder: boolean;
}
export const GIT_AUTH_METHODS = ["self", "deploy-key", "gitlab-group-token", "gitlab-service-account", "github-app"] as const;
export type GitAuthMethod = (typeof GIT_AUTH_METHODS)[number];
export function isGitLabMethod(method: GitAuthMethod | string | null | undefined): boolean {
    return method === "gitlab-group-token" || method === "gitlab-service-account";
}
export interface ProjectGitAuthSettings {
    method: GitAuthMethod;
}
export interface ProjectPackagesSettings {
    autoUpdate: boolean;
}
export const PROJECT_MEMORY_MODES = ["inherit", "on", "off"] as const;
export type ProjectMemoryMode = (typeof PROJECT_MEMORY_MODES)[number];
export interface ProjectMemorySettings {
    mode: ProjectMemoryMode;
    budgetChars: number;
}
export interface ProjectAiMemoryResponse {
    text: string;
    rev: number;
    updatedAt: string | null;
}
export interface ProjectSettings {
    tokens: ProjectTokenSettings;
    outboundReview: OutboundReviewSettings;
    memory: ProjectMemorySettings;
    templates: ProjectTemplateSelection;
    aiScope: ProjectAiScopeSettings;
    packages: ProjectPackagesSettings;
    gitAuth: ProjectGitAuthSettings;
    alerts: ProjectAlertRule[];
    mcp: {
        servers: McpApprovedServer[];
    };
    network: ProjectNetworkSettings;
    modes: ProjectModes;
}
export const DEFAULT_PROJECT_SETTINGS: ProjectSettings = {
    tokens: { sessionSwitchPct: 0, perPromptTokenLimit: 0, aiRunTimeoutSec: 0, autoClearIdleMinutes: 0 },
    memory: { mode: "inherit", budgetChars: 0 },
    templates: {},
    aiScope: { restrictToFolder: false },
    packages: { autoUpdate: false },
    gitAuth: { method: "self" },
    alerts: [],
    mcp: { servers: [] },
    network: { mode: DEFAULT_NETWORK_MODE, allow: defaultNetworkAllowRules(), deny: [], requireEnforcedWorker: false },
    modes: DEFAULT_PROJECT_MODES,
    outboundReview: {
        enabled: false,
        ruleCheck: false,
        aiReview: false,
        outboundLinkIds: [],
        outboundPoolIds: [],
        allowedRepos: [],
        blockImages: false,
        rules: DEFAULT_OUTBOUND_RULES,
    },
};
export const OUTBOUND_REVIEW_MAX_LIST = 50;
export const AI_RUN_TIMEOUT_BOUNDS = { min: 30, max: 3600 } as const;
export const AI_RESUME_BOUNDS = { maxIdleMinutes: 1440, maxContextTokens: 1000000 } as const;
export const TOOL_INSTALL_TIMEOUT_BOUNDS = { min: 60, max: 1800 } as const;
export const PROJECT_TOKEN_BOUNDS = {
    sessionSwitchPct: { min: 70, max: 90 },
    perPromptTokenLimit: { min: 1000, max: 2000000 },
    aiRunTimeoutSec: AI_RUN_TIMEOUT_BOUNDS,
    autoClearIdleMinutes: { min: 1, max: 1440 },
} as const;
export const PROJECT_MEMORY_BUDGET_BOUNDS = { min: 500, max: 50000 } as const;
function readTokenKnob(value: unknown, min: number, max: number): number {
    if (typeof value !== "number" || !Number.isFinite(value))
        return 0;
    if (value === 0)
        return 0;
    const v = Math.floor(value);
    return v >= min && v <= max ? v : 0;
}
export function readProjectSettings(settings: Record<string, unknown> | null | undefined): ProjectSettings {
    const tokens = (settings?.tokens ?? {}) as Partial<ProjectTokenSettings>;
    const review = (settings?.outboundReview ?? {}) as Partial<OutboundReviewSettings>;
    const B = PROJECT_TOKEN_BOUNDS;
    const d = DEFAULT_PROJECT_SETTINGS.outboundReview;
    const strList = (v: unknown): string[] => Array.isArray(v)
        ? v.filter((s): s is string => typeof s === "string").slice(0, OUTBOUND_REVIEW_MAX_LIST)
        : [];
    const ruleList = (v: unknown, fallback: string[]): string[] => {
        if (!Array.isArray(v))
            return fallback;
        return v
            .filter((s): s is string => typeof s === "string")
            .map((s) => s.trim())
            .filter(Boolean)
            .filter((s) => {
            try {
                compileRulePattern(s);
                return true;
            }
            catch {
                return false;
            }
        })
            .slice(0, OUTBOUND_REVIEW_MAX_LIST);
    };
    const rules = (review.rules ?? {}) as Partial<OutboundReviewRules>;
    const aiScope = (settings?.aiScope ?? {}) as Partial<ProjectAiScopeSettings>;
    const packages = (settings?.packages ?? {}) as Partial<ProjectPackagesSettings>;
    const gitAuth = (settings?.gitAuth ?? {}) as Partial<ProjectGitAuthSettings>;
    const rawTemplates = (settings?.templates ?? {}) as Record<string, unknown>;
    const templates: ProjectTemplateSelection = {};
    for (const kind of TEMPLATE_KINDS) {
        const v = rawTemplates[kind];
        if (typeof v === "string" && v)
            templates[kind] = v;
    }
    const memory = (settings?.memory ?? {}) as Partial<ProjectMemorySettings>;
    return {
        templates,
        alerts: readProjectAlertRules(settings),
        mcp: { servers: readMcpServers(settings?.mcp) },
        network: readProjectNetworkSettings(settings?.network),
        modes: readProjectModes(settings?.modes),
        memory: {
            mode: PROJECT_MEMORY_MODES.includes(memory.mode as ProjectMemoryMode)
                ? (memory.mode as ProjectMemoryMode)
                : DEFAULT_PROJECT_SETTINGS.memory.mode,
            budgetChars: readTokenKnob(memory.budgetChars, PROJECT_MEMORY_BUDGET_BOUNDS.min, PROJECT_MEMORY_BUDGET_BOUNDS.max),
        },
        aiScope: {
            restrictToFolder: typeof aiScope.restrictToFolder === "boolean"
                ? aiScope.restrictToFolder
                : DEFAULT_PROJECT_SETTINGS.aiScope.restrictToFolder,
        },
        packages: {
            autoUpdate: typeof packages.autoUpdate === "boolean"
                ? packages.autoUpdate
                : DEFAULT_PROJECT_SETTINGS.packages.autoUpdate,
        },
        gitAuth: {
            method: GIT_AUTH_METHODS.includes(gitAuth.method as GitAuthMethod)
                ? (gitAuth.method as GitAuthMethod)
                : DEFAULT_PROJECT_SETTINGS.gitAuth.method,
        },
        tokens: {
            sessionSwitchPct: readTokenKnob(tokens.sessionSwitchPct, B.sessionSwitchPct.min, B.sessionSwitchPct.max),
            perPromptTokenLimit: readTokenKnob(tokens.perPromptTokenLimit, B.perPromptTokenLimit.min, B.perPromptTokenLimit.max),
            aiRunTimeoutSec: readTokenKnob(tokens.aiRunTimeoutSec, B.aiRunTimeoutSec.min, B.aiRunTimeoutSec.max),
            autoClearIdleMinutes: readTokenKnob(tokens.autoClearIdleMinutes, B.autoClearIdleMinutes.min, B.autoClearIdleMinutes.max),
        },
        outboundReview: {
            enabled: typeof review.enabled === "boolean" ? review.enabled : d.enabled,
            ruleCheck: typeof review.ruleCheck === "boolean" ? review.ruleCheck : d.ruleCheck,
            aiReview: typeof review.aiReview === "boolean" ? review.aiReview : d.aiReview,
            blockImages: typeof review.blockImages === "boolean" ? review.blockImages : d.blockImages,
            outboundLinkIds: strList(review.outboundLinkIds),
            outboundPoolIds: strList(review.outboundPoolIds),
            allowedRepos: strList(review.allowedRepos),
            rules: {
                secret: ruleList(rules.secret, DEFAULT_OUTBOUND_RULES.secret),
                environment: ruleList(rules.environment, DEFAULT_OUTBOUND_RULES.environment),
            },
        },
    };
}
export const updateProjectRequestSchema = z.object({
    name: z.string().min(1).max(100).optional(),
    description: z.string().max(2000).optional(),
    ipAllowlist: ipAllowlistSchema.optional(),
    messengerRetentionDays: z.number().int().min(0).max(3650).optional(),
    groupPath: z.array(z.string().trim().min(1).max(60)).max(6).optional(),
    settings: z.record(z.string(), z.unknown()).optional(),
    specBasic: z
        .object({
        id: z.string().max(200),
        name: z.string().max(100),
        desc: z.string().max(2000),
    })
        .partial()
        .optional(),
});
export type UpdateProjectRequest = z.infer<typeof updateProjectRequestSchema>;
export const MEMO_MAX_LENGTH = 65536;
export interface ProjectMemoResponse {
    content: string | null;
    updatedAt: string | null;
}
export const putMemoRequestSchema = z.object({
    content: z.string().max(MEMO_MAX_LENGTH),
});
export type PutMemoRequest = z.infer<typeof putMemoRequestSchema>;
export const SPEC_VERSION = 5;
export const SPEC_DRAFT_MAX_BYTES = 1048576;
export const HTTP_JSON_BODY_LIMIT_BYTES = 2 * 1048576;
export interface SpecDraftResponse {
    spec: Record<string, unknown> | null;
    specVersion: number | null;
    updatedAt: string | null;
}
export interface SpecDraftSavedResponse {
    updatedAt: string;
}
export const putSpecDraftRequestSchema = z.object({
    spec: z.record(z.string(), z.unknown()),
    specVersion: z.number().int().positive().optional(),
});
export type PutSpecDraftRequest = z.infer<typeof putSpecDraftRequestSchema>;
export interface ProjectSpecResponse {
    spec: Record<string, unknown> | null;
    updatedAt: string | null;
}
export const putProjectSpecRequestSchema = z.object({
    spec: z.record(z.string(), z.unknown()),
});
export type PutProjectSpecRequest = z.infer<typeof putProjectSpecRequestSchema>;
export const TEMPLATE_ANALYSIS_MAX_BYTES = 512 * 1024;
export const TEMPLATE_UPDATE_MAX_BYTES = 512 * 1024;
export interface TemplateAnalysis {
    report: string;
    instruction: string | null;
    fromVersion: string | null;
    toVersion: string;
    savedAt: string;
    savedBy: string | null;
}
export type TemplateUpdateStatus = "success" | "warning" | "failed";
export type TemplatePullRequestState = "open" | "merged" | "closed";
export interface TemplateUpdateResult {
    output: string;
    status: TemplateUpdateStatus;
    pullRequestId: string | null;
    pullRequestUrl: string | null;
    branch: string | null;
    message: string | null;
    instruction: string | null;
    fromVersion: string | null;
    toVersion: string;
    savedAt: string;
    savedBy: string | null;
    pullRequestState?: TemplatePullRequestState | null;
    pullRequestCheckedAt?: string | null;
}
export interface TemplateUpdateParsed {
    status: TemplateUpdateStatus;
    pullRequestId: string | null;
    pullRequestUrl: string | null;
    branch: string | null;
    message: string | null;
}
function asTrimmedStr(v: unknown): string | null {
    if (typeof v === "string")
        return v.trim() || null;
    if (typeof v === "number" && Number.isFinite(v))
        return String(v);
    return null;
}
export function parseTemplateUpdateResult(out: string): TemplateUpdateParsed {
    const start = out.indexOf("{");
    const end = out.lastIndexOf("}");
    let obj: Record<string, unknown> | null = null;
    if (start >= 0 && end > start) {
        try {
            obj = JSON.parse(out.slice(start, end + 1)) as Record<string, unknown>;
        }
        catch {
            obj = null;
        }
    }
    if (!obj) {
        return { status: "warning", pullRequestId: null, pullRequestUrl: null, branch: null, message: null };
    }
    const pullRequestId = asTrimmedStr(obj.pullRequestId);
    const pullRequestUrl = asTrimmedStr(obj.pullRequestUrl);
    const branch = asTrimmedStr(obj.branch);
    const message = asTrimmedStr(obj.message);
    const reported = asTrimmedStr(obj.status);
    let status: TemplateUpdateStatus;
    if (reported === "success" && pullRequestId)
        status = "success";
    else if (reported === "failed")
        status = "failed";
    else
        status = "warning";
    return { status, pullRequestId, pullRequestUrl, branch, message };
}
export interface ProjectTemplateAnalysisResponse {
    analysis: TemplateAnalysis | null;
}
export interface ProjectTemplateUpdateResultResponse {
    update: TemplateUpdateResult | null;
}
export const putTemplateAnalysisRequestSchema = z.object({
    report: z.string().min(1),
    instruction: z.string().nullable(),
    fromVersion: z.string().nullable(),
    toVersion: z.string().min(1),
});
export type PutTemplateAnalysisRequest = z.infer<typeof putTemplateAnalysisRequestSchema>;
export const putTemplateUpdateRequestSchema = z.object({
    output: z.string().min(1),
    status: z.enum(["success", "warning", "failed"]),
    pullRequestId: z.string().nullable(),
    pullRequestUrl: z.string().nullable(),
    branch: z.string().nullable(),
    message: z.string().nullable(),
    instruction: z.string().nullable(),
    fromVersion: z.string().nullable(),
    toVersion: z.string().min(1),
});
export type PutTemplateUpdateRequest = z.infer<typeof putTemplateUpdateRequestSchema>;
export const ARTIFACT_MAX_BYTES = 512 * 1024;
export interface ProjectArtifactResponse {
    id: string;
    kind: string;
    docTypeId: string | null;
    docTypeVersion: number | null;
    templateFileId: string | null;
    templateVersion: number | null;
    params: Record<string, string> | null;
    runId: string | null;
    content: string;
    createdBy: string | null;
    createdAt: string;
}
export const listArtifactsQuerySchema = z.object({
    kind: z.string().max(40).optional(),
});
export type ListArtifactsQuery = z.infer<typeof listArtifactsQuerySchema>;
export const GIT_URL_RE = /^(https?:\/\/|git@[^\s:]+:|ssh:\/\/).+/i;
export const repoSpecSchema = z.object({
    role: z.string().max(60).optional().default(""),
    desc: z.string().max(500).optional().default(""),
    primary: z.boolean().optional().default(false),
    url: z.string().max(500).regex(GIT_URL_RE, "must be an https or ssh git url"),
    subdir: z.string().max(120).optional().default(""),
    branch: z.string().max(200).optional().default(""),
    base: z
        .object({
        kind: z.enum(["default", "branch", "empty"]),
        branch: z.string().max(200).optional(),
    })
        .optional(),
    resetTracking: z.boolean().optional(),
});
export type RepoSpec = z.infer<typeof repoSpecSchema>;
export const SCAFFOLD_TRACKING_FILES = ["AI_TODO.md", "AI_DONE.md", "AI_PROGRESS.md", "USER_TODO.md", "USER_QA.md"] as const;
export const repoProbeRequestSchema = z.object({
    url: z.string().max(500).regex(GIT_URL_RE, "must be an https or ssh git url"),
    branch: z.string().max(200).optional().default(""),
    base: z
        .object({ kind: z.enum(["default", "branch", "empty"]), branch: z.string().max(200).optional() })
        .optional(),
    submodules: z
        .array(z.object({ subdir: z.string().max(120), url: z.string().max(500), branch: z.string().max(200).optional().default("") }))
        .max(20)
        .optional(),
});
export type RepoProbeRequest = z.infer<typeof repoProbeRequestSchema>;
export interface RepoProbeResponse {
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
        spec: Record<string, unknown> | null;
        specError: string | null;
        settingsModel: string | null;
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
export function repoName(url: string): string {
    const last = (url || "").trim().replace(/\/+$/, "").split(/[/:]/).pop() ?? "";
    return last.replace(/\.git$/i, "");
}
export function repoSlug(url: string): string {
    const cleaned = (url || "").trim().replace(/\.git$/i, "").replace(/\/+$/, "");
    const afterHost = cleaned.includes("@") && cleaned.includes(":") && !cleaned.includes("://")
        ? cleaned.split(":").pop() ?? ""
        : cleaned.replace(/^[a-z]+:\/\//i, "").replace(/^[^/]+\//, "");
    const parts = afterHost.split("/").filter(Boolean);
    return parts.length >= 2 ? `${parts[parts.length - 2]}/${parts[parts.length - 1]}` : "";
}
export function repoProvider(url: string): "gh" | "glab" {
    const u = (url || "").toLowerCase();
    const host = u.startsWith("git@")
        ? u.slice(4).split(":")[0]
        : u.replace(/^[a-z]+:\/\//, "").replace(/^[^@/]+@/, "").split(/[/:]/)[0];
    return (host ?? "").includes("gitlab") ? "glab" : "gh";
}
export function validateProjectRepos(repos: readonly RepoSpec[] | undefined, ctx: z.RefinementCtx, path: (string | number)[] = ["repos"]): void {
    const list = repos ?? [];
    const issue = (message: string): void => ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
    if (list.length < 1) {
        issue("a project must declare at least one repo");
        return;
    }
    const primaries = list.filter((r) => r.primary);
    if (primaries.length !== 1) {
        issue("exactly one repo must be primary");
    }
    for (const r of list) {
        if (r.primary) {
            if ((r.subdir ?? "").trim() !== "")
                issue("the primary repo must be at the root (no subfolder)");
        }
        else if ((r.subdir ?? "").trim() === "") {
            issue("each submodule needs a folder path");
        }
    }
    const seenDir = new Set<string>();
    for (const r of list) {
        const dir = (r.subdir ?? "").trim().toLowerCase();
        if (!dir)
            continue;
        if (seenDir.has(dir))
            issue("submodule folder paths must be unique");
        seenDir.add(dir);
    }
    const seenUrl = new Set<string>();
    for (const r of list) {
        const url = (r.url ?? "").trim().toLowerCase();
        if (!url)
            continue;
        if (seenUrl.has(url))
            issue("repo URLs must be unique");
        seenUrl.add(url);
    }
}
export const specFieldEnvelopeSchema = z.object({
    id: z.string().min(1),
    name: z.string().optional().default(""),
    description: z.string().optional().default(""),
    type: z.string().optional().default("text"),
    options: z.array(z.string()).optional(),
    value: z.union([z.string(), z.array(z.string())]).optional().default(""),
});
export type SpecFieldEnvelope = z.infer<typeof specFieldEnvelopeSchema>;
export const subagentSpecSchema = z.object({
    name: z.string().max(120).optional().default(""),
    description: z.string().max(2000).optional().default(""),
});
export type SubagentSpec = z.infer<typeof subagentSpecSchema>;
export const projectSpecSchema = z
    .object({
    specVersion: z.number().int().positive(),
    fields: z.array(specFieldEnvelopeSchema),
    repos: z.array(repoSpecSchema).optional().default([]),
    subagents: z.array(subagentSpecSchema).optional().default([]),
    meta: z.record(z.string(), z.unknown()).optional(),
})
    .superRefine((v, ctx) => {
    const byId = new Map(v.fields.map((f) => [f.id, f.value]));
    for (const key of ["id", "name"] as const) {
        const val = byId.get(key);
        if (typeof val !== "string" || val.trim() === "") {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["fields"],
                message: `the "${key}" field is required`,
            });
        }
    }
    validateProjectRepos(v.repos, ctx);
});
export type ProjectSpec = z.infer<typeof projectSpecSchema>;
export const createFromSpecRequestSchema = z.object({
    projectId: z.string().guid(),
    spec: projectSpecSchema,
});
export type CreateFromSpecRequest = z.infer<typeof createFromSpecRequestSchema>;
export const addRepoRequestSchema = z
    .object({
    projectId: z.string().guid(),
    repos: z.array(repoSpecSchema).min(1),
    spec: projectSpecSchema,
})
    .superRefine((v, ctx) => {
    validateProjectRepos(v.repos, ctx);
});
export type AddRepoRequest = z.infer<typeof addRepoRequestSchema>;
const SUBMODULE_PATH_RE = /^(?!.*(?:^|\/)\.\.?(?:\/|$))[\w.-]+(?:\/[\w.-]+)*$/;
export const addSubmoduleRequestSchema = z.object({
    url: z.string().max(500).regex(GIT_URL_RE, "must be an https or ssh git url"),
    subdir: z
        .union([z.literal(""), z.string().max(120).regex(SUBMODULE_PATH_RE, "must be a relative folder path")])
        .optional()
        .default(""),
    branch: z.string().max(200).optional().default(""),
    desc: z.string().max(500).optional().default(""),
});
export type AddSubmoduleRequest = z.infer<typeof addSubmoduleRequestSchema>;
export const removeSubmoduleQuerySchema = z.object({
    path: z.string().min(1).max(120).regex(SUBMODULE_PATH_RE, "must be a relative folder path"),
});
export type RemoveSubmoduleQuery = z.infer<typeof removeSubmoduleQuerySchema>;
export const setPrimaryBranchRequestSchema = z.object({
    branch: z.string().trim().min(1).max(200),
});
export type SetPrimaryBranchRequest = z.infer<typeof setPrimaryBranchRequestSchema>;
export interface GitConfigJobResponse {
    jobId: string;
    gitAuthWarning?: string;
}
export interface ProjectJobAcceptedResponse {
    jobId: string;
    project: ProjectResponse;
}
