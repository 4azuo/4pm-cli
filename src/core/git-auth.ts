/**
 * Git-auth application on the worker (ADR-0192 §4). The per-project method arrives on the daily
 * `ws_token`; the token itself is injected out-of-band as `FOURPM_GIT_TOKEN` (a GitLab group deploy
 * token, or a GitHub App installation token minted server-side — the mint/refresh loop is a deferred
 * backend). For a token method the cli materializes an HTTPS credential in `~/.git-credentials` so
 * git's `store` helper (enabled in the full image) authenticates clone/push. `self` (own creds) and
 * `deploy-key` (ADR-0173 ssh) need no token config. Never throws (ADR-0075).
 */
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { GitAuthMethod } from "@4pm/dto";

/** Host + credential username per token method (HTTPS git). Host overridable via env for GHE/self-managed. */
function tokenTarget(method: GitAuthMethod): { host: string; user: string } | null {
  if (method === "gitlab-group-token") {
    return { host: process.env.FOURPM_GIT_HOST || "gitlab.com", user: "oauth2" };
  }
  if (method === "github-app") {
    return { host: process.env.FOURPM_GIT_HOST || "github.com", user: "x-access-token" };
  }
  return null; // self / deploy-key — no HTTPS token credential to write
}

/**
 * Configure git auth for the served project's method. For a token method with `FOURPM_GIT_TOKEN`
 * present, write the `~/.git-credentials` line git's store helper reads; otherwise a no-op (the
 * worker uses its own creds / an ssh deploy key). Returns true when a credential was written.
 */
export function applyGitAuth(method: GitAuthMethod | null): boolean {
  if (!method) return false;
  const target = tokenTarget(method);
  const token = process.env.FOURPM_GIT_TOKEN;
  if (!target || !token) return false;
  try {
    const line = `https://${target.user}:${token}@${target.host}\n`;
    // Mode 0600 — the file holds a bearer token.
    writeFileSync(join(homedir(), ".git-credentials"), line, { encoding: "utf8", mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}
