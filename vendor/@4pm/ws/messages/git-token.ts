/**
 * `git.token` (cli → server, request–reply — ADR-0356): the worker's git credential helper / `gh` shim
 * asks for a short-lived GitHub-App installation token for one repo of the served project, scoped to a
 * job (or the link's default scope); at scope end the cli revokes the tokens at GitHub and reports it.
 * The App private key never leaves the server.
 */

/** Host kind of the token's GitHub host — picks the `gh` env (`GH_TOKEN` vs `GH_ENTERPRISE_TOKEN`). */
export type GitHostKind = "github" | "ghe-cloud" | "ghes";

/** cli → server: issue a token for `repo` under `scope`, or report `scope` revoked. */
export type GitTokenRequest =
  | {
      op: "issue";
      /** The job id (`FOURPM_JOB_ID`) or the link's default scope. */
      scope: string;
      /** The repo git/gh asks for — `host` + `path` (`owner/repo[.git]`, may be empty for `gh`). */
      repo: { host: string; path: string };
    }
  | { op: "revoked"; scope: string };

/** Why no token was issued — the helper then stays silent (git falls back to worker creds). */
export type GitTokenDenyReason = "not_github_app" | "not_covered" | "not_configured" | "mint_failed";

/** server → cli reply. `issue`: a token or `{token:null, reason}`; `revoked`: `{}`. */
export interface GitTokenReply {
  token?: string | null;
  host?: string;
  hostKind?: GitHostKind;
  /** Resolved API base (for the cli's own revoke call). */
  apiBase?: string;
  /** ISO expiry. */
  expiresAt?: string;
  reason?: GitTokenDenyReason;
}
