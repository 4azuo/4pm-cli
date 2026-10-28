/**
 * `host.*` messages — worker hosting. The server tells a hosting worker to run a release of an
 * environment, stop it, start / stop its Cloudflare tunnel connector or tail its log; the cli reports each
 * environment's release / tunnel state on `host.status` (on change and on connect). Never a Cloudflare API key — only a
 * named tunnel's connector token.
 * @adr 0664 @arch 0070
 */

/** How the app runs: a supervised process (as the `agent` uid) or docker compose on the operator's `4pm-host` sidecar. */
export type HostRunMode = "process" | "compose";

/** Process-mode commands (run in the release checkout). */
export interface HostProcessSpec {
  install?: string;
  build?: string;
  start: string;
  /** The port the app listens on; absent = the runner picks one and passes it as `PORT`. */
  port?: number;
  healthPath: string;
  healthTimeoutSec: number;
}

/** Compose-mode settings: the file and the service the tunnel points at (empty service / port: from `.4pm/host.yml`). */
export interface HostComposeSpec {
  file: string;
  service: string;
  port?: number;
  healthPath: string;
}

/** Per-instance resource limits. */
export interface HostLimits {
  cpus: number;
  memoryMb: number;
}

/** server → cli: run a release. Reply `HostDeployReply`. */
export interface HostDeployRequest {
  releaseId: string;
  environmentId: string;
  /** The environment's name (checkout path, compose project name). */
  environmentName: string;
  projectId: string;
  sha: string;
  runMode: HostRunMode;
  process?: HostProcessSpec;
  compose?: HostComposeSpec;
  /** The app's runtime env vars for this release (never written to the profile). */
  envVars: Record<string, string>;
  limits: HostLimits;
  /** The fixed per-environment loopback port the tunnel points at (proxied to the live instance). */
  edgePort: number;
}

/** Reply to `host.deploy`: whether the runner took the release (progress follows on `host.status`). */
export interface HostDeployReply {
  accepted: boolean;
  /** Why not (`hosting_off`, `mode_unsupported`, `busy`). */
  reason?: string;
}

/** server → cli: stop an environment's instance(s) and tunnel connector — or, with `releaseId`, only that release in progress (cancel). */
export interface HostStopRequest {
  environmentId: string;
  releaseId?: string;
}

/** server → cli: run / stop the environment's `cloudflared`. */
export interface HostTunnelRequest {
  environmentId: string;
  kind: "quick" | "named";
  /** Named tunnels: the connector token (`tunnel run --token`). */
  token?: string;
}

/** server → cli (reply `HostLogsReply`): tail the hosted app's output. */
export interface HostLogsRequest {
  environmentId: string;
  lines: number;
}

/** Reply to `host.logs`. */
export interface HostLogsReply {
  text: string;
  truncated: boolean;
}

/** A release's state on the worker. */
export type HostReleaseState = "pending" | "running" | "live" | "failed" | "stopped" | "superseded";
/** A release step. */
export type HostReleaseStep = "fetch" | "install" | "build" | "start" | "health" | "swap";
/** The tunnel connector's state on the worker. */
export type HostTunnelState = "starting" | "connected" | "degraded" | "down";

/** cli → server: one environment's state. */
export interface HostStatusPayload {
  environmentId: string;
  releaseId: string | null;
  state: HostReleaseState;
  step?: HostReleaseStep;
  /** The failing step's output tail (≤ 4 KB). */
  tail?: string;
  port?: number;
  tunnel: { state: HostTunnelState; url?: string };
  cpu?: number;
  memMb?: number;
}

/** The hosting part of `machine.status`. */
export interface MachineHostingReport {
  /** Run modes this worker can serve (`compose` only with the `4pm-host` sidecar reachable). */
  modes: HostRunMode[];
  /** Environments it serves now. */
  instances: number;
  /** Free memory (MB) — ranks `auto` candidates. */
  freeMemMb?: number;
}
