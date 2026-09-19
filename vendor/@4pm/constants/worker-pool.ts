/**
 * Worker-pool & AI-job constants (ADR-0284). A worker pool is a named group of MACHINE users
 * given a duty; each AI feature of a project is an `AiJob` that dispatch routes to a pool/machine.
 */

/**
 * The 13 AI functions inside a project — the "job" a pool/machine can be dedicated to. The caller
 * stamps the job on an AI dispatch (the end user never picks it); routing orders candidates by it
 * (ADR-0284). Values are stable wire strings (do not rename once shipped).
 */
export const AiJob = {
  /** Spec field/section/subagent suggest (one-shot). */
  SPEC_SUGGEST: "spec-suggest",
  /** Spec review — advisory (one-shot). */
  SPEC_REVIEW: "spec-review",
  /** Spec compose + create verdict (one-shot). */
  SPEC_COMPOSE: "spec-compose",
  /** Generators: WBS/est/proposal/feasibility/report (one-shot). */
  DOC_GENERATE: "doc-generate",
  /** Console prompt — full agent. */
  CONSOLE_AGENT: "console-agent",
  /** Git merge / AI conflict resolve — full agent. */
  GIT_MERGE: "git-merge",
  /** Graph add-link/add-code/delete-unused advice (one-shot). */
  GRAPH_SUGGEST: "graph-suggest",
  /** Subagent/skill content generate (one-shot). */
  AGENTS_GENERATE: "agents-generate",
  /** Template "Analyze impact" report — read-only agent. */
  ANALYZE_IMPACT: "analyze-impact",
  /** Template "Update" → branch + PR — write-capable agent. */
  TEMPLATE_UPDATE: "template-update",
  /** Autonomous-mode self-spawn — full agent. */
  AUTONOMOUS: "autonomous",
  /** Memo → community post compose (vision) — full agent. */
  MEMO_COMPOSE: "memo-compose",
  /** Outbound input review — the reviewer cli (one-shot). */
  OUTBOUND_REVIEW: "outbound-review",
} as const;

/** Union type of AI jobs (the wire value). */
export type AiJob = (typeof AiJob)[keyof typeof AiJob];

/** All AI-job values, in taxonomy order — for validation + UI enumeration. */
export const AI_JOBS: readonly AiJob[] = Object.values(AiJob);

/** True when a value is a known `AiJob`. */
export function isAiJob(value: unknown): value is AiJob {
  return typeof value === "string" && (AI_JOBS as readonly string[]).includes(value);
}

/** A project's AI-routing entry kind — a worker pool or a lone MACHINE user (ADR-0284). */
export const WorkerRoutingEntryKind = {
  POOL: "pool",
  MACHINE: "machine",
} as const;

/** Union type of routing-entry kinds. */
export type WorkerRoutingEntryKind =
  (typeof WorkerRoutingEntryKind)[keyof typeof WorkerRoutingEntryKind];
