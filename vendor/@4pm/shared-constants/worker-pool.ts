/**
 * Vendored from @4pm/shared-constants (worker-pool.ts) by scripts/vendor-shared.mjs — do not edit.
 */
export const AiJob = {
    SPEC_SUGGEST: "spec-suggest",
    SPEC_REVIEW: "spec-review",
    SPEC_COMPOSE: "spec-compose",
    DOC_GENERATE: "doc-generate",
    CONSOLE_AGENT: "console-agent",
    GIT_MERGE: "git-merge",
    GRAPH_SUGGEST: "graph-suggest",
    DOC_FIND: "doc-find",
    ER_DRAFT: "er-draft",
    DIAGRAM_DRAFT: "diagram-draft",
    FLOW_MAP: "flow-map",
    FLOW_MAP_UPDATE: "flow-map-update",
    CI_GENERATE: "ci-generate",
    MARKETING_SCENES_COMPOSE: "marketing-scenes-compose",
    MARKETING_PHOTOS_GENERATE: "marketing-photos-generate",
    MARKETING_VIDEO_COMPOSE: "marketing-video-compose",
    MARKETING_VIDEO_GENERATE: "marketing-video-generate",
    AGENTS_GENERATE: "agents-generate",
    ANALYZE_IMPACT: "analyze-impact",
    TEMPLATE_UPDATE: "template-update",
    AUTONOMOUS: "autonomous",
    MEMO_COMPOSE: "memo-compose",
    OUTBOUND_REVIEW: "outbound-review",
} as const;
export type AiJob = (typeof AiJob)[keyof typeof AiJob];
export const AI_JOBS: readonly AiJob[] = Object.values(AiJob);
export function isAiJob(value: unknown): value is AiJob {
    return typeof value === "string" && (AI_JOBS as readonly string[]).includes(value);
}
export const WorkerRoutingEntryKind = {
    POOL: "pool",
    MACHINE: "machine",
} as const;
export type WorkerRoutingEntryKind = (typeof WorkerRoutingEntryKind)[keyof typeof WorkerRoutingEntryKind];
