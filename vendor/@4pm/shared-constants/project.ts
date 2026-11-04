/**
 * Vendored from @4pm/shared-constants (project.ts) by scripts/vendor-shared.mjs — do not edit.
 */
export const ProjectStatus = {
    DRAFT: "draft",
    CREATING: "creating",
    READY: "ready",
    FAILED: "failed",
    PAUSED: "paused",
    CLOSED: "closed",
} as const;
export type ProjectStatus = (typeof ProjectStatus)[keyof typeof ProjectStatus];
export const ProjectLifecycleAction = {
    PAUSE: "pause",
    RESUME: "resume",
    CLOSE: "close",
    REOPEN: "reopen",
} as const;
export type ProjectLifecycleAction = (typeof ProjectLifecycleAction)[keyof typeof ProjectLifecycleAction];
export const ProjectMemberStatus = {
    ACTIVE: "active",
    PAUSED: "paused",
} as const;
export type ProjectMemberStatus = (typeof ProjectMemberStatus)[keyof typeof ProjectMemberStatus];
export const GitProvider = {
    GITHUB: "gh",
    GITLAB: "glab",
} as const;
export type GitProvider = (typeof GitProvider)[keyof typeof GitProvider];
export const AI_GUIDE_FILES = ["CLAUDE.md", "AGENT.md"] as const;
export type AiGuideFile = (typeof AI_GUIDE_FILES)[number];
export const AI_TASK_TAGS = ["UpdateSpecFromDB"] as const;
export type AiTaskTag = (typeof AI_TASK_TAGS)[number];
export function isAiTaskTag(value: string): value is AiTaskTag {
    return (AI_TASK_TAGS as readonly string[]).includes(value);
}
export const MachineLinkScope = {
    PROJECT: "project",
    ORCHESTRATOR: "orchestrator",
} as const;
export type MachineLinkScope = (typeof MachineLinkScope)[keyof typeof MachineLinkScope];
