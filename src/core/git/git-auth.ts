/**
 * Worker git-auth. For a project on the **GitHub App** method the daemon:
 *  - scopes a git **credential helper** (`git-credential` of the standalone agent helper — ADR-0499) to the App's host through its own process
 *    environment (`GIT_CONFIG_COUNT`/`KEY_n`/`VALUE_n`, git ≥ 2.31) — every git it spawns (first clone,
 *    scaffold, sync, agents, Console commands) inherits it, and no repo / global git config is written;
 *    it is the ONLY helper for that host (the machine's own helpers are reset for it);
 *  - puts a **`gh` shim** first on `PATH` that injects `GH_TOKEN` / `GH_ENTERPRISE_TOKEN` per call;
 *  - pulls short-lived installation tokens from the server over `git.token`, per **job scope**
 *    (`FOURPM_JOB_ID`, else the link's default scope), and **revokes** them when the scope ends.
 * GitLab methods use the same helper + a `glab` shim. **`self`** uses the same path, fed by the worker's own
 * gh / glab login (one helper per host it covers, host baked into the helper/shim): the cli reads that
 * login's token per request and the agent never reads the login dir; nothing is revoked (the operator's
 * own long-lived login). The rented ssh deploy key is separate (`GIT_SSH_COMMAND`). The App private key
 * never reaches the worker. Never throws.
 * @adr 0356 @adr 0075 @adr 0467 @adr 0499 @arch 0049
 */
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { delimiter, dirname, join, resolve } from "node:path";
import { githubHostKind, isGitLabMethod, type GitAuthMethod } from "@4pm/dto";
import type { GitTokenReply, GitTokenRequest } from "@4pm/ws";
import { logger } from "../../common/logger/logger";
import { prepareAgentRunDir, readOnlyForAgent } from "../../utils/agent-user";
import { agentHelperInvocation } from "../agent/agent-helper-install";
import { discoverSelfLogins, readSelfToken, type SelfLogin } from "./self-git-login";
import { GIT_HOST_ENV, GIT_HOST_KIND_ENV, PROFILE_DIR_ENV } from "./git-helper-env";

export { GIT_HOST_ENV, GIT_HOST_KIND_ENV, JOB_ID_ENV, PROFILE_DIR_ENV } from "./git-helper-env";
/** The link's default scope (git outside any job). */
export const DEFAULT_SCOPE = "link";
/** Revoke the default scope after this long without a request. */
const DEFAULT_SCOPE_IDLE_MS = 10 * 60 * 1000;

/** Sends one `git.token` request over the daemon's WS session. */
export type GitTokenTransport = (req: GitTokenRequest) => Promise<GitTokenReply>;

/** A token issued to this worker, remembered so the scope end can revoke it. */
interface IssuedToken {
  token: string;
  apiBase: string;
}

/** Module state — one served project per daemon. */
const state: {
  host: string | null;
  transport: GitTokenTransport | null;
  /** The env before this module changed it + how many GIT_CONFIG_* entries it added. */
  baseEnv: { count: number; path: string; added: number } | null;
  scopes: Map<string, IssuedToken[]>;
  defaultTimer: ReturnType<typeof setTimeout> | null;
  /** The worker's own logins while the project is on `self` (null otherwise). @adr 0467 */
  self: SelfLogin[] | null;
  /** Hosts already warned about (login without a readable token) — once per start. */
  warned: Set<string>;
  /** Ended scopes whose `revoked` report did not reach the server — re-sent on reconnect. @adr 0535 */
  pendingRevoked: Set<string>;
} = {
  host: null,
  transport: null,
  baseEnv: null,
  scopes: new Map(),
  defaultTimer: null,
  self: null,
  warned: new Set(),
  pendingRevoked: new Set(),
};

/**
 * The command git runs as the credential helper (`!` = run through the shell). A `self` helper names its
 * host + kind (several hosts may be active at once); the server-managed one reads them from the env.
 */
function helperCommand(fixed?: { host: string; kind: string }): string {
  return `!${agentHelperInvocation()} git-credential${fixed ? ` --host ${fixed.host} --kind ${fixed.kind}` : ""}`;
}

