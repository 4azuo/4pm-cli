/**
 * Vendored from @4pm/ws (messages/support-answer.ts) by scripts/vendor-shared.mjs — do not edit.
 */
export interface SupportAnswerImage {
    placeholder: string;
    mime: string;
    dataBase64: string;
}
export interface SupportAnswerRequest {
    question: string;
    askerRole: "admin" | "user";
    repo: {
        url: string;
        branch: string;
        token: string | null;
    };
    images?: SupportAnswerImage[];
    task?: SupportAnswerTask;
}
export type SupportAnswerTask = "reply_draft" | "outreach_draft" | "legal_draft" | "prompt_generate" | "prompt_translate" | "hub_review";
export interface SupportAnswerUsage {
    input: number;
    output: number;
    cacheRead: number;
    cacheCreation: number;
}
export interface SupportAnswerModeration {
    onTopic: boolean;
    sensitive: boolean;
    reason?: string;
}
export interface SupportAnswerReply {
    body: string;
    error?: string;
    moderation?: SupportAnswerModeration;
    tokens?: number;
    tokensBreakdown?: SupportAnswerUsage;
    finishedAt?: string;
}
