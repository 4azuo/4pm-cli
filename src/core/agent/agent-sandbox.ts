/**
 * agent-sandbox — hardening helpers for agent runs: an **allow-listed environment** for
 * every AI CLI child (so the cli's own secrets — pairing / git tokens and anything else in `process.env`
 * — never reach the agent; `projectAgentEnv` adds what a project run needs) and **per-command git auth**
 * (`http.extraHeader`) so a repo token is never written into a clone's `.git/config` where the agent
 * could read it.
 * @adr 0346 @adr 0421
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
  // AWS: only region/profile + the Bedrock API key — never `AWS_*` wholesale, which would hand
  // the agent static keys or the ECS task-role credential URI. Other AWS creds go through `aiEnv`.
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "AWS_PROFILE",
  "AWS_BEARER_TOKEN_BEDROCK",
]);

/** Env prefixes the AI CLI legitimately needs (locale, XDG dirs, provider auth/config). `AWS_` is NOT a prefix. */
const ENV_ALLOW_PREFIXES = ["LC_", "XDG_", "ANTHROPIC_", "CLAUDE_", "CODEX_", "OPENAI_", "GOOGLE_", "CLOUD_ML_", "VERTEX_"];

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
 * Extra exact env names a project AI run needs on top of {@link ENV_ALLOW}: the git-auth
 * pointers of ADR-0356/0382 (they name the credential helper + control socket and carry no token — the
 * agent's own git/gh/glab lose auth without them) and the common toolchain locations a build/test uses.
 */
const PROJECT_ENV_ALLOW = new Set([
  "GIT_CONFIG_COUNT",
  "FOURPM_PROFILE_DIR",
  "FOURPM_GIT_HOST",
  "FOURPM_GIT_HOST_KIND",
  "SSH_AUTH_SOCK",
  // The token-only git socket + the deploy-key ssh command for an agent-run git (ADR-0430 phase 2).
  "FOURPM_GIT_TOKEN_SOCKET",
  "GIT_SSH_COMMAND",
  // gh / glab login dirs (a container keeps them in the persistent volume — ADR-0428).
  "GH_CONFIG_DIR",
  "GLAB_CONFIG_DIR",
  "JAVA_HOME",
  "GOPATH",
  "GOROOT",
  "CARGO_HOME",
  "RUSTUP_HOME",
  "PNPM_HOME",
  "NVM_DIR",
  "VIRTUAL_ENV",
  "PYENV_ROOT",
  "GRADLE_USER_HOME",
  "ANDROID_HOME",
  "ANDROID_SDK_ROOT",
  "DOTNET_ROOT",
  "BUN_INSTALL",
  "DENO_DIR",
  "NPM_CONFIG_PREFIX",
]);

/** Extra env prefixes a project AI run needs: the `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n` pairs. */
const PROJECT_ENV_ALLOW_PREFIXES = ["GIT_CONFIG_KEY_", "GIT_CONFIG_VALUE_"];

/**
 * The base environment for an AI run inside a project folder: {@link agentEnv} plus the
 * git-auth pointers and toolchain locations of the cli's own env. The caller layers the profile's
 * `aiEnv` + account selector on top; everything else (notably `FOURPM_PAIR_TOKEN`) is dropped.
 */
export function projectAgentEnv(): NodeJS.ProcessEnv {
  const env = agentEnv();
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (PROJECT_ENV_ALLOW.has(key) || PROJECT_ENV_ALLOW_PREFIXES.some((p) => key.startsWith(p))) env[key] = value;
  }
  return env;
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
