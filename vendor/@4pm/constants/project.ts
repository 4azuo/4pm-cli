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

/** Machine-link scope (ADR-0010). */
export const MachineLinkScope = {
  PROJECT: "project",
  ORCHESTRATOR: "orchestrator",
} as const;

/** Union type of machine-link scopes. */
export type MachineLinkScope =
  (typeof MachineLinkScope)[keyof typeof MachineLinkScope];
