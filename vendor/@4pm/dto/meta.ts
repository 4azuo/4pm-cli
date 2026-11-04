/**
 * Vendored from @4pm/dto (meta.ts) by scripts/vendor-shared.mjs — do not edit.
 */
import { z } from "zod";
export type CliVersionStatus = "supported" | "warning" | "unsupported";
export interface CliDownloadSource {
    tarballUrl: string;
    checksum: string;
    signature?: string;
}
export interface CliVersionResponse {
    latest: string;
    minSupported: string;
    source: CliDownloadSource;
    status?: CliVersionStatus;
    unsupportedFrom?: string | null;
    note?: string | null;
}
export interface MetaConfigResponse {
    serverUrl: string;
}
export interface PublicStatsResponse {
    orgCount: number;
    onlineUsers: number;
    workersRunning: number;
}
export interface CliVersionOverrideView {
    version: string;
    status: CliVersionStatus;
    unsupportedFrom: string | null;
    note: string;
}
export interface CliVersionRow {
    version: string;
    releasedAt: string | null;
    workers: number;
    connectedWorkers: number;
    status: CliVersionStatus;
    source: "auto" | "override";
    unsupportedFrom: string | null;
    note: string;
    isLatest: boolean;
    isMin: boolean;
}
export interface CliVersionPolicyResponse {
    minSupported: string;
    minSupportedSource: "admin" | "env";
    envMinSupported: string;
    latest: string | null;
    updatedAt: string | null;
    updatedBy: string | null;
    overrides: CliVersionOverrideView[];
    rows: CliVersionRow[];
    disconnected?: number;
}
export interface CliVersionWorker {
    workerId: string;
    workerName: string;
    orgId: string;
    orgName: string;
    connected: boolean;
    lastSeenAt: string | null;
    links: {
        id: string;
        username: string;
        connected: boolean;
    }[];
}
const cliVersionString = z.string().trim().regex(/^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/);
export const setCliMinVersionRequestSchema = z.object({
    minSupported: cliVersionString.nullable(),
    disconnect: z.boolean().optional(),
});
export type SetCliMinVersionRequest = z.infer<typeof setCliMinVersionRequestSchema>;
export const setCliVersionOverrideRequestSchema = z.object({
    status: z.enum(["supported", "warning", "unsupported"]),
    unsupportedFrom: z.string().datetime({ offset: true }).nullable().optional(),
    note: z.string().max(500).optional(),
    disconnect: z.boolean().optional(),
});
export type SetCliVersionOverrideRequest = z.infer<typeof setCliVersionOverrideRequestSchema>;
