/**
 * Worker git-auth (ADR-0356, arch 0049). For a project on the **GitHub App** method the daemon:
 *  - scopes a git **credential helper** (`4pm git-credential`) to the App's host through its own process
 *    environment (`GIT_CONFIG_COUNT`/`KEY_n`/`VALUE_n`, git ≥ 2.31) — every git it spawns (first clone,
 *    scaffold, sync, agents, Console commands) inherits it, and no repo / global git config is written;
 *    it is the ONLY helper for that host (the machine's own helpers are reset for it);
 *  - puts a **`gh` shim** first on `PATH` that injects `GH_TOKEN` / `GH_ENTERPRISE_TOKEN` per call;
 *  - pulls short-lived installation tokens from the server over `git.token`, per **job scope**
 *    (`FOURPM_JOB_ID`, else the link's default scope), and **revokes** them when the scope ends.
 * `self` (own creds / the rented ssh deploy key) configures nothing. The App private key never reaches
 * the worker. Never throws (ADR-0075).
 */
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { delimiter, dirname, join, resolve } from "node:path";
import { githubHostKind, type GitAuthMethod } from "@4pm/dto";
import type { GitTokenReply, GitTokenRequest } from "@4pm/ws";
import { logger } from "../common/logger/logger";

/** Env var carrying the job scope to the helper / shim (set per dispatched process). */
export const JOB_ID_ENV = "FOURPM_JOB_ID";
/** Env var telling the helper / shim which profile's control socket to ask. */
export const PROFILE_DIR_ENV = "FOURPM_PROFILE_DIR";
/** Env vars naming the App host + its kind (read by the shim + `4pm git-token`). */
export const GIT_HOST_ENV = "FOURPM_GIT_HOST";
export const GIT_HOST_KIND_ENV = "FOURPM_GIT_HOST_KIND";
/** The link's default scope (git outside any job). */
export const DEFAULT_SCOPE = "link";
/** Number of GIT_CONFIG_* entries this module adds (helper reset + helper + useHttpPath). */
const HELPER_ENV_ENTRIES = 3;
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
  baseEnv: { count: number; path: string } | null;
  scopes: Map<string, IssuedToken[]>;
  defaultTimer: ReturnType<typeof setTimeout> | null;
} = { host: null, transport: null, baseEnv: null, scopes: new Map(), defaultTimer: null };

/**
 * The shell-quoted invocation of this very cli: node + its loader flags (e.g. tsx in dev) + the entry
 * script, all absolute — so git / the shim re-enter the same build regardless of PATH.
 */
function cliInvocation(): string {
  const quote = (s: string): string => `"${s.replace(/(["\\$`])/g, "\\$1")}"`;
  const script = process.argv[1];
  return [process.execPath, ...process.execArgv, ...(script ? [script] : [])].map(quote).join(" ");
}

