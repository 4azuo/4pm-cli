/**
 * `ci.propose` messages — CI workflow file changes proposed as a PR / MR from the serving worker (server → cli, with
 * reply). The cli commits the files on a new `4pm/ci/<slug>-<yyyymmddhhmm>` branch cut from `origin/<base>` (never
 * `<base>` itself), pushes it under a `ci-propose:<uuid>` git-token scope — the only scope the server mints with
 * `workflows: write` — and opens the PR / MR.
 * @adr 0606 @adr 0607 @api machine-0101
 */

/** One file of a proposal: its repo-relative path and the new content (`null` deletes it). */
export interface CiProposeFile {
  path: string;
  content: string | null;
}

/** `ci.propose` request — `by` / `byLabel` are server-filled. */
export interface CiProposeRequest {
  files: CiProposeFile[];
  title: string;
  body: string;
  /** Branch slug (kebab), at most 40 characters. */
  slug: string;
  /** The git-token scope the push runs under (`ci-propose:<uuid>`). */
  scope: string;
  by: string;
  byLabel: string;
}

/**
 * `ci.propose` reply. `code` = `CI_PATH_NOT_ALLOWED` | `CI_PROPOSE_FAILED` | `REPO_BUSY`; `step` names where a
 * `CI_PROPOSE_FAILED` stopped (`base` / `push` / `pr`).
 */
export interface CiProposeReply {
  ok: boolean;
  branch?: string;
  prUrl?: string | null;
  number?: number | null;
  code?: string;
  step?: "base" | "push" | "pr";
  error?: string;
}

/** The paths / caps of a proposal — defined once in `@4pm/constants`. */
export { CI_PROPOSE_MAX_FILE_BYTES, CI_PROPOSE_MAX_FILES, CI_PROPOSE_PATH } from "@4pm/constants";
