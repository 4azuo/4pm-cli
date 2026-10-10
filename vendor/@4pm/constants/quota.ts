/**
 * Quota & usage-metering constants.
 * @adr 0020
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

/** AI providers whose tokens carry separate quota weights. @adr 0340 */
export const AiTokenProvider = {
  CLAUDE: "claude",
  CODEX: "codex",
  ANTIGRAVITY: "antigravity",
} as const;

/** Union type of AI token providers. */
export type AiTokenProvider = (typeof AiTokenProvider)[keyof typeof AiTokenProvider];

/** Every AI token provider, in display order. */
export const AI_TOKEN_PROVIDERS: readonly AiTokenProvider[] = [
  AiTokenProvider.CLAUDE,
  AiTokenProvider.CODEX,
  AiTokenProvider.ANTIGRAVITY,
];

/**
 * Seeded quota-token weights: how many quota tokens one token of each component counts as.
 * Anthropic list-price ratios (output ≈ 5× input, cache read ≈ 0.1×, cache write ≈ 1.25×); the
 * platform admin tunes each provider afterwards.
 * @adr 0340
 */
export const DEFAULT_TOKEN_QUOTA_WEIGHTS = { input: 1, output: 5, cacheRead: 0.1, cacheCreation: 1.25 } as const;

/** Upper bound for a single quota-token weight — guards against a typo like 1000. @adr 0340 */
export const MAX_TOKEN_QUOTA_WEIGHT = 100;