/** The command git runs as the credential helper (`!` = run through the shell). */
function helperCommand(): string {
  return `!${cliInvocation()} git-credential`;
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

/** The POSIX shim that injects the App token into one `gh` call (a caller-set token wins). */
function shimScript(realGh: string, cli: string): string {
  return `#!/bin/sh
# 4PM gh shim (ADR-0356) — injects a short-lived GitHub-App token for the served project.
if [ -z "$GH_TOKEN$GH_ENTERPRISE_TOKEN$GITHUB_TOKEN" ]; then
  T="$(${cli} git-token 2>/dev/null)"
  if [ -n "$T" ]; then
    case "$${GIT_HOST_KIND_ENV}" in
      ghes) export GH_HOST="$${GIT_HOST_ENV}" GH_ENTERPRISE_TOKEN="$T"; unset GH_TOKEN ;;
      ghe-cloud) export GH_HOST="$${GIT_HOST_ENV}" GH_TOKEN="$T"; unset GH_ENTERPRISE_TOKEN ;;
      *) export GH_TOKEN="$T"; unset GH_ENTERPRISE_TOKEN ;;
    esac
  fi
fi
exec "${realGh}" "$@"
`;
}

/** Restore the env this module changed (helper config, PATH, host vars). */
function clearEnv(): void {
  if (!state.baseEnv) return;
  const { count, path } = state.baseEnv;
  for (let i = count; i < count + HELPER_ENV_ENTRIES; i++) {
    delete process.env[`GIT_CONFIG_KEY_${i}`];
    delete process.env[`GIT_CONFIG_VALUE_${i}`];
  }
  if (count > 0) process.env.GIT_CONFIG_COUNT = String(count);
  else delete process.env.GIT_CONFIG_COUNT;
  process.env.PATH = path;
  delete process.env[GIT_HOST_ENV];
  delete process.env[GIT_HOST_KIND_ENV];
  state.baseEnv = null;
}

/**
 * Apply the served project's git-auth from the `ws_token` (method + App host). For `github-app` with a
 * host, scope the helper + shim to it; otherwise undo any earlier configuration (and revoke what this
 * worker still holds). Returns true when the GitHub App path is active.
 */
export function configureGitAuth(
  method: GitAuthMethod | null,
  host: string | null | undefined,
  profileDir: string,
  transport: GitTokenTransport,
): boolean {
  try {
    const active = method === "github-app" && !!host;
    if (!active || (state.host && state.host !== host)) {
      if (state.host) void revokeAll();
      clearEnv();
      state.host = null;
    }
    if (!active) return false;

    state.transport = transport;
    if (state.host === host && state.baseEnv) return true;
    const baseCount = Number(process.env.GIT_CONFIG_COUNT ?? "0") || 0;
    state.baseEnv = { count: baseCount, path: process.env.PATH ?? "" };
    const prefix = `credential.https://${host}`;
    // The App is the ONLY credential source for its host: an empty value resets the helper list
    // accumulated from system/global config (e.g. `gh auth git-credential`, which git would otherwise
    // ask first), then ours. Re-adding those helpers after ours was rejected — on success git runs
    // `store` on every helper, so a store/cache/keychain helper would persist the App token on disk.
    const entries: [string, string][] = [
      [`${prefix}.helper`, ""],
      [`${prefix}.helper`, helperCommand()],
      [`${prefix}.useHttpPath`, "true"],
    ];
    entries.forEach(([key, value], i) => {
      process.env[`GIT_CONFIG_KEY_${baseCount + i}`] = key;
      process.env[`GIT_CONFIG_VALUE_${baseCount + i}`] = value;
    });
    process.env.GIT_CONFIG_COUNT = String(baseCount + HELPER_ENV_ENTRIES);
    process.env[PROFILE_DIR_ENV] = resolve(profileDir);
    // Dev only (`tsx src/index.ts`): git runs the helper from the repo cwd, where tsx can't find the
    // cli's tsconfig (path aliases) — point it there explicitly. The bundled dist needs nothing.
    const script = process.argv[1];
    const devTsconfig = script ? resolve(dirname(script), "..", "tsconfig.json") : "";
    if (process.execArgv.some((a) => a.includes("tsx")) && devTsconfig && existsSync(devTsconfig) && !process.env.TSX_TSCONFIG_PATH) {
      process.env.TSX_TSCONFIG_PATH = devTsconfig;
    }
    process.env[GIT_HOST_ENV] = host;
    process.env[GIT_HOST_KIND_ENV] = githubHostKind(host);

    // gh shim (POSIX only) — first on PATH so agents' `gh` picks up the token.
    if (process.platform !== "win32") {
      const shimDir = join(profileDir, "bin");
      const realGh = findRealGh(state.baseEnv.path, shimDir);
      if (realGh) {
        mkdirSync(shimDir, { recursive: true });
        const shim = join(shimDir, "gh");
        writeFileSync(shim, shimScript(realGh, cliInvocation()), { encoding: "utf8", mode: 0o755 });
        chmodSync(shim, 0o755);
        process.env.PATH = `${shimDir}${delimiter}${state.baseEnv.path}`;
      } else {
        rmSync(join(shimDir, "gh"), { force: true });
      }
    }
    state.host = host;
    logger.info("git.auth.github-app", { host });
    return true;
  } catch (err) {
    logger.warn("git.auth.configure.failed", { error: String(err) });
    return false;
  }
}

/** Arm (or re-arm) the idle revoke of the default scope. */
function touchDefaultScope(): void {
  if (state.defaultTimer) clearTimeout(state.defaultTimer);
  state.defaultTimer = setTimeout(() => void endGitScope(DEFAULT_SCOPE), DEFAULT_SCOPE_IDLE_MS);
  state.defaultTimer.unref?.();
}

/**
 * Issue a token for `host`/`path` under `scope` (called by the control server for the helper / shim).
 * Null when the App is not active, the host differs, or the server declines (git then falls back).
 */
export async function issueGitToken(scope: string, host: string, path: string): Promise<string | null> {
  try {
    if (!state.host || !state.transport || host.toLowerCase() !== state.host) return null;
    const s = scope || DEFAULT_SCOPE;
    const reply = await state.transport({ op: "issue", scope: s, repo: { host, path } });
    if (!reply.token) return null;
    const list = state.scopes.get(s) ?? [];
    if (!list.some((t) => t.token === reply.token)) list.push({ token: reply.token, apiBase: reply.apiBase ?? "" });
    state.scopes.set(s, list);
    if (s === DEFAULT_SCOPE) touchDefaultScope();
    return reply.token;
  } catch (err) {
    logger.warn("git.token.issue.failed", { error: String(err) });
    return null;
  }
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
  try {
    await state.transport?.({ op: "revoked", scope });
  } catch {
    // The server's link backstop (disconnect/detach) revokes whatever it still holds.
  }
}

/** Revoke every scope this worker holds (method change / shutdown). */
export async function revokeAll(): Promise<void> {
  await Promise.all([...state.scopes.keys()].map((s) => endGitScope(s)));
}
