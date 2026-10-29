/**
 * The expiry and scopes of the worker's own gh / glab login tokens (Self-managed git auth), reported in
 * `machine.status.gitLogins` so the project's credential health can warn about a token that never expires, expires
 * soon or holds admin rights. Read from the provider API with the token — the token itself is never reported. Cached
 * for 6 hours; a provider that does not answer leaves that login out.
 * @adr 0680
 */
import type { GitLoginReport } from "@4pm/ws";
import { selfLoginTokens } from "./git-auth";

/** How long a report is reused. */
const TTL_MS = 6 * 3600_000;
/** Per-request timeout of the provider call. */
const TIMEOUT_MS = 8_000;

let cached: GitLoginReport[] = [];
let readAt = 0;
let reading: Promise<void> | null = null;

/** The last report; starts a background refresh when it is older than the TTL. */
export function selfGitLoginReports(): GitLoginReport[] {
  if (!reading && Date.now() - readAt > TTL_MS) {
    readAt = Date.now();
    reading = refresh().finally(() => {
      reading = null;
    });
  }
  return cached;
}

/** Re-read every login's token info. */
async function refresh(): Promise<void> {
  const out: GitLoginReport[] = [];
  for (const { login, token } of selfLoginTokens()) {
    const report = login.tool === "gh" ? await githubInfo(login.host, token) : await gitlabInfo(login.host, token);
    if (report) out.push(report);
  }
  cached = out;
}

/** GET with the token; null on a network error or a non-2xx answer. */
async function get(url: string, auth: Record<string, string>): Promise<Response | null> {
  try {
    const res = await fetch(url, { headers: { ...auth, accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    return res.ok ? res : null;
  } catch {
    return null;
  }
}

/**
 * GitHub: `GET /user` — `X-OAuth-Scopes` lists a classic / OAuth token's scopes, `GitHub-Authentication-Token-Expiration`
 * a PAT's expiry (absent ⇒ the token does not expire, e.g. an OAuth token from `gh auth login`).
 */
export async function githubInfo(host: string, token: string): Promise<GitLoginReport | null> {
  const api = host === "github.com" ? "https://api.github.com" : `https://${host}/api/v3`;
  const res = await get(`${api}/user`, { authorization: `token ${token}` });
  if (!res) return null;
  const scopesHeader = res.headers.get("x-oauth-scopes");
  const expiry = res.headers.get("github-authentication-token-expiration");
  const expiresAt = expiry ? new Date(expiry.replace(" UTC", "Z").replace(" ", "T")).toISOString() : null;
  return {
    tool: "gh",
    host,
    expiresAt,
    ...(scopesHeader !== null ? { scopes: scopesHeader.split(",").map((s) => s.trim()).filter(Boolean) } : {}),
  };
}

/** GitLab: `GET /api/v4/personal_access_tokens/self` — `expires_at` (null = never) and `scopes`. */
export async function gitlabInfo(host: string, token: string): Promise<GitLoginReport | null> {
  const res = await get(`https://${host}/api/v4/personal_access_tokens/self`, { "private-token": token });
  if (!res) return null;
  const body = (await res.json().catch(() => null)) as { expires_at?: unknown; scopes?: unknown } | null;
  if (!body) return null;
  return {
    tool: "glab",
    host,
    expiresAt: typeof body.expires_at === "string" && body.expires_at ? new Date(body.expires_at).toISOString() : null,
    ...(Array.isArray(body.scopes) ? { scopes: body.scopes.filter((s): s is string => typeof s === "string") } : {}),
  };
}
