/**
 * Autonomous authority for many workers: the project switch + the project-scoped knobs every worker
 * must share (claim TTL / check, attempts, run timeout, size hints, repo folders — stored on the server
 * in `projects.settings.autonomous`), the server's per-worker `allowed` verdict pushed to each cli as the
 * autonomous policy, and the worker snapshot each cli reports back (`machine.status.autonomous`).
 * `effective = projectEnabled ∧ allowed ∧ worker enabled`. The section also holds the switch that sends
 * every change of a ready project through autonomous (`enforceAutonomousPath`).
 * @adr 0507 @adr 0511 @adr 0563 @adr 0671
 */
import { z } from "zod";
import { EVIDENCE_ROOT, MOCKUP_ROOT, isSafeRepoDir, type MachineAiRun } from "./machine";
import { ER_ROOT, SEQUENCE_ROOT } from "./er-model";
import { DIAGRAM_ROOT } from "./diagram-model";
import { DEFAULT_BRANCH_CLEANUP, type BranchCleanupSettings } from "./branch-cleanup";

/** Whether the cli names people on the host (co-authors, PR assignees / reviewers): `auto` = private repos only. @adr 0671 */
export type HostPeopleMode = "auto" | "on" | "off";
export const HOST_PEOPLE_MODES = ["auto", "on", "off"] as const satisfies readonly HostPeopleMode[];

/** One member's verified GitHub / GitLab account, as the cli needs it for trailers and PR people. @adr 0671 */
export interface GitAccountRef {
  provider: "github" | "gitlab";
  host: string;
  login: string;
  /** The host's numeric user id (builds the noreply e-mail). */
  providerUserId: string;
}

/** S/M task size hints for intake (indicative, not caps). */
export interface AutonomousTaskSizeHints {
  sMaxFiles: number;
  sMaxLines: number;
  mMaxFiles: number;
  mMaxLines: number;
}

/** The knobs every worker of a project must share. */
export interface ProjectAutonomousSettings {
  /** A claim lives this long from `Started`; older ⇒ released / taken over. */
  claimTtlHours: number;
  /** How often the holder re-verifies its claim during a run. */
  claimCheckMinutes: number;
  /** A task failing this many times is split. */
  maxTaskAttempts: number;
  /** Wall-clock cap of each AI run of a cycle, clamped to [5, claimTtlHours × 60]. */
  runTimeoutMinutes: number;
  taskSizeHints: AutonomousTaskSizeHints;
  /** Repo-relative folders committed with the books. */
  evidenceDir: string;
  mockupDir: string;
  erDir: string;
  sequenceDir: string;
  /** The draw.io system-diagram folder. @adr 0530 */
  diagramDir: string;
  /** Apply a new / revised system-diagram change request without a person (default on). @adr 0530 */
  diagramAutoApprove: boolean;
  /** Apply a new / revised ER change request without a person (default off). @adr 0530 */
  erAutoApprove: boolean;
  /**
   * Deliver a finished task by merging it (`--no-ff`) straight into `<base>` instead of opening a PR (default off;
   * only ADMIN / PM may change it). A failed merge falls back to a PR. @adr 0539
   */
  skipPullRequest: boolean;
  /** Each cycle first lets the AI resolve one conflicting PR of a 4PM task branch (default off). @adr 0539 */
  autoResolvePrConflicts: boolean;
  /** Daily cleanup of dead 4PM task branches (default off; only ADMIN / PM may change it). @adr 0540 */
  branchCleanup: BranchCleanupSettings;
  /**
   * The DOC phase: intake adds one `DOC-…` row per request that its tasks wait for, reviewed in rounds before
   * implement (default on; it runs only when the spec declares `docs_types`). @adr 0536
   */
  docsPhase: boolean;
  /** A `Done` request stays in the live books this many days before the archive moves it (1–3650, default 30). */
  archiveAfterDays: number;
  /** The books-sync PR into `<base>` is refreshed at most this often (minutes, 1–1440, default 10). */
  booksSyncMinutes: number;
  /** Merge the intake request PR (mockups / sequences) once pushed (Delivery · Auto, default off). @adr 0608 */
  autoMergeRequestPr: boolean;
  /** Merge the books-sync PR when refreshed (Delivery · Auto, default off). @adr 0608 */
  autoMergeBooksSync: boolean;
  /** Run the book-logic AI Verify on the rows an intake just published (Full power, default off). @adr 0608 */
  autoVerifyBooks: boolean;
  /** Run the done-verify on a row that just reached AI_DONE (Full power, default off). @adr 0608 */
  autoVerifyDone: boolean;
  /** Security review of each task's diff before delivery; a high / critical finding fails the attempt (default off). @adr 0608 */
  securityReview: boolean;
  /** Intake / implement write mockups, sequences, ER / diagram change requests and task evidence (default on). @adr 0608 */
  evidencePhase: boolean;
  /** New requests and intake rows are approved by the server as `auto`; AST rounds auto-accept (default off). @adr 0608 */
  autoApprove: boolean;
  /** Name people on the host — co-author trailers, PR assignees / reviewers (default `auto`; ADMIN / PM only). @adr 0671 */
  hostPeople: HostPeopleMode;
}

