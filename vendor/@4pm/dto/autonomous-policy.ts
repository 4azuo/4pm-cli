/**
 * Vendored from @4pm/dto (autonomous-policy.ts) by scripts/vendor-shared.mjs — do not edit.
 */
import { z } from "zod";
import { EVIDENCE_ROOT, MOCKUP_ROOT, isSafeRepoDir, type MachineAiRun } from "./machine";
import { ER_ROOT, SEQUENCE_ROOT } from "./er-model";
import { DIAGRAM_ROOT } from "./diagram-model";
import { DEFAULT_BRANCH_CLEANUP, type BranchCleanupSettings } from "./branch-cleanup";
export type HostPeopleMode = "auto" | "on" | "off";
export const HOST_PEOPLE_MODES = ["auto", "on", "off"] as const satisfies readonly HostPeopleMode[];
export interface GitAccountRef {
    provider: "github" | "gitlab";
    host: string;
    login: string;
    providerUserId: string;
}
export interface AutonomousTaskSizeHints {
    sMaxFiles: number;
    sMaxLines: number;
    mMaxFiles: number;
    mMaxLines: number;
}
export interface ProjectAutonomousSettings {
    claimTtlHours: number;
    claimCheckMinutes: number;
    maxTaskAttempts: number;
    runTimeoutMinutes: number;
    taskSizeHints: AutonomousTaskSizeHints;
    evidenceDir: string;
    mockupDir: string;
    erDir: string;
    sequenceDir: string;
    diagramDir: string;
    diagramAutoApprove: boolean;
    erAutoApprove: boolean;
    skipPullRequest: boolean;
    autoResolvePrConflicts: boolean;
    branchCleanup: BranchCleanupSettings;
    docsPhase: boolean;
    archiveAfterDays: number;
    booksSyncMinutes: number;
    autoMergeRequestPr: boolean;
    autoMergeBooksSync: boolean;
    autoVerifyBooks: boolean;
    autoVerifyDone: boolean;
    securityReview: boolean;
    evidencePhase: boolean;
    autoApprove: boolean;
    hostPeople: HostPeopleMode;
}
export const PROJECT_AUTONOMOUS_KEYS = [
    "claimTtlHours",
    "claimCheckMinutes",
    "maxTaskAttempts",
    "runTimeoutMinutes",
    "taskSizeHints",
    "evidenceDir",
    "mockupDir",
    "erDir",
    "sequenceDir",
    "diagramDir",
    "diagramAutoApprove",
    "erAutoApprove",
    "skipPullRequest",
    "autoResolvePrConflicts",
    "branchCleanup",
    "docsPhase",
    "archiveAfterDays",
    "booksSyncMinutes",
    "autoMergeRequestPr",
    "autoMergeBooksSync",
    "autoVerifyBooks",
    "autoVerifyDone",
    "securityReview",
    "evidencePhase",
    "autoApprove",
    "hostPeople",
] as const satisfies readonly (keyof ProjectAutonomousSettings)[];
export const MIN_AUTONOMOUS_RUN_TIMEOUT_MINUTES = 5;
export const DEFAULT_PROJECT_AUTONOMOUS_SETTINGS: ProjectAutonomousSettings = {
    claimTtlHours: 6,
    claimCheckMinutes: 10,
    maxTaskAttempts: 5,
    runTimeoutMinutes: 60,
    taskSizeHints: { sMaxFiles: 5, sMaxLines: 300, mMaxFiles: 20, mMaxLines: 1500 },
    evidenceDir: EVIDENCE_ROOT,
    mockupDir: MOCKUP_ROOT,
    erDir: ER_ROOT,
    sequenceDir: SEQUENCE_ROOT,
    diagramDir: DIAGRAM_ROOT,
    diagramAutoApprove: true,
    erAutoApprove: false,
    skipPullRequest: false,
    autoResolvePrConflicts: false,
    branchCleanup: DEFAULT_BRANCH_CLEANUP,
    docsPhase: true,
    archiveAfterDays: 30,
    booksSyncMinutes: 10,
    autoMergeRequestPr: false,
    autoMergeBooksSync: false,
    autoVerifyBooks: false,
    autoVerifyDone: false,
    securityReview: false,
    evidencePhase: true,
    autoApprove: false,
    hostPeople: "auto",
};
export function readProjectAutonomousSettings(raw: unknown): ProjectAutonomousSettings {
    const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const d = DEFAULT_PROJECT_AUTONOMOUS_SETTINGS;
    const num = (v: unknown, def: number): number => (typeof v === "number" && Number.isFinite(v) ? v : def);
    const dir = (v: unknown, def: string): string => {
        const t = typeof v === "string" ? v.trim().replace(/\/+$/, "") : "";
        return t && isSafeRepoDir(t) ? t : def;
    };
    const bool = (v: unknown, def: boolean): boolean => (typeof v === "boolean" ? v : def);
    const claimTtlHours = Math.max(1, num(o.claimTtlHours, d.claimTtlHours));
    const h = (o.taskSizeHints && typeof o.taskSizeHints === "object" ? o.taskSizeHints : {}) as Record<string, unknown>;
    return {
        claimTtlHours,
        claimCheckMinutes: Math.max(1, num(o.claimCheckMinutes, d.claimCheckMinutes)),
        maxTaskAttempts: Math.max(1, num(o.maxTaskAttempts, d.maxTaskAttempts)),
        runTimeoutMinutes: Math.min(claimTtlHours * 60, Math.max(MIN_AUTONOMOUS_RUN_TIMEOUT_MINUTES, num(o.runTimeoutMinutes, d.runTimeoutMinutes))),
        taskSizeHints: {
            sMaxFiles: num(h.sMaxFiles, d.taskSizeHints.sMaxFiles),
            sMaxLines: num(h.sMaxLines, d.taskSizeHints.sMaxLines),
            mMaxFiles: num(h.mMaxFiles, d.taskSizeHints.mMaxFiles),
            mMaxLines: num(h.mMaxLines, d.taskSizeHints.mMaxLines),
        },
        evidenceDir: dir(o.evidenceDir, d.evidenceDir),
        mockupDir: dir(o.mockupDir, d.mockupDir),
        erDir: dir(o.erDir, d.erDir),
        sequenceDir: dir(o.sequenceDir, d.sequenceDir),
        diagramDir: dir(o.diagramDir, d.diagramDir),
        diagramAutoApprove: typeof o.diagramAutoApprove === "boolean" ? o.diagramAutoApprove : d.diagramAutoApprove,
        erAutoApprove: typeof o.erAutoApprove === "boolean" ? o.erAutoApprove : d.erAutoApprove,
        skipPullRequest: typeof o.skipPullRequest === "boolean" ? o.skipPullRequest : d.skipPullRequest,
        autoResolvePrConflicts: typeof o.autoResolvePrConflicts === "boolean" ? o.autoResolvePrConflicts : d.autoResolvePrConflicts,
        branchCleanup: (() => {
            const b = (o.branchCleanup && typeof o.branchCleanup === "object" ? o.branchCleanup : {}) as Record<string, unknown>;
            return {
                enabled: typeof b.enabled === "boolean" ? b.enabled : d.branchCleanup.enabled,
                afterDays: Math.min(365, Math.max(1, num(b.afterDays, d.branchCleanup.afterDays))),
            };
        })(),
        docsPhase: typeof o.docsPhase === "boolean" ? o.docsPhase : d.docsPhase,
        archiveAfterDays: Math.min(3650, Math.max(1, Math.floor(num(o.archiveAfterDays, d.archiveAfterDays)))),
        booksSyncMinutes: Math.min(1440, Math.max(1, Math.floor(num(o.booksSyncMinutes, d.booksSyncMinutes)))),
        autoMergeRequestPr: bool(o.autoMergeRequestPr, d.autoMergeRequestPr),
        autoMergeBooksSync: bool(o.autoMergeBooksSync, d.autoMergeBooksSync),
        autoVerifyBooks: bool(o.autoVerifyBooks, d.autoVerifyBooks),
        autoVerifyDone: bool(o.autoVerifyDone, d.autoVerifyDone),
        securityReview: bool(o.securityReview, d.securityReview),
        evidencePhase: bool(o.evidencePhase, d.evidencePhase),
        autoApprove: bool(o.autoApprove, d.autoApprove),
        hostPeople: (HOST_PEOPLE_MODES as readonly unknown[]).includes(o.hostPeople) ? (o.hostPeople as HostPeopleMode) : d.hostPeople,
    };
}
export interface ProjectAutonomous {
    enabled: boolean;
    enforceAutonomousPath: boolean;
    settings: ProjectAutonomousSettings;
    seeded: boolean;
}
export function readProjectAutonomous(raw: unknown): ProjectAutonomous {
    const o = (raw && typeof raw === "object" ? raw : null) as Record<string, unknown> | null;
    return {
        enabled: o?.enabled === true,
        enforceAutonomousPath: o?.enforceAutonomousPath !== false,
        settings: readProjectAutonomousSettings(o?.settings),
        seeded: o !== null,
    };
}
export type AutonomousPolicyReason = "projectDisabled" | "projectPaused" | "projectClosed" | "projectNotReady" | "userPaused" | "memberInactive" | "physicDisabled" | "physicNotReady" | "notAssigned" | "templateUpdateRequired";
export interface AutonomousPolicy {
    projectEnabled: boolean;
    allowed: boolean;
    reason?: AutonomousPolicyReason;
    settings: ProjectAutonomousSettings;
    assetProviders?: string[];
    gitAccounts?: Record<string, GitAccountRef[]>;
    pmUserIds?: string[];
}
export type AutonomousPausedBy = "user" | "auto" | "projectDeleted" | "migration";
export interface AutonomousCheckDetail {
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
export interface AutonomousLastCheck {
    at: string;
    outcome: "run" | "skip" | "error" | "running";
    reason: string;
    detail?: AutonomousCheckDetail;
}
export interface AutonomousStep {
    kind: "cycle" | "intake" | "implement" | "docs" | "deliver";
    ids: string[];
    since: string;
}
export interface AutonomousWorkerSnapshot {
    enabled: boolean;
    effective: boolean;
    pausedBy?: AutonomousPausedBy;
    pausedReason?: string;
    pausedAt?: string;
    lastCheck?: AutonomousLastCheck | null;
    claim?: {
        id: string;
        since: string;
    } | null;
    step?: AutonomousStep | null;
    consecutiveFails: number;
}
export interface ProjectAutonomousWorker {
    machineLinkId: string;
    userId: string;
    machineUsername: string;
    teams: string[] | null;
    online: boolean;
    lifecycle: "connected" | "draining" | null;
    enabled: boolean;
    allowed: boolean;
    allowedReason: AutonomousPolicyReason | null;
    effective: boolean;
    pausedBy: AutonomousPausedBy | null;
    pausedReason: string | null;
    pausedAt: string | null;
    lastCheck: AutonomousLastCheck | null;
    claim: {
        id: string;
        since: string;
    } | null;
    step: AutonomousStep | null;
    consecutiveFails: number;
    aiRuns?: MachineAiRun[];
}
export interface ProjectAutonomousWorkersResponse {
    enabled: boolean;
    enforceAutonomousPath: boolean;
    ready: boolean;
    suspended: null | "projectPaused" | "projectClosed" | "projectNotReady";
    settings: ProjectAutonomousSettings;
    workers: ProjectAutonomousWorker[];
}
export const projectAutonomousPolicyWriteSchema = z
    .object({
    enabled: z.boolean().optional(),
    enforceAutonomousPath: z.boolean().optional(),
    settings: z
        .object({
        claimTtlHours: z.number().int().min(1).max(168).optional(),
        claimCheckMinutes: z.number().int().min(1).max(240).optional(),
        maxTaskAttempts: z.number().int().min(1).max(50).optional(),
        runTimeoutMinutes: z.number().int().min(MIN_AUTONOMOUS_RUN_TIMEOUT_MINUTES).max(10080).optional(),
        taskSizeHints: z
            .object({
            sMaxFiles: z.number().int().min(1).max(10000),
            sMaxLines: z.number().int().min(1).max(1000000),
            mMaxFiles: z.number().int().min(1).max(10000),
            mMaxLines: z.number().int().min(1).max(1000000),
        })
            .optional(),
        evidenceDir: z.string().max(200).refine(isSafeRepoDir).optional(),
        mockupDir: z.string().max(200).refine(isSafeRepoDir).optional(),
        erDir: z.string().max(200).refine(isSafeRepoDir).optional(),
        sequenceDir: z.string().max(200).refine(isSafeRepoDir).optional(),
        diagramDir: z.string().max(200).refine(isSafeRepoDir).optional(),
        diagramAutoApprove: z.boolean().optional(),
        erAutoApprove: z.boolean().optional(),
        skipPullRequest: z.boolean().optional(),
        autoResolvePrConflicts: z.boolean().optional(),
        branchCleanup: z.object({ enabled: z.boolean(), afterDays: z.number().int().min(1).max(365) }).optional(),
        docsPhase: z.boolean().optional(),
        archiveAfterDays: z.number().int().min(1).max(3650).optional(),
        booksSyncMinutes: z.number().int().min(1).max(1440).optional(),
        autoMergeRequestPr: z.boolean().optional(),
        autoMergeBooksSync: z.boolean().optional(),
        autoVerifyBooks: z.boolean().optional(),
        autoVerifyDone: z.boolean().optional(),
        securityReview: z.boolean().optional(),
        evidencePhase: z.boolean().optional(),
        autoApprove: z.boolean().optional(),
        hostPeople: z.enum(HOST_PEOPLE_MODES).optional(),
    })
        .strict()
        .optional(),
})
    .strict()
    .refine((b) => b.enabled !== undefined || b.enforceAutonomousPath !== undefined || b.settings !== undefined, {
    message: "enabled, enforceAutonomousPath or settings is required",
});
export type ProjectAutonomousPolicyWriteBody = z.infer<typeof projectAutonomousPolicyWriteSchema>;
