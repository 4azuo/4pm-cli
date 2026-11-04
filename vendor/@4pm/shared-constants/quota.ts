/**
 * Vendored from @4pm/shared-constants (quota.ts) by scripts/vendor-shared.mjs — do not edit.
 */
export const UsageMetric = {
    AI_TOKENS: "ai_tokens",
    COMMANDS: "commands",
    AUTONOMOUS_MINUTES: "autonomous_minutes",
} as const;
export type UsageMetric = (typeof UsageMetric)[keyof typeof UsageMetric];
export const QuotaSubjectType = {
    ORG: "org",
    PROJECT: "project",
    USER: "user",
    MACHINE: "machine",
    PHYSIC_PROJECT: "physic_project",
} as const;
export type QuotaSubjectType = (typeof QuotaSubjectType)[keyof typeof QuotaSubjectType];
export const QuotaPeriod = {
    DAY: "day",
    MONTH: "month",
} as const;
export type QuotaPeriod = (typeof QuotaPeriod)[keyof typeof QuotaPeriod];
export const QuotaOnExceed = {
    BLOCK: "block",
    WARN: "warn",
} as const;
export type QuotaOnExceed = (typeof QuotaOnExceed)[keyof typeof QuotaOnExceed];
export const AiTokenProvider = {
    CLAUDE: "claude",
    CODEX: "codex",
    ANTIGRAVITY: "antigravity",
} as const;
export type AiTokenProvider = (typeof AiTokenProvider)[keyof typeof AiTokenProvider];
export const AI_TOKEN_PROVIDERS: readonly AiTokenProvider[] = [
    AiTokenProvider.CLAUDE,
    AiTokenProvider.CODEX,
    AiTokenProvider.ANTIGRAVITY,
];
export const DEFAULT_TOKEN_QUOTA_WEIGHTS = { input: 1, output: 5, cacheRead: 0.1, cacheCreation: 1.25 } as const;
export const MAX_TOKEN_QUOTA_WEIGHT = 100;