/** The project-scoped keys (a worker settings write carrying one is refused). */
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

/** Lower bound of `runTimeoutMinutes`. */
export const MIN_AUTONOMOUS_RUN_TIMEOUT_MINUTES = 5;

/** Defaults of the project-scoped knobs. */
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

/** Coerce an unknown object into full project-scoped settings (missing / invalid ⇒ default). */
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

/** The project's autonomous section (`projects.settings.autonomous`). */
export interface ProjectAutonomous {
  /** The project switch — Start all / Pause all. */
  enabled: boolean;
  /** While the project is ready, direct write dispatches are refused (default on). */
  enforceAutonomousPath: boolean;
  settings: ProjectAutonomousSettings;
  /** False until the section was first written (migration seeds it from the first reporting worker). */
  seeded: boolean;
}

/** Read the stored section; absent ⇒ off, enforced path, defaults, `seeded:false`. */
export function readProjectAutonomous(raw: unknown): ProjectAutonomous {
  const o = (raw && typeof raw === "object" ? raw : null) as Record<string, unknown> | null;
  return {
    enabled: o?.enabled === true,
    enforceAutonomousPath: o?.enforceAutonomousPath !== false,
    settings: readProjectAutonomousSettings(o?.settings),
    seeded: o !== null,
  };
}

/** Why the server does not allow a worker to run cycles. */
export type AutonomousPolicyReason =
  | "projectDisabled"
  | "projectPaused"
  | "projectClosed"
  | "projectNotReady"
  | "userPaused"
  | "memberInactive"
  | "physicDisabled"
  | "physicNotReady"
  | "notAssigned"
  /** A required project-template update is not merged into `<base>` yet — a soft gate. @adr 0550 */
  | "templateUpdateRequired";

/** The policy the server pushes to one serving cli (`ws_token.autonomousPolicy` + `autonomous.policy`). */
export interface AutonomousPolicy {
  /** The project switch. */
  projectEnabled: boolean;
  /** The server's verdict for this worker: assigned, project READY, member + user active, physic active. */
  allowed: boolean;
  /** Why the worker may not run (the first failing condition, project switch included). */
  reason?: AutonomousPolicyReason;
  settings: ProjectAutonomousSettings;
  /** Generator providers the project may use for its assets (org-connected and project-enabled). @adr 0615 */
  assetProviders?: string[];
  /**
   * The project members' verified git accounts by user id (no CLIENT / MACHINE) — the cli keeps it in memory only.
   * @adr 0671
   */
  gitAccounts?: Record<string, GitAccountRef[]>;
  /** The project's PMs — the reviewers of a PR whose row has no human approver. @adr 0671 */
  pmUserIds?: string[];
}

/** Who / what paused a worker. */
export type AutonomousPausedBy = "user" | "auto" | "projectDeleted" | "migration";

