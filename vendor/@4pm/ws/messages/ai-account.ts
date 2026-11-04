/**
 * Vendored from @4pm/ws (messages/ai-account.ts) by scripts/vendor-shared.mjs — do not edit.
 */
export const AI_ACCOUNT_LEASE_TTL_SEC = 120;
export const AI_ACCOUNT_RENEW_MS = 45000;
export const AI_ACCOUNT_MAX_CANDIDATES = 32;
export const AI_ACCOUNT_EXHAUSTED_DEFAULT_MS = 60 * 60000;
export const AI_ACCOUNT_EXHAUSTED_MAX_MS = 7 * 24 * 60 * 60000;
export type AiAccountRequest = {
    op: "acquire";
    candidates: string[];
    pinned?: string;
    preferred?: string;
} | {
    op: "renew";
    lease: string;
    accountKey: string;
} | {
    op: "release";
    lease: string;
    accountKey: string;
} | {
    op: "exhausted";
    accountKey: string;
    until: number;
};
export type AiAccountReply = {
    accountKey: string;
    lease: string;
    leaseTtlSec: number;
    busy: boolean;
    order: string[];
} | {
    ok: boolean;
};
