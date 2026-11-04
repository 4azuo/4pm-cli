/**
 * Vendored from @4pm/ws (messages/faq-compose.ts) by scripts/vendor-shared.mjs — do not edit.
 */
export interface FaqTicketMessage {
    author: "user" | "admin";
    body: string;
    at: string;
}
export interface FaqTicket {
    id: string;
    subject: string;
    category: string;
    messages: FaqTicketMessage[];
}
export interface FaqComposeRequest {
    tickets: FaqTicket[];
    repo: {
        url: string;
        branch: string;
        token: string | null;
    };
    headBranch: string;
    customPrompt?: string;
}
export interface FaqTicketResult {
    ticketId: string;
    summary: string;
}
export interface FaqComposeUsage {
    input: number;
    output: number;
    cacheRead: number;
    cacheCreation: number;
}
export interface FaqComposeReply {
    prUrl: string;
    branch?: string;
    output?: string;
    perTicket?: FaqTicketResult[];
    error?: string;
    tokens?: number;
    tokensBreakdown?: FaqComposeUsage;
    finishedAt?: string;
}
