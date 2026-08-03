/**
 * Quota & usage-metering constants (ADR-0020).
 */

/** Measured metric (usage_events.metric). */
export const UsageMetric = {
  AI_TOKENS: "ai_tokens",
  COMMANDS: "commands",
  AUTONOMOUS_MINUTES: "autonomous_minutes",
} as const;

/** Union type of metrics. */
export type UsageMetric = (typeof UsageMetric)[keyof typeof UsageMetric];

/** Quota dimension (quotas.subject_type) — team is report-only, not enforced. */
export const QuotaSubjectType = {
  ORG: "org",
  PROJECT: "project",
  USER: "user",
  MACHINE: "machine",
  PHYSIC_PROJECT: "physic_project",
} as const;

/** Union type of quota subjects. */
export type QuotaSubjectType =
  (typeof QuotaSubjectType)[keyof typeof QuotaSubjectType];

/** Quota accounting period. */
export const QuotaPeriod = {
  DAY: "day",
  MONTH: "month",
} as const;

/** Union type of periods. */
export type QuotaPeriod = (typeof QuotaPeriod)[keyof typeof QuotaPeriod];

/** Behavior when a limit is exceeded. */
export const QuotaOnExceed = {
  BLOCK: "block",
  WARN: "warn",
} as const;

/** Union type of on-exceed behaviors. */
export type QuotaOnExceed = (typeof QuotaOnExceed)[keyof typeof QuotaOnExceed];