/** Find the real `gh` on PATH (skipping our shim dir); null when not installed. */
function findRealGh(pathValue: string, shimDir: string): string | null {
  for (const dir of pathValue.split(delimiter)) {
    if (!dir || dir === shimDir) continue;
    const candidate = join(dir, process.platform === "win32" ? "gh.exe" : "gh");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * The POSIX shim that injects the token into one `gh` call (a caller-set token wins). Server-managed: the
 * App host/kind come from the env; `self`: they are baked in (`fixed`).
 */
function shimScript(realGh: string, cli: string, fixed?: { host: string; kind: string }): string {
  const host = fixed ? fixed.host : `$${GIT_HOST_ENV}`;
  const kind = fixed ? fixed.kind : `$${GIT_HOST_KIND_ENV}`;
  const tokenCmd = fixed ? `${cli} git-token --host ${fixed.host}` : `${cli} git-token`;
  return `#!/bin/sh
# 4PM gh shim (ADR-0356/0467) — injects the served project's git token (App token, or the worker's own login).
if [ -z "$GH_TOKEN$GH_ENTERPRISE_TOKEN$GITHUB_TOKEN" ]; then
  T="$(${tokenCmd} 2>/dev/null)"
  if [ -n "$T" ]; then
    case "${kind}" in
      ghes) export GH_HOST="${host}" GH_ENTERPRISE_TOKEN="$T"; unset GH_TOKEN ;;
      ghe-cloud) export GH_HOST="${host}" GH_TOKEN="$T"; unset GH_ENTERPRISE_TOKEN ;;
      *) export GH_TOKEN="$T"; unset GH_ENTERPRISE_TOKEN ;;
    esac
  fi
fi
exec "${realGh}" "$@"
`;
}

/** Find the real `glab` on PATH (skipping our shim dir); null when not installed. */
function findRealGlab(pathValue: string, shimDir: string): string | null {
  for (const dir of pathValue.split(delimiter)) {
    if (!dir || dir === shimDir) continue;
    const candidate = join(dir, process.platform === "win32" ? "glab.exe" : "glab");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * The POSIX shim that injects the GitLab token into one `glab` call (a caller-set token wins). Server-managed:
 * the host comes from the env; `self`: it is baked in (`fixed`).
 */
function glabShimScript(realGlab: string, cli: string, fixedHost?: string): string {
  const host = fixedHost ?? `$${GIT_HOST_ENV}`;
  const tokenCmd = fixedHost ? `${cli} git-token --host ${fixedHost}` : `${cli} git-token`;
  return `#!/bin/sh
# 4PM glab shim (ADR-0382/0467) — injects the served project's GitLab token (server-held, or the worker's own login).
if [ -z "$GITLAB_TOKEN" ]; then
  T="$(${tokenCmd} 2>/dev/null)"
  if [ -n "$T" ]; then export GITLAB_HOST="${host}" GITLAB_TOKEN="$T"; fi
fi
exec "${realGlab}" "$@"
`;
}

/** Restore the env this module changed (helper config, PATH, host vars). */
function clearEnv(): void {
  if (!state.baseEnv) return;
  const { count, path, added } = state.baseEnv;
  for (let i = count; i < count + added; i++) {
    delete process.env[`GIT_CONFIG_KEY_${i}`];
    delete process.env[`GIT_CONFIG_VALUE_${i}`];
  }
  if (count > 0) process.env.GIT_CONFIG_COUNT = String(count);
  else delete process.env.GIT_CONFIG_COUNT;
  process.env.PATH = path;
  delete process.env[GIT_HOST_ENV];
  delete process.env[GIT_HOST_KIND_ENV];
  state.baseEnv = null;
  state.self = null;
}

/** Append GIT_CONFIG_* entries after the base count (git ≥ 2.31 reads them as config). */
function writeHelperEnv(baseCount: number, entries: [string, string][]): void {
  entries.forEach(([key, value], i) => {
    process.env[`GIT_CONFIG_KEY_${baseCount + i}`] = key;
    process.env[`GIT_CONFIG_VALUE_${baseCount + i}`] = value;
  });
  process.env.GIT_CONFIG_COUNT = String(baseCount + entries.length);
}

/**
 * The helper entries for one host: an empty value resets the helper list accumulated from system/global
 * config (e.g. `gh auth git-credential`, which git would otherwise ask first), then ours. Re-adding those
 * helpers after ours was rejected — on success git runs `store` on every helper, so a store/cache/keychain
 * helper would persist the token on disk.
 */
function hostHelperEntries(host: string, fixed?: { host: string; kind: string }): [string, string][] {
  const prefix = `credential.https://${host}`;
  return [
    [`${prefix}.helper`, ""],
    [`${prefix}.helper`, helperCommand(fixed)],
    [`${prefix}.useHttpPath`, "true"],
  ];
}

/**
 * Write (or remove) one tool's shim in the agent-readable run dir and return its dir; null when no shim was
 * written (tool not installed / Windows). Under uid separation the shims sit in the cli-owned run dir the
 * agent can execute but not change — the cli's own PATH uses them too.
 * @adr 0430 phase 2
 */
function writeShim(profileDir: string, tool: "gh" | "glab", basePath: string, content: ((real: string) => string) | null): string | null {
  if (process.platform === "win32") return null;
  const runDir = prepareAgentRunDir(profileDir);
  const shimDir = join(runDir ?? profileDir, "bin");
  const real = tool === "glab" ? findRealGlab(basePath, shimDir) : findRealGh(basePath, shimDir);
  if (!real || !content) {
    rmSync(join(shimDir, tool), { force: true });
    return null;
  }
  mkdirSync(shimDir, { recursive: true });
  if (runDir) readOnlyForAgent(shimDir, 0o2750);
  const shim = join(shimDir, tool);
  writeFileSync(shim, content(real), { encoding: "utf8", mode: 0o755 });
  chmodSync(shim, 0o755);
  return shimDir;
}

/** The real binary of a tool on the pre-shim PATH (null when not installed). */
function realToolOf(tool: "gh" | "glab", basePath: string): string | null {
  return tool === "glab" ? findRealGlab(basePath, "") : findRealGh(basePath, "");
}

/** Read a `self` login's token (null when the tool is missing or the login keeps no token in its dir). */
function selfToken(login: SelfLogin): string | null {
  const basePath = state.baseEnv?.path ?? process.env.PATH ?? "";
  const real = realToolOf(login.tool, basePath);
  return real ? readSelfToken(login, real, basePath) : null;
}

/** The worker's own logins that yield a token, with it — for the expiry / scope report (never sent). @adr 0680 */
export function selfLoginTokens(): { login: SelfLogin; token: string }[] {
  const out: { login: SelfLogin; token: string }[] = [];
  for (const login of discoverSelfLogins()) {
    const token = selfToken(login);
    if (token) out.push({ login, token });
  }
  return out;
}

/** Warn once per host when a login lists it but yields no token (keyring storage, or the tool is missing). */
function warnMissingToken(login: SelfLogin): void {
  if (state.warned.has(login.host)) return;
  state.warned.add(login.host);
  logger.warn("git.auth.self.no-token", {
    host: login.host,
    tool: login.tool,
    mounted: login.mounted,
    hint:
      login.tool === "gh"
        ? "gh lists this host but returned no token — if `gh auth status` on the host shows the keyring, log in again with `gh auth login --insecure-storage`, or run `gh auth login` inside the container"
        : "glab lists this host but returned no token — if glab keeps it in a keyring, store it in the config file, or run `glab auth login` inside the container",
  });
}

/**
 * Configure Self-managed git auth from the worker's own gh / glab login: one helper per host it holds a
 * token for and a shim per tool (GitHub: github.com preferred when gh covers several hosts). Re-applied only
 * when that set changes (checked on every `ws_token`, so a later in-container login is picked up). No login ⇒
 * nothing is configured (git keeps the worker's own setup, e.g. the ssh key).
 * @adr 0467
 */
function configureSelfGitAuth(profileDir: string): void {
  // Only hosts with a readable token get a helper — a helper resets the host's other helpers, and glab's
  // default config lists gitlab.com even before any login.
  const logins = discoverSelfLogins().filter((l) => {
    if (selfToken(l)) return true;
    if (l.mounted || l.tool === "gh") warnMissingToken(l);
    return false;
  });
  const sig = (l: SelfLogin[] | null): string => (l ?? []).map((x) => `${x.tool}:${x.host}:${x.configDir}`).join("|");
  if (state.self && sig(state.self) === sig(logins)) return;
  clearEnv();
  if (logins.length === 0) return;
  const baseCount = Number(process.env.GIT_CONFIG_COUNT ?? "0") || 0;
  const basePath = process.env.PATH ?? "";
  const entries = logins.flatMap((l) => hostHelperEntries(l.host, { host: l.host, kind: l.kind }));
  writeHelperEnv(baseCount, entries);
  state.baseEnv = { count: baseCount, path: basePath, added: entries.length };
  state.self = logins;
  process.env[PROFILE_DIR_ENV] = resolve(profileDir);
  const gh = logins.find((l) => l.tool === "gh" && l.host === "github.com") ?? logins.find((l) => l.tool === "gh");
  const glab = logins.find((l) => l.tool === "glab");
  const ghDir = writeShim(profileDir, "gh", basePath, gh ? (real) => shimScript(real, agentHelperInvocation(), gh) : null);
  const glabDir = writeShim(profileDir, "glab", basePath, glab ? (real) => glabShimScript(real, agentHelperInvocation(), glab.host) : null);
  const shimDir = ghDir ?? glabDir;
  if (shimDir) process.env.PATH = `${shimDir}${delimiter}${basePath}`;
  logger.info("git.auth.self", { hosts: logins.map((l) => l.host), mounted: logins.some((l) => l.mounted) });
}

/**
 * Dev only (`tsx src/index.ts`): git runs the helper from the repo cwd, where tsx can't find the cli's
 * tsconfig (path aliases) — point it there explicitly. The bundled dist needs nothing.
 */
function setDevTsconfig(): void {
  const script = process.argv[1];
  const devTsconfig = script ? resolve(dirname(script), "..", "tsconfig.json") : "";
  if (process.execArgv.some((a) => a.includes("tsx")) && devTsconfig && existsSync(devTsconfig) && !process.env.TSX_TSCONFIG_PATH) {
    process.env.TSX_TSCONFIG_PATH = devTsconfig;
  }
}

/**
 * Apply the served project's git-auth from the `ws_token` (method + App host). For a server-managed method
 * with a host, scope the helper + shim to it; otherwise (`self`, its alias `deploy-key`, none) undo any earlier
 * server-managed configuration (revoking what this worker still holds) and serve the worker's own gh / glab
 * login instead. Returns true when a server-managed path is active.
 */
export function configureGitAuth(
  method: GitAuthMethod | null,
  host: string | null | undefined,
  profileDir: string,
  transport: GitTokenTransport,
): boolean {
  try {
    // Both GitLab methods (group token — ADR-0382; service account per-job tokens — ADR-0435).
    const isGitlab = isGitLabMethod(method);
    const active = (method === "github-app" || isGitlab) && !!host;
    if (!active || (state.host && state.host !== host)) {
      if (state.host) void revokeAll();
      if (state.host) clearEnv();
      state.host = null;
    }
    if (!active) {
      setDevTsconfig();
      configureSelfGitAuth(profileDir);
      return false;
    }
    // Leaving `self`: drop its helpers/shims before the server-managed ones are written.
    if (state.self) clearEnv();

    state.transport = transport;
    if (state.host === host && state.baseEnv) return true;
    const baseCount = Number(process.env.GIT_CONFIG_COUNT ?? "0") || 0;
    const basePath = process.env.PATH ?? "";
    // The server-managed credential is the ONLY credential source for its host.
    const entries = hostHelperEntries(host);
    writeHelperEnv(baseCount, entries);
    state.baseEnv = { count: baseCount, path: basePath, added: entries.length };
    process.env[PROFILE_DIR_ENV] = resolve(profileDir);
    setDevTsconfig();
    process.env[GIT_HOST_ENV] = host;
    process.env[GIT_HOST_KIND_ENV] = isGitlab ? "gitlab" : githubHostKind(host);

    // Tool shim (POSIX only) — first on PATH so the agent's `gh` (GitHub) / `glab` (GitLab) picks up
    // the token. The other tool's stale shim is removed when the method switches.
    const tool = isGitlab ? "glab" : "gh";
    const shimDir = writeShim(profileDir, tool, basePath, (real) =>
      isGitlab ? glabShimScript(real, agentHelperInvocation()) : shimScript(real, agentHelperInvocation()),
    );
    writeShim(profileDir, isGitlab ? "gh" : "glab", basePath, null);
    if (shimDir) process.env.PATH = `${shimDir}${delimiter}${basePath}`;
    state.host = host;
    logger.info(isGitlab ? "git.auth.gitlab" : "git.auth.github-app", { host });
    return true;
  } catch (err) {
    logger.warn("git.auth.configure.failed", { error: String(err) });
    return false;
  }
}

/** The GitHub-App host the helper is currently scoped to (null = not on the App path) — ADR-0368 guard. */
export function appliedGitAuthHost(): string | null {
  return state.host;
}

/** Arm (or re-arm) the idle revoke of the default scope. */
function touchDefaultScope(): void {
  if (state.defaultTimer) clearTimeout(state.defaultTimer);
  state.defaultTimer = setTimeout(() => void endGitScope(DEFAULT_SCOPE), DEFAULT_SCOPE_IDLE_MS);
  state.defaultTimer.unref?.();
}

/**
 * Issue a token for `host`/`path` under `scope` (called by the control server for the helper / shim).
 * On `self` it is the worker's own login's token for that host. Null when no credential applies, the host
 * differs, or the server declines (git then falls back).
 */
export async function issueGitToken(scope: string, host: string, path: string): Promise<string | null> {
  try {
    // `self`: the worker's own login for that host — read per request, never revoked (ADR-0467).
    if (state.self) {
      const login = state.self.find((l) => l.host === host.toLowerCase());
      if (!login) return null;
      const token = selfToken(login);
      if (!token) warnMissingToken(login);
      return token;
    }
    if (!state.host || !state.transport || host.toLowerCase() !== state.host) return null;
    const s = scope || DEFAULT_SCOPE;
    const reply = await state.transport({ op: "issue", scope: s, repo: { host, path } });
    if (!reply.token) return null;
    const list = state.scopes.get(s) ?? [];
    // Only a GitHub token is revoked here (`DELETE /installation/token`); GitLab per-job tokens are revoked
    // by the server when the scope ends (ADR-0435), and a GitLab group token is never revoked by the cli.
    const apiBase = reply.hostKind === "gitlab" ? "" : (reply.apiBase ?? "");
    if (!list.some((t) => t.token === reply.token)) list.push({ token: reply.token, apiBase });
    state.scopes.set(s, list);
    if (s === DEFAULT_SCOPE) touchDefaultScope();
    return reply.token;
  } catch (err) {
    logger.warn("git.token.issue.failed", { error: String(err) });
    return null;
  }
}

/** The scope prefix of the cli's own PR-people token (assignees / reviewers) — never served to the agent. @adr 0671 */
export const PR_PEOPLE_SCOPE_PREFIX = "pr-people:";
/** The scope prefix of a CI proposal (server-chosen, minted with `workflows: write`). @adr 0606 */
export const CI_PROPOSE_SCOPE_PREFIX = "ci-propose:";
/** Privileged scopes: the token sockets serve one only while the cli itself runs that exact scope. */
const PRIVILEGED_PREFIXES = [PR_PEOPLE_SCOPE_PREFIX, CI_PROPOSE_SCOPE_PREFIX] as const;
/** The privileged scopes the cli is running right now (opened / closed around the run). */
const openPrivileged = new Set<string>();

/**
 * Let the token sockets serve the privileged `scope` while the cli's own run of it lasts (a CI proposal's push goes
 * through the git credential helper). Close it with `closePrivilegedScope`.
 * @adr 0672
 */
export function openPrivilegedScope(scope: string): void {
  openPrivileged.add(scope);
}

/** End the socket access of a privileged scope. @adr 0672 */
export function closePrivilegedScope(scope: string): void {
  openPrivileged.delete(scope);
}

/**
 * May a token socket (the agent's helper / shim) be served `scope`? A normal job scope yes; a privileged one
 * (`pr-people:`, `ci-propose:`) only while the cli runs that very scope — an agent naming one itself gets nothing.
 * @adr 0671 @adr 0672
 */
export function socketMayServe(scope: string): boolean {
  return !PRIVILEGED_PREFIXES.some((p) => scope.startsWith(p)) || openPrivileged.has(scope);
}

/**
 * A short-lived GitHub App token with only `issues` + `pull_requests` write for the PR-people step, under its own
 * `pr-people:<uuid>` scope (end it with `endGitScope`). Null off the App path (self-managed / GitLab use the
 * worker's own `gh` / `glab`) or when the server declines (e.g. the installation lacks `issues`).
 * @adr 0671
 */
export async function issuePeopleToken(host: string, path: string): Promise<{ token: string; apiBase: string; scope: string } | null> {
  if (state.self || !state.host || host.toLowerCase() !== state.host) return null;
  const scope = `${PR_PEOPLE_SCOPE_PREFIX}${randomUUID()}`;
  const token = await issueGitToken(scope, host, path);
  const apiBase = state.scopes.get(scope)?.find((t) => t.token === token)?.apiBase ?? "";
  if (!token || !apiBase) {
    await endGitScope(scope);
    return null;
  }
  return { token, apiBase, scope };
}

/** `DELETE {apiBase}/installation/token` with the token itself — best-effort. */
function revokeAtGithub(t: IssuedToken): Promise<void> {
  return new Promise((resolve) => {
    try {
      const req = httpsRequest(
        new URL(`${t.apiBase.replace(/\/+$/, "")}/installation/token`),
        {
          method: "DELETE",
          timeout: 10_000,
          headers: { Authorization: `token ${t.token}`, Accept: "application/vnd.github+json", "User-Agent": "4pm-cli" },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve());
        },
      );
      req.on("timeout", () => req.destroy());
      req.on("error", () => resolve());
      req.end();
    } catch {
      resolve();
    }
  });
}

/**
 * End a scope: revoke its tokens at GitHub and tell the server (which drops its copies). No-op for a
 * scope that never asked for a token.
 */
export async function endGitScope(scope: string): Promise<void> {
  const tokens = state.scopes.get(scope);
  if (!tokens) return;
  state.scopes.delete(scope);
  if (scope === DEFAULT_SCOPE && state.defaultTimer) {
    clearTimeout(state.defaultTimer);
    state.defaultTimer = null;
  }
  await Promise.all(tokens.filter((t) => t.apiBase).map((t) => revokeAtGithub(t)));
  await reportRevoked(scope);
}

/**
 * Tell the server a scope's tokens are revoked so it drops its cached copies. A report that cannot be
 * delivered is kept for `flushPendingRevoked` — a cached-but-revoked token would be re-served dead.
 * @adr 0535
 */
async function reportRevoked(scope: string): Promise<void> {
  if (!state.transport) return;
  try {
    await state.transport({ op: "revoked", scope });
    state.pendingRevoked.delete(scope);
  } catch (err) {
    state.pendingRevoked.add(scope);
    logger.warn("git.token.revoked.report.failed", { scope, error: String(err) });
  }
}

/**
 * Re-send the `revoked` reports lost while the server was unreachable (call on `ws.connected`). A scope that
 * holds tokens again is skipped — its own end reports it. Best-effort; failures stay pending.
 * @adr 0535
 */
export async function flushPendingRevoked(): Promise<void> {
  for (const scope of [...state.pendingRevoked]) {
    if (state.scopes.has(scope)) {
      state.pendingRevoked.delete(scope);
      continue;
    }
    await reportRevoked(scope);
  }
}

/** Revoke every scope this worker holds (method change / shutdown). */
export async function revokeAll(): Promise<void> {
  await Promise.all([...state.scopes.keys()].map((s) => endGitScope(s)));
}
