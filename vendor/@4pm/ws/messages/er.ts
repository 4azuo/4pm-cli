/**
 * Vendored from @4pm/ws (messages/er.ts) by scripts/vendor-shared.mjs — do not edit.
 */
import type { ApprovalEntry, ApprovalState } from "./envelope";
export type ErcStateWire = "pending" | "applied" | "rejected" | "conflict" | "withdrawn";
export interface ErReadRequest {
    version?: number;
    changes?: boolean;
}
export interface ErModuleFile {
    name: string;
    path: string;
    content: string;
}
export interface ErChangeFile {
    id: string;
    path: string;
    content: string;
    state: ErcStateWire;
    reason?: string;
    conflictsWith?: string[];
    appliedVersion?: number;
    at?: string;
    by?: string;
    byLabel?: string;
}
export interface ErHistoryWire {
    version: number;
    erc: string;
    appliedAt: string;
    approvedBy: string;
    approvedByLabel?: string;
    entities: string[];
    commit?: string;
}
export interface ErReadReply {
    erDir: string;
    version: number;
    currentVersion: number;
    index: string;
    modules: ErModuleFile[];
    changes: ErChangeFile[];
    entities: Record<string, {
        v: number;
        module: string;
    }>;
    history: ErHistoryWire[];
    approvals: string;
    authors: string;
    approvalStates: Record<string, ApprovalState>;
    error?: string;
}
export type ErWriteRequest = {
    kind: "save";
    id?: string;
    title: string;
    module: string;
    modules: {
        name: string;
        content: string;
    }[];
    baseVersion: number;
    rationale?: string;
    req?: string[];
    group?: string;
    by: string;
    byLabel?: string;
} | {
    kind: "withdraw";
    id: string;
    by: string;
    byLabel?: string;
    byIsAdmin?: boolean;
} | {
    kind: "decide";
    id: string;
    decision: "approve" | "reject";
    reason?: string;
    entry?: ApprovalEntry;
    h?: string;
    by: string;
    byLabel?: string;
    byIsAdmin?: boolean;
};
export interface ErWriteReply {
    ok: boolean;
    id?: string;
    state?: ErcStateWire;
    overlaps?: string[];
    version?: number;
    code?: string;
    error?: string;
    meta?: Record<string, unknown>;
}
