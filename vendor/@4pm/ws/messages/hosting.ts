/**
 * Vendored from @4pm/ws (messages/hosting.ts) by scripts/vendor-shared.mjs — do not edit.
 */
export type HostRunMode = "process" | "compose";
export interface HostProcessSpec {
    install?: string;
    build?: string;
    start: string;
    port?: number;
    healthPath: string;
    healthTimeoutSec: number;
}
export interface HostComposeSpec {
    file: string;
    service: string;
    port?: number;
    healthPath: string;
}
export interface HostLimits {
    cpus: number;
    memoryMb: number;
}
export interface HostDeployRequest {
    releaseId: string;
    environmentId: string;
    environmentName: string;
    projectId: string;
    sha: string;
    runMode: HostRunMode;
    process?: HostProcessSpec;
    compose?: HostComposeSpec;
    envVars: Record<string, string>;
    limits: HostLimits;
    edgePort: number;
}
export interface HostDeployReply {
    accepted: boolean;
    reason?: string;
}
export interface HostStopRequest {
    environmentId: string;
    releaseId?: string;
}
export interface HostTunnelRequest {
    environmentId: string;
    kind: "quick" | "named";
    token?: string;
}
export interface HostLogsRequest {
    environmentId: string;
    lines: number;
}
export interface HostLogsReply {
    text: string;
    truncated: boolean;
}
export type HostReleaseState = "pending" | "running" | "live" | "failed" | "stopped" | "superseded";
export type HostReleaseStep = "fetch" | "install" | "build" | "start" | "health" | "swap";
export type HostTunnelState = "starting" | "connected" | "degraded" | "down";
export interface HostStatusPayload {
    environmentId: string;
    releaseId: string | null;
    state: HostReleaseState;
    step?: HostReleaseStep;
    tail?: string;
    port?: number;
    tunnel: {
        state: HostTunnelState;
        url?: string;
    };
    cpu?: number;
    memMb?: number;
}
export interface MachineHostingReport {
    modes: HostRunMode[];
    instances: number;
    freeMemMb?: number;
}
