/**
 * Autonomous authority for many workers: the project switch + the project-scoped knobs every worker
 * must share (claim TTL / check, attempts, run timeout, size hints, repo folders — stored on the server
 * in `projects.settings.autonomous`), the server's per-worker `allowed` verdict pushed to each cli as the
 * autonomous policy, and the worker snapshot each cli reports back (`machine.status.autonomous`).
 * `effective = projectEnabled ∧ allowed ∧ worker enabled`. The section also holds the switch that sends
 * every change of a ready project through autonomous (`enforceAutonomousPath`).
 * @adr 0507 @adr 0511
 */
import { z } from "zod";
import { EVIDENCE_ROOT, MOCKUP_ROOT, isSafeRepoDir, type MachineAiRun } from "./machine";
import { ER_ROOT, SEQUENCE_ROOT } from "./er-model";
import { DIAGRAM_ROOT } from "./diagram-model";

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
  | "notAssigned";

/** The policy the server pushes to one serving cli (`ws_token.autonomousPolicy` + `autonomous.policy`). */
export interface AutonomousPolicy {
  /** The project switch. */
  projectEnabled: boolean;
  /** The server's verdict for this worker: assigned, project READY, member + user active, physic active. */
  allowed: boolean;
  /** Why the worker may not run (the first failing condition, project switch included). */
  reason?: AutonomousPolicyReason;
  settings: ProjectAutonomousSettings;
}

/** Who / what paused a worker. */
export type AutonomousPausedBy = "user" | "auto" | "projectDeleted" | "migration";

/** What a cycle did / waits for, attached to its `lastCheck`. @adr 0529 */
export interface AutonomousCheckDetail {
  /** What an intake of this cycle produced. */
  intake?: { tasks: number; questions: number; changeRequests: number };
  /** Rows waiting on people (served teams only): to approve, blocking ER change requests, unanswered questions, unfinished dependencies. */
  waiting?: { approval: number; changeRequests: number; answers: number; dependencies: number };
  /** The task this cycle worked on. */
  taskId?: string;
  /** The worker holding the intake ids (`intake taken`). */
  by?: string;
}

/** The last tick of a worker (skips included). */
export interface AutonomousLastCheck {
  at: string;
  outcome: "run" | "skip" | "error";
  reason: string;
  /** @adr 0529 */
  detail?: AutonomousCheckDetail;
}

/**
 * What a worker's running cycle does right now: git / gate phases, the intake agent, the implement agent, or
 * delivering the finished task (push / PR — it can no longer be stopped by an unapprove).
 * @adr 0529 @adr 0538
 */
export interface AutonomousStep {
  kind: "cycle" | "intake" | "implement" | "deliver";
  /** The `REQ-…` / `QA-…` being taken in, or the `TSK-…` being implemented. */
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
