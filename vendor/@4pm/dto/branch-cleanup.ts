/**
 * Vendored from @4pm/dto (branch-cleanup.ts) by scripts/vendor-shared.mjs — do not edit.
 */
import { z } from "zod";
export const BRANCH_REASONS = ["merged", "pr-closed", "task-gone", "stale"] as const;
export type BranchReason = (typeof BRANCH_REASONS)[number];
export const BRANCH_STALE_DAYS = 30;
export const BRANCH_DELETIONS_REL = ".4pm/.autonomous.branch-deletions.json";
export interface BranchCandidate {
    name: string;
    sha: string;
    kind: "4pm" | "other";
    reasons: BranchReason[];
    lastCommitAt: string;
    author: string;
    pr: {
        number: number;
        state: "open" | "merged" | "closed";
    } | null;
    workers?: string[];
}
export interface BranchDeletion {
    id: string;
    repo: string;
    name: string;
    sha: string;
    reasons: BranchReason[];
    mode: "manual" | "auto";
    by?: string;
    byLabel?: string;
    at: string;
    restoredAt?: string;
}
export interface BranchDeleteResult {
    name: string;
    outcome: "deleted" | "skipped" | "failed";
    detail?: string;
    keptLocal?: boolean;
}
const repoSchema = z.string().max(200).regex(/^$|^(?!\/)(?!.*\.\.)[A-Za-z0-9._/-]+$/).default("");
const branchNameSchema = z.string().regex(/^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/);
export const branchCleanupQuerySchema = z.object({ repo: repoSchema });
export type BranchCleanupQuery = z.infer<typeof branchCleanupQuerySchema>;
export const branchDeleteSchema = z.object({ repo: repoSchema, names: z.array(branchNameSchema).min(1).max(100) });
export type BranchDeleteInput = z.infer<typeof branchDeleteSchema>;
export const branchRestoreSchema = z.object({ repo: repoSchema, id: z.string().min(1).max(64) });
export type BranchRestoreInput = z.infer<typeof branchRestoreSchema>;
export interface BranchCleanupSettings {
    enabled: boolean;
    afterDays: number;
}
export const DEFAULT_BRANCH_CLEANUP: BranchCleanupSettings = { enabled: false, afterDays: 14 };
