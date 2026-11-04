/**
 * Vendored from @4pm/ws (messages/git-token.ts) by scripts/vendor-shared.mjs — do not edit.
 */
export type GitHostKind = "github" | "ghe-cloud" | "ghes" | "gitlab";
export type GitTokenRequest = {
    op: "issue";
    scope: string;
    repo: {
        host: string;
        path: string;
    };
} | {
    op: "revoked";
    scope: string;
};
export type GitTokenDenyReason = "not_github_app" | "not_gitlab" | "not_covered" | "not_configured" | "mint_failed" | "key_unreadable" | "scope_not_granted";
export interface GitTokenReply {
    token?: string | null;
    host?: string;
    hostKind?: GitHostKind;
    apiBase?: string;
    expiresAt?: string;
    reason?: GitTokenDenyReason;
}
