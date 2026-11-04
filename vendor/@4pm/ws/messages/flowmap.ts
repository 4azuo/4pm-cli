/**
 * Vendored from @4pm/ws (messages/flowmap.ts) by scripts/vendor-shared.mjs — do not edit.
 */
export interface FlowMapContextRequest {
    features: string[];
    nodes: string[];
    q?: string;
    depth: number;
    rag: boolean;
}
export interface FlowMapContextReply {
    ok: boolean;
    files?: {
        path: string;
        why: string;
        bytes: number;
        distance: number;
    }[];
    rag?: {
        installed: boolean;
        used: boolean;
    };
    code?: string;
    error?: string;
}
export interface FlowMapStaleCheckRequest {
    sources: {
        path: string;
        since: string;
    }[];
    diffs?: string[];
}
export interface FlowMapStaleCheckReply {
    ok: boolean;
    base?: string;
    baseHead?: string;
    changed?: {
        path: string;
        commit: string;
        author: string;
        at: string;
        subject: string;
    }[];
    diffs?: {
        path: string;
        diff: string;
    }[];
    code?: string;
    error?: string;
}
export interface FlowMapDocMeta {
    id: string;
    title: string;
    features: string[];
    generatedBy: string;
}
export interface FlowMapSavePlanRequest {
    slug: string;
    version: number;
    modelJson: string;
    sources: {
        path: string;
        commit: string;
    }[];
    folder: string;
    fileName: string;
    svg: string;
    docMeta: FlowMapDocMeta;
}
export interface FlowMapPlanFileWire {
    path: string;
    status: "new" | "modified" | "unchanged" | "skipped";
    reason?: "no-header" | "missing" | "other-repo";
    diff?: string;
}
export interface FlowMapSavePlanReply {
    ok: boolean;
    base?: string;
    baseRef?: string;
    dirs?: string[];
    files?: FlowMapPlanFileWire[];
    planHash?: string;
    code?: string;
    error?: string;
}
export interface FlowMapSaveRequest extends FlowMapSavePlanRequest {
    planHash: string;
    title: string;
    body: string;
    by: string;
    byLabel: string;
}
export interface FlowMapSaveReply {
    ok: boolean;
    branch?: string;
    prUrl?: string | null;
    number?: number | null;
    skipped?: {
        path: string;
        reason: string;
    }[];
    code?: string;
    step?: "base" | "push" | "pr";
    error?: string;
}
