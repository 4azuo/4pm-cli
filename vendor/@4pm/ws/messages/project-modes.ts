/**
 * Vendored from @4pm/ws (messages/project-modes.ts) by scripts/vendor-shared.mjs — do not edit.
 */
import type { ApprovalEntry } from "./envelope";
export type RepoPushProbeRequest = Record<string, never>;
export interface RepoPushProbeReply {
    ok: boolean;
    reason?: string;
}
export interface AutonomousAutoApproveRequest {
    rowIds: string[];
    books: {
        userTodo?: string;
        aiTodo?: string;
    };
}
export interface AutonomousAutoApproveReply {
    signed: Record<string, ApprovalEntry>;
    unsigned?: boolean;
    rowIds: string[];
    error?: string;
}
