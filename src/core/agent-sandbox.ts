/**
 * agent-sandbox (ADR-0346) — hardening helpers for the system-dispatched agent runs that see untrusted
 * text (AI-Help questions, support-ticket bodies): an **allow-listed environment** for the AI CLI child
 * (so the cli's own secrets — pairing / git tokens and anything else in `process.env` — never reach the
 * agent) and **per-command git auth** (`http.extraHeader`) so a repo token is never written into a
 * clone's `.git/config` where the agent could read it.
 */

/** Exact env names the AI CLI legitimately needs (runtime, locale, TLS/proxy, Windows basics). */
const ENV_ALLOW = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "TERM",
  "TZ",
  "TMPDIR",
  "TMP",
  "TEMP",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "all_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "PROGRAMFILES",
]);

/** Env prefixes the AI CLI legitimately needs (locale, XDG dirs, provider auth/config). */
const ENV_ALLOW_PREFIXES = ["LC_", "XDG_", "ANTHROPIC_", "CLAUDE_", "CODEX_", "OPENAI_", "AWS_", "GOOGLE_", "CLOUD_ML_", "VERTEX_"];

/**
 * Build the AI CLI child's environment from an allow-list of the cli's own env, plus the profile's
 * configured `aiEnv` and the account selector (e.g. `CLAUDE_CONFIG_DIR`). Everything else — notably
 * `FOURPM_*` secrets — is dropped.
 */
export function agentEnv(extraEnv?: Record<string, string>, overrides?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (ENV_ALLOW.has(key) || ENV_ALLOW_PREFIXES.some((p) => key.startsWith(p))) env[key] = value;
  }
  return { ...env, ...extraEnv, ...overrides };
}

/**
 * `git -c` args that authenticate ONE command with a Basic auth header built from `user:password`
 * (e.g. `x-access-token:<token>` for a GitHub App token), so the token is never persisted in the
 * clone's remote URL / config. Empty when there is no token.
 */
export function gitAuthArgs(user: string, password: string): string[] {
  if (!user && !password) return [];
  const basic = Buffer.from(`${user}:${password}`).toString("base64");
  return ["-c", `http.extraHeader=Authorization: Basic ${basic}`];
}
