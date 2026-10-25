/**
 * `marketing.*` messages — the scenes of Content ▸ Marketing on the orphan branch `4pm/marketing/<base>` (server → cli,
 * with reply), and the marketing spec a photo run's `command.dispatch` carries. The cli touches only
 * `.4pm/marketing/**` on that branch.
 * @adr 0640 @arch 0067
 */

/** Capture driver (mirrors `@4pm/dto` `MarketingDriver`; kept local so `@4pm/ws` stays dep-free). */
export type MarketingWsDriver = "web" | "electron" | "terminal" | "api";
/** Capture target (mirrors `@4pm/dto` `MarketingTarget`). */
export type MarketingWsTarget = "local" | "url";
/** Who did something to a shot, and when (mirrors `@4pm/dto` `MarketingWsStamp`). */
export interface MarketingWsStamp {
  by: string;
  byLabel: string;
  at: string;
}

/** `marketing.read` request: the overview of a base, plus one set's file when `set` is given. */
export interface MarketingReadRequest {
  /** Base branch; absent = the primary repo's base. */
  base?: string;
  set?: string;
}

/** A set as listed by `marketing.read`. */
export interface MarketingReadSet {
  set: string;
  driver: MarketingWsDriver | null;
  shots: number;
  approved: number;
  /** Parse error of the set's `SHOTS.md`, when it doesn't parse. */
  error?: string;
}

/** `marketing.read` reply. */
export interface MarketingReadReply {
  ok: boolean;
  /** The base that was read. */
  base?: string;
  /** The project's remote branches that can be a base (no 4PM branches). */
  bases?: string[];
  branchExists?: boolean;
  sets?: MarketingReadSet[];
  recipe?: { content: string; sha: string } | null;
  /** The set's `SHOTS.md` + sidecar entries of its shots (keys = shot ids), when `set` was asked. */
  file?: {
    content: string;
    sha: string;
    approvals: Record<string, MarketingWsStamp & { hash: string }>;
    authors: Record<string, MarketingWsStamp & { hash: string }>;
  } | null;
  code?: string;
  error?: string;
}

/**
 * `marketing.write` request: put / delete one marketing file. `path` is `run.yaml` or `photos/<set>/SHOTS.md`
 * (relative to `.4pm/marketing/`); `content: null` deletes the set folder (only for a `SHOTS.md`). `baseSha` is the
 * blob read before the edit (`null` = the file must not exist yet). A `SHOTS.md` write updates `authors.json` for the
 * shots whose hash changed.
 */
export interface MarketingWriteRequest {
  base?: string;
  path: string;
  content: string | null;
  baseSha: string | null;
  by: string;
  byLabel: string;
}

/** `marketing.write` reply. `code` = `MARKETING_FILE_CHANGED` | `MARKETING_INVALID_SHOTS` | `MARKETING_WRITE_FAILED`. */
export interface MarketingWriteReply {
  ok: boolean;
  sha?: string | null;
  code?: string;
  error?: string;
}

/** `marketing.approve` request. `allowSelf` = the approver may approve a shot they wrote (ADMIN). */
export interface MarketingApproveRequest {
  base?: string;
  set: string;
  approve: { id: string; hash: string }[];
  unapprove: string[];
  by: string;
  byLabel: string;
  allowSelf: boolean;
}

/** `marketing.approve` reply. `code` = `MARKETING_FILE_CHANGED` | `APPROVAL_SELF` | `MARKETING_WRITE_FAILED`. */
export interface MarketingApproveReply {
  ok: boolean;
  approvals?: Record<string, MarketingWsStamp>;
  code?: string;
  error?: string;
}

/** The marketing spec on a photo run's `command.dispatch` (`job: marketing-photos-generate`). */
export interface MarketingRunSpec {
  runId: string;
  kind: "photos";
  /** Base branch; resolved by the server from the overview (never empty). */
  base: string;
  set: string;
  /** Tag / commit on `<base>`; null = its head. */
  sourceRef: string | null;
  target: MarketingWsTarget;
  targetUrl: string | null;
  /** `POST` path of the run's uploads (`/machine-links/marketing/uploads/<runId>`), under the cli's server URL. */
  uploadPath: string;
  /** Bearer token of the uploads. */
  uploadToken: string;
  // The project secrets the recipe / shots name are read on the worker, never sent here.
}
