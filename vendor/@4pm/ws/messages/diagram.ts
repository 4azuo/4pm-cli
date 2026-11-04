/**
 * Vendored from @4pm/ws (messages/diagram.ts) by scripts/vendor-shared.mjs — do not edit.
 */
import type { ApprovalEntry, ApprovalState } from "./envelope";
import type { ErcStateWire } from "./er";
export interface DiagramReadRequest {
    version?: number;
    changes?: boolean;
}
export interface DiagramModuleFile {
    name: string;
    path: string;
    content: string;
}
export interface DiagramChangeFile {
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
export interface DiagramHistoryWire {
    version: number;
    sdc: string;
    appliedAt: string;
    approvedBy: string;
    approvedByLabel?: string;
    cells: string[];
    commit?: string;
}
export interface DiagramReadReply {
    diagramDir: string;
    version: number;
    currentVersion: number;
    autoApprove: boolean;
    index: string;
    modules: DiagramModuleFile[];
    changes: DiagramChangeFile[];
    cells: Record<string, {
        v: number;
        module: string;
        page: string;
    }>;
    history: DiagramHistoryWire[];
    approvals: string;
    authors: string;
    approvalStates: Record<string, ApprovalState>;
    error?: string;
}
export type DiagramWriteRequest = {
    kind: "save";
    id?: string;
    title: string;
    module: string;
    page?: string;
    modules: {
        name: string;
        content: string;
    }[];
    baseVersion: number;
    rationale?: string;
    req?: string[];
    group?: string;
    source?: "web" | "draft";
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
export interface DiagramWriteReply {
    ok: boolean;
    id?: string;
    state?: ErcStateWire;
    overlaps?: string[];
    version?: number;
    code?: string;
    error?: string;
    meta?: Record<string, unknown>;
}
