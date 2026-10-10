/**
 * DTO for the meta domain (21-api/meta-0001 — cli-version) and the admin cli version policy.
 * @api admin-0132…0136 @adr 0363 @adr 0015
 */
import { z } from "zod";

/** A cli version's effective support status — mirrors `@4pm/utils` CliVersionStatus. */
export type CliVersionStatus = "supported" | "warning" | "unsupported";

/** Self-download tarball source for machines without npm. */
export interface CliDownloadSource {
  tarballUrl: string;
  /** sha256 hex of the tarball — the cli verifies it before replacing. */
  checksum: string;
  /** Signature (optional) — verified with the public key embedded in the cli. */
  signature?: string;
}

/** Data 200 GET /meta/cli-version. @api meta-0001 */
export interface CliVersionResponse {
  /** Latest version (semver). */
  latest: string;
  /** Minimum supported version — admin-set, else env CLI_MIN_SUPPORTED_VERSION. */
  minSupported: string;
  source: CliDownloadSource;
  /** Only with `?version=`: that version's effective status. */
  status?: CliVersionStatus;
  /** Only with `?version=`: ISO cut-off date of a `warning` version. */
  unsupportedFrom?: string | null;
  /** Only with `?version=`: the admin's note for that version. */
  note?: string | null;
}

/** Data 200 GET /meta/config. @api meta-0002 */
export interface MetaConfigResponse {
  /** Public REST origin the cli pairs against — the value for `--server` /
   *  `FOURPM_SERVER` (dev: http://localhost:42001; prod: the deployment's API origin). */
  serverUrl: string;
}

/** Data 200 GET /meta/public-stats — public platform aggregates
 *  for the /login announcement modal (aggregates only, no per-account data).
 * @api meta-0003 @adr 0315
 */
export interface PublicStatsResponse {
  /** Registered organizations (excludes the platform-pool org). */
  orgCount: number;
  /** Users currently logged in — open web-presence sessions (`UserSession.endedAt IS NULL`). */
  onlineUsers: number;
  /** Workers connected right now (live WS presence). @adr 0133 */
  workersRunning: number;
}

/** One admin override of the cli version policy. */
export interface CliVersionOverrideView {
  version: string;
  status: CliVersionStatus;
  /** ISO cut-off date (only with `warning`). */
  unsupportedFrom: string | null;
  note: string;
}

/** One row of the admin CLI versions grid. @api admin-0132 */
export interface CliVersionRow {
  version: string;
  /** npm publish time; null for a version not on npm (e.g. a hand build a worker reports). */
  releasedAt: string | null;
  /** Workers whose last-reported version is this one (all orgs + pools). */
  workers: number;
  /** Of those, workers with at least one connected link. */
  connectedWorkers: number;
  status: CliVersionStatus;
  source: "auto" | "override";
  unsupportedFrom: string | null;
  note: string;
  isLatest: boolean;
  isMin: boolean;
}

/** Data admin-0132 GET /admin/cli/versions (and the write replies, + `disconnected`). */
export interface CliVersionPolicyResponse {
  /** Effective minimum (admin-set, else env default). */
  minSupported: string;
  minSupportedSource: "admin" | "env";
  /** env CLI_MIN_SUPPORTED_VERSION (the "Reset to env default" value). */
  envMinSupported: string;
  /** Latest release; null when unresolved. */
  latest: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
  overrides: CliVersionOverrideView[];
  /** Newest first. */
  rows: CliVersionRow[];
  /** Write replies only: links closed with CLI_VERSION_UNSUPPORTED. */
  disconnected?: number;
}

/** One worker running a given cli version. @api admin-0136 */
export interface CliVersionWorker {
  workerId: string;
  workerName: string;
  orgId: string;
  orgName: string;
  connected: boolean;
  lastSeenAt: string | null;
  links: { id: string; username: string; connected: boolean }[];
}

/** x.y.z with an optional -suffix / +build. */
const cliVersionString = z.string().trim().regex(/^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/);

/** Body admin-0133 PUT /admin/cli/versions/min. */
export const setCliMinVersionRequestSchema = z.object({
  minSupported: cliVersionString.nullable(),
  disconnect: z.boolean().optional(),
});
export type SetCliMinVersionRequest = z.infer<typeof setCliMinVersionRequestSchema>;

/** Body admin-0134 PUT /admin/cli/versions/:version. */
export const setCliVersionOverrideRequestSchema = z.object({
  status: z.enum(["supported", "warning", "unsupported"]),
  unsupportedFrom: z.string().datetime({ offset: true }).nullable().optional(),
  note: z.string().max(500).optional(),
  disconnect: z.boolean().optional(),
});
export type SetCliVersionOverrideRequest = z.infer<typeof setCliVersionOverrideRequestSchema>;
