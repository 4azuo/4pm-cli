/**
 * Vendored from @4pm/ws (messages/marketing.ts) by scripts/vendor-shared.mjs — do not edit.
 */
import type { PackagePayloadFile } from "./envelope";
export type MarketingWsDriver = "web" | "electron" | "terminal" | "api";
export type MarketingWsTarget = "local" | "url";
export interface MarketingWsStamp {
    by: string;
    byLabel: string;
    at: string;
}
export interface MarketingReadRequest {
    base?: string;
    set?: string;
    video?: string;
}
export interface MarketingReadVideo {
    video: string;
    scenes: number;
    approved: number;
    error?: string;
}
export interface MarketingReadSet {
    set: string;
    driver: MarketingWsDriver | null;
    shots: number;
    approved: number;
    error?: string;
}
export interface MarketingReadReply {
    ok: boolean;
    base?: string;
    bases?: string[];
    branchExists?: boolean;
    copyFrom?: string[];
    sets?: MarketingReadSet[];
    videos?: MarketingReadVideo[];
    shots?: {
        ref: string;
        title: string;
    }[];
    recipe?: {
        content: string;
        sha: string;
    } | null;
    file?: {
        content: string;
        sha: string;
        approvals: Record<string, MarketingWsStamp & {
            hash: string;
        }>;
        authors: Record<string, MarketingWsStamp & {
            hash: string;
        }>;
    } | null;
    videoFile?: {
        content: string;
        sha: string;
        approvals: Record<string, MarketingWsStamp & {
            hash: string;
        }>;
        authors: Record<string, MarketingWsStamp & {
            hash: string;
        }>;
    } | null;
    code?: string;
    error?: string;
}
export interface MarketingWriteRequest {
    base?: string;
    path: string;
    content: string | null;
    baseSha: string | null;
    by: string;
    byLabel: string;
}
export interface MarketingWriteReply {
    ok: boolean;
    sha?: string | null;
    code?: string;
    error?: string;
}
export interface MarketingApproveRequest {
    base?: string;
    set?: string;
    video?: string;
    approve: {
        id: string;
        hash: string;
    }[];
    unapprove: string[];
    by: string;
    byLabel: string;
    allowSelf: boolean;
}
export interface MarketingApproveReply {
    ok: boolean;
    approvals?: Record<string, MarketingWsStamp>;
    code?: string;
    error?: string;
}
export interface MarketingCopyRequest {
    from: string;
    to: string;
    by: string;
    byLabel: string;
}
export interface MarketingCopyReply {
    ok: boolean;
    sha?: string;
    code?: string;
    error?: string;
}
export interface MarketingWsVideoInput {
    assetId: string;
    shot: string;
    file: string;
    theme: string | null;
    locale: string | null;
    size: string | null;
}
export interface MarketingVideoRunSpec {
    inputs: MarketingWsVideoInput[];
    inputPath: string;
    audio: {
        id: string;
        ext: string;
    }[];
    template: {
        version: string;
        files: PackagePayloadFile[];
    } | null;
    updateTemplate: boolean;
    licenseKey: string | null;
}
export interface MarketingRunSpec {
    runId: string;
    kind: "photos" | "videos";
    base: string;
    set: string;
    video?: MarketingVideoRunSpec;
    sourceRef: string | null;
    target: MarketingWsTarget;
    targetUrl: string | null;
    uploadPath: string;
    uploadToken: string;
}
