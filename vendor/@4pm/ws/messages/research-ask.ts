/**
 * Vendored from @4pm/ws (messages/research-ask.ts) by scripts/vendor-shared.mjs — do not edit.
 */
export interface ResearchAttachmentPayload {
    name: string;
    mime: string;
    dataBase64: string;
}
export interface ResearchAskRequest {
    queryId: string;
    question: string;
    attachments?: ResearchAttachmentPayload[];
}
export interface ResearchAskReply {
    answer?: string;
    refused?: boolean;
    refusalReason?: string;
    error?: string;
    tokens?: number;
}
export interface ResearchProgressPayload {
    queryId: string;
    chunk?: string;
    message?: string;
    done?: boolean;
}