/** What a cycle did / waits for, attached to its `lastCheck`. @adr 0529 */
export interface AutonomousCheckDetail {
  /** What an intake of this cycle produced. */
  intake?: { tasks: number; questions: number; changeRequests: number };
  /** Rows waiting on people (served teams only): to approve, blocking ER change requests, unanswered questions, unfinished dependencies. */
  /** `blocked` = approved tasks blocked by a merge conflict with their base, waiting for a Retry. @adr 0539 */
  /** `merge` = rows waiting for their request / DOC PR to merge into `<base>`. @adr 0563 */
  waiting?: { approval: number; changeRequests: number; answers: number; dependencies: number; blocked?: number; merge?: number };
  /** The task this cycle worked on. */
  taskId?: string;
  /** The worker holding the intake ids (`intake taken`). */
  by?: string;
  /**
   * The books whose monthly new-row limit of the subscription is reached — intake is skipped until the reset or an
   * upgrade. @adr 0541
   */
  capReached?: ("USER_TODO" | "USER_QA" | "AI_TODO")[];
}

/** The last tick of a worker (skips included); `running` = a cycle started at `at` and has not ended yet. */
export interface AutonomousLastCheck {
  at: string;
  outcome: "run" | "skip" | "error" | "running";
  reason: string;
  /** @adr 0529 */
  detail?: AutonomousCheckDetail;
}

/**
 * What a worker's running cycle does right now: git / gate phases, the intake agent, the implement agent, the
 * docs agent of a `DOC-…` round, or delivering the finished task (push / PR — it can no longer be stopped by an
 * unapprove).
 * @adr 0529 @adr 0538 @adr 0536
 */
export interface AutonomousStep {
  kind: "cycle" | "intake" | "implement" | "docs" | "deliver";
  /** The `REQ-…` / `QA-…` being taken in, or the `TSK-…` / `DOC-…` being worked on. */
  ids: string[];
  since: string;
}

/** The autonomous summary a cli reports in `machine.status.autonomous`. */
export interface AutonomousWorkerSnapshot {
  /** The worker switch (`!paused`). */
  enabled: boolean;
  /** `projectEnabled ∧ allowed ∧ enabled` as the cli last saw it. */
  effective: boolean;
  pausedBy?: AutonomousPausedBy;
  pausedReason?: string;
  pausedAt?: string;
  lastCheck?: AutonomousLastCheck | null;
  claim?: { id: string; since: string } | null;
  /** @adr 0529 */
  step?: AutonomousStep | null;
  consecutiveFails: number;
}

/** One worker row of project-0124. */
export interface ProjectAutonomousWorker {
  machineLinkId: string;
  userId: string;
  machineUsername: string;
  /** Served team codes; null = all. */
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
  claim: { id: string; since: string } | null;
  /** The running cycle's step (null = no cycle running / an older cli). @adr 0529 */
  step: AutonomousStep | null;
  consecutiveFails: number;
  /** The AI attempts the worker runs right now (live; `[]` = idle). @adr 0522 */
  aiRuns?: MachineAiRun[];
}

/** Data GET /projects/:id/autonomous/workers. @api project-0124 */
export interface ProjectAutonomousWorkersResponse {
  enabled: boolean;
  /** Direct write dispatches are refused while the project is ready. */
  enforceAutonomousPath: boolean;
  /** The project is ready (autonomous may run; the enforced path applies). */
  ready: boolean;
  suspended: null | "projectPaused" | "projectClosed" | "projectNotReady";
  settings: ProjectAutonomousSettings;
  workers: ProjectAutonomousWorker[];
}

/** Body PUT /projects/:id/autonomous/policy. @api project-0125 */
export const projectAutonomousPolicyWriteSchema = z
  .object({
    enabled: z.boolean().optional(),
    enforceAutonomousPath: z.boolean().optional(),
    settings: z
      .object({
        claimTtlHours: z.number().int().min(1).max(168).optional(),
        claimCheckMinutes: z.number().int().min(1).max(240).optional(),
        maxTaskAttempts: z.number().int().min(1).max(50).optional(),
        runTimeoutMinutes: z.number().int().min(MIN_AUTONOMOUS_RUN_TIMEOUT_MINUTES).max(10_080).optional(),
        taskSizeHints: z
          .object({
            sMaxFiles: z.number().int().min(1).max(10_000),
            sMaxLines: z.number().int().min(1).max(1_000_000),
            mMaxFiles: z.number().int().min(1).max(10_000),
            mMaxLines: z.number().int().min(1).max(1_000_000),
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

/** Body PUT /projects/:id/autonomous/policy. */
export type ProjectAutonomousPolicyWriteBody = z.infer<typeof projectAutonomousPolicyWriteSchema>;
