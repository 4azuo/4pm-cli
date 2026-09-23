/**
 * Project-domain constants.
 */

/**
 * Project status: init states (draft = wizard step 1) + lifecycle states
 * (paused/closed — ADR-0092). `closed` is a read-only archive.
 */
export const ProjectStatus = {
  DRAFT: "draft",
  CREATING: "creating",
  READY: "ready",
  FAILED: "failed",
  PAUSED: "paused",
  CLOSED: "closed",
} as const;

/** Union type of project statuses. */
export type ProjectStatus = (typeof ProjectStatus)[keyof typeof ProjectStatus];

/**
 * Project lifecycle action (ADR-0092) — carried in the `project.lifecycle`
 * notification payload and the activity-log `action`.
 */
export const ProjectLifecycleAction = {
  PAUSE: "pause",
  RESUME: "resume",
  CLOSE: "close",
  REOPEN: "reopen",
} as const;

/** Union type of project lifecycle actions. */
export type ProjectLifecycleAction =
  (typeof ProjectLifecycleAction)[keyof typeof ProjectLifecycleAction];

/**
 * A direct member's (`project_users`) membership status (ADR-0093): `paused` =
 * the membership is inactive in this one project (the user stays active elsewhere).
 */
export const ProjectMemberStatus = {
  ACTIVE: "active",
  PAUSED: "paused",
} as const;

/** Union type of project-member statuses. */
export type ProjectMemberStatus =
  (typeof ProjectMemberStatus)[keyof typeof ProjectMemberStatus];

/** A project's git provider. */
export const GitProvider = {
  GITHUB: "gh",
  GITLAB: "glab",
} as const;

/** Union type of git providers. */
export type GitProvider = (typeof GitProvider)[keyof typeof GitProvider];

/**
 * The single agent-guide file a project uses (ADR-0309), stored under `settings.aiGuideFile`.
 * A project uses **one** file — `CLAUDE.md` (Claude Code) or `AGENT.md` (other AI CLIs) — never
 * both at once: the scaffold writes only this file and the Content AI-Guide reads/generates it.
 */
export const AI_GUIDE_FILES = ["CLAUDE.md", "AGENT.md"] as const;

/** Union type of AI-guide files. */
export type AiGuideFile = (typeof AI_GUIDE_FILES)[number];

/**
 * AI Todo task tags (ADR-0311) — a **closed** catalog of tags a task may carry in the `AI_TODO.md`
 * `Tag` column. Each tag maps to a **server-side action run down to the project** when the task is
 * approved (approval is committed on Save). The only member now is `UpdateSpecFromDB`: the server
 * loads the DB `Project.spec` and writes it into the worker's `project.spec.json`. Tags are chosen
 * from this catalog only (multi-select, no free text) so every tag resolves to a known handler; the
 * per-tag human description is an i18n string on the web, not here (this package stays i18n-free).
 */
export const AI_TASK_TAGS = ["UpdateSpecFromDB"] as const;

/** Union type of AI Todo task tags. */
export type AiTaskTag = (typeof AI_TASK_TAGS)[number];

/** True when a raw cell token is a known task tag (drops unknown/legacy text). */
export function isAiTaskTag(value: string): value is AiTaskTag {
  return (AI_TASK_TAGS as readonly string[]).includes(value);
}

/** Machine-link scope (ADR-0010). */
export const MachineLinkScope = {
  PROJECT: "project",
  ORCHESTRATOR: "orchestrator",
} as const;

/** Union type of machine-link scopes. */
export type MachineLinkScope =
  (typeof MachineLinkScope)[keyof typeof MachineLinkScope];
