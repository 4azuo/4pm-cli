/**
 * Vendored from @4pm/ws (messages/run-slot.ts) by scripts/vendor-shared.mjs — do not edit.
 */
export const RUN_SLOT_LEASE_TTL_SEC = 120;
export const RUN_SLOT_RENEW_MS = 45000;
export const RUN_SLOT_TICKET_TTL_SEC = 90;
export const RUN_SLOT_RETRY_MS = 3000;
export const RUN_SLOT_MAX_WAIT_MS = 30 * 60000;
export type RunSlotRequest = {
    op: "acquire";
    ticket?: string;
} | {
    op: "renew";
    lease: string;
} | {
    op: "release";
    lease: string;
} | {
    op: "leave";
    ticket: string;
};
export type RunSlotReply = {
    granted: true;
    lease: string | null;
    leaseTtlSec: number;
} | {
    granted: false;
    denied: "storage_full" | "project_inactive";
} | {
    granted: false;
    ticket: string;
    position: number;
    limit: number;
    running: number;
    retryAfterMs: number;
} | {
    ok: boolean;
};
export interface RunQueueInfo {
    position: number;
    limit: number;
    running: number;
    reason?: "slot" | "repo";
    holder?: "autonomous" | "command" | "git" | "project";
    task?: string;
}
export const COMMAND_CANCELLED_EXIT_CODE = 130;
export interface CommandCancelRequest {
    commandId: string;
}
export interface CommandCancelReply {
    ok: boolean;
    state: "queued" | "running" | "unknown";
}
export interface CommandRecheckRequest {
    commandId: string;
}
export interface CommandRecheckReply {
    ok: boolean;
    errorCode?: string;
}
