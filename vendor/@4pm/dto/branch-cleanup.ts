/**
 * Branch cleanup — the dead branches of a repo (merged, PR closed, task gone, stale), their deletion on the
 * remote + the workers, and the deletion log kept on the books branch (`.4pm/.autonomous.branch-deletions.json`)
 * so any worker can restore a branch while its commit still exists.
 * @adr 0540
 */
import { z } from "zod";

/** Why a branch looks dead. */
export const BRANCH_REASONS = ["merged", "pr-closed", "task-gone", "stale"] as const;
export type BranchReason = (typeof BRANCH_REASONS)[number];

/** A branch with no commit for this many days is `stale`. */
export const BRANCH_STALE_DAYS = 30;

/** The deletion log sidecar on the books branch. */
export const BRANCH_DELETIONS_REL = ".4pm/.autonomous.branch-deletions.json";

/** One cleanup candidate of a repo. */
export interface BranchCandidate {
  name: string;
  sha: string;
  /** `4pm` = an autonomous task branch (`dev/<base>/…`). */
  kind: "4pm" | "other";
  reasons: BranchReason[];
  /** ISO time of the head commit. */
  lastCommitAt: string;
  author: string;
  /** The branch's latest PR, when the host CLI knows one. */
  pr: { number: number; state: "open" | "merged" | "closed" } | null;
  /** Workers holding a local copy (filled by the server from the git snapshots). */
  workers?: string[];
}

/** One entry of the deletion log. */
export interface BranchDeletion {
  id: string;
  /** The repo's subdir ("" = the project root). */
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

/** The result of one branch in a delete. */
export interface BranchDeleteResult {
  name: string;
  outcome: "deleted" | "skipped" | "failed";
  /** Why it was skipped / failed (e.g. "no longer a candidate", "protected"). */
  detail?: string;
  /** Local copies kept on this worker (unpushed commits). */
  keptLocal?: boolean;
}

/** A repo subdir in a query / body ("" = the project root). */
const repoSchema = z.string().max(200).regex(/^$|^(?!\/)(?!.*\.\.)[A-Za-z0-9._/-]+$/).default("");

/** A branch name in a body (no option, no `..`). */
const branchNameSchema = z.string().regex(/^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/);

/** Query of machine-0092 / machine-0094. */
export const branchCleanupQuerySchema = z.object({ repo: repoSchema });
export type BranchCleanupQuery = z.infer<typeof branchCleanupQuerySchema>;

/** Body of machine-0093 — delete these branches (each re-checked by the worker first). */
export const branchDeleteSchema = z.object({ repo: repoSchema, names: z.array(branchNameSchema).min(1).max(100) });
export type BranchDeleteInput = z.infer<typeof branchDeleteSchema>;

/** Body of machine-0095 — restore one logged deletion. */
export const branchRestoreSchema = z.object({ repo: repoSchema, id: z.string().min(1).max(64) });
export type BranchRestoreInput = z.infer<typeof branchRestoreSchema>;

/** Project setting: the daily cleanup of 4PM branches (ADMIN / PM only). */
export interface BranchCleanupSettings {
  enabled: boolean;
  /** Only branches with no commit for this many days. */
  afterDays: number;
}

/** Defaults of {@link BranchCleanupSettings}. */
export const DEFAULT_BRANCH_CLEANUP: BranchCleanupSettings = { enabled: false, afterDays: 14 };
