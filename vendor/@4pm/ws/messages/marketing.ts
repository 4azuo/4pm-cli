/**
 * `marketing.*` messages — the scenes of Content ▸ Marketing on the orphan branch `4pm/marketing/<base>` (server → cli,
 * with reply), and the marketing spec a photo run's `command.dispatch` carries. The cli touches only
 * `.4pm/marketing/**` on that branch. Videos (`videos/<video>/SCENES.md`) ride the same channels.
 * @adr 0640 @adr 0646 @arch 0067
 */
import type { PackagePayloadFile } from "./envelope";

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

/** `marketing.read` request: the overview of a base, plus one set's / video's file when `set` / `video` is given. */
export interface MarketingReadRequest {
  /** Base branch; absent = the primary repo's base. */
  base?: string;
  set?: string;
  video?: string;
}

/** A video as listed by `marketing.read`. @adr 0646 */
export interface MarketingReadVideo {
  video: string;
  scenes: number;
  approved: number;
  /** Parse error of the video's `SCENES.md`. */
  error?: string;
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
  /** When the base has no scene branch: the bases that have one (to copy from). @adr 0646 */
  copyFrom?: string[];
  sets?: MarketingReadSet[];
  videos?: MarketingReadVideo[];
  /** Every shot of the base's sets (`<set>/<SHOT-id>` + title) — what a video's scenes can use. @adr 0646 */
  shots?: { ref: string; title: string }[];
  recipe?: { content: string; sha: string } | null;
  /** The set's `SHOTS.md` + sidecar entries of its shots (keys = shot ids), when `set` was asked. */
  file?: {
    content: string;
    sha: string;
    approvals: Record<string, MarketingWsStamp & { hash: string }>;
    authors: Record<string, MarketingWsStamp & { hash: string }>;
  } | null;
  /** The video's `SCENES.md` + sidecar entries of its scenes (keys = scene ids), when `video` was asked. */
  videoFile?: {
    content: string;
    sha: string;
    approvals: Record<string, MarketingWsStamp & { hash: string }>;
    authors: Record<string, MarketingWsStamp & { hash: string }>;
  } | null;
  code?: string;
  error?: string;
}

/**
 * `marketing.write` request: put / delete one marketing file. `path` is `run.yaml`, `photos/<set>/SHOTS.md` or `videos/<video>/SCENES.md`
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

/** `marketing.approve` request (a set's shots, or a video's scenes). `allowSelf` = the approver may approve a row they wrote (ADMIN). */
export interface MarketingApproveRequest {
  base?: string;
  set?: string;
  video?: string;
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

/** `marketing.copy` request: create `4pm/marketing/<to>` from `4pm/marketing/<from>`. @adr 0646 */
export interface MarketingCopyRequest {
  from: string;
  to: string;
  by: string;
  byLabel: string;
}

/** `marketing.copy` reply. `code` = `MARKETING_BRANCH_EXISTS` | `MARKETING_SET_NOT_FOUND` (no source) | `MARKETING_WRITE_FAILED`. */
export interface MarketingCopyReply {
  ok: boolean;
  sha?: string;
  code?: string;
  error?: string;
}

/** One picture a video run downloads (mirrors `@4pm/dto` `MarketingVideoInput`). @adr 0646 */
export interface MarketingWsVideoInput {
  assetId: string;
  shot: string;
  file: string;
  theme: string | null;
  locale: string | null;
  size: string | null;
}

/** The video part of a video run's spec. @adr 0646 */
export interface MarketingVideoRunSpec {
  /** The pictures the approved scenes use, from the photo runs chosen per set. */
  inputs: MarketingWsVideoInput[];
  /** `GET` path of one input (`…/inputs/<assetId>`, an audio `…/inputs/audio/<id>`), under the cli's server URL, with the upload token. */
  inputPath: string;
  /** Uploaded audio the soundtrack uses (`soundtrack: uploaded`). */
  audio: { id: string; ext: string }[];
  /** The newest released template (`script:marketing-video-template`), scaffolded when the video has none (or on update). */
  template: { version: string; files: PackagePayloadFile[] } | null;
  updateTemplate: boolean;
  /** The org's Remotion license key — only for the render step's env; never to the agent, never logged. */
  licenseKey: string | null;
}

/** The marketing spec on a run's `command.dispatch` (`job: marketing-photos-generate` / `marketing-video-generate`). */
export interface MarketingRunSpec {
  runId: string;
  kind: "photos" | "videos";
  /** Base branch; resolved by the server from the overview (never empty). */
  base: string;
  /** The photo set, or the video of a video run. */
  set: string;
  /** Present on a video run. */
  video?: MarketingVideoRunSpec;
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
