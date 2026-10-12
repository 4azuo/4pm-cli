/**
 * The worker's own gh / glab login, as the token source of Self-managed git auth. The login comes from a
 * host mount (`~/ai-creds/gh`, `~/ai-creds/glab`), else the worker's login dir (`GH_CONFIG_DIR` /
 * `GLAB_CONFIG_DIR` — `~/.4pm/gh|glab` in the container), else the tool's default dir. The cli (as `node`)
 * reads a host's token through the real tool on each request; the agent never reads the login dir.
 * @adr 0467
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { githubHostKind } from "@4pm/dto";

/** The tool a login belongs to. */
export type SelfTool = "gh" | "glab";

/** One host the worker's own login covers. */
export interface SelfLogin {
  tool: SelfTool;
  /** Lower-cased host, e.g. `github.com`, `gitlab.example.com`. */
  host: string;
  /** `github` / `ghe-cloud` / `ghes` for gh, `gitlab` for glab — picks the git username + shim env. */
  kind: string;
  /** The login dir the token is read from. */
  configDir: string;
  /** True when the login comes from a host mount under `~/ai-creds/`. */
  mounted: boolean;
}

/** Env vars that would make the tool print a caller token instead of the stored login's. */
const TOKEN_ENV = ["GH_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GITLAB_TOKEN"];

/** Give up on a token read after this long (git would otherwise wait on the helper). */
const TOKEN_TIMEOUT_MS = 10_000;

/** The candidate login dirs of a tool, in precedence order (mount first). */
function candidateDirs(tool: SelfTool): { dir: string; mounted: boolean }[] {
  const mount = join(homedir(), "ai-creds", tool);
  const own = tool === "gh" ? process.env.GH_CONFIG_DIR : process.env.GLAB_CONFIG_DIR;
  const fallback = tool === "gh" ? join(homedir(), ".config", "gh") : join(homedir(), ".config", "glab-cli");
  return [
    { dir: mount, mounted: true },
    ...(own ? [{ dir: own, mounted: false }] : []),
    { dir: fallback, mounted: false },
  ];
}

/** Read a file, or null when absent / unreadable. */
function readText(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** The hosts listed in a gh `hosts.yml` (its top-level keys). */
export function ghHostsOf(yaml: string): string[] {
  const out: string[] = [];
  for (const line of yaml.split(/\r?\n/)) {
    const m = /^([A-Za-z0-9.-]+(?::\d+)?):\s*$/.exec(line);
    if (m?.[1]) out.push(m[1].toLowerCase());
  }
  return out;
}

/** The hosts listed under `hosts:` in a glab `config.yml` (the keys one level below it). */
export function glabHostsOf(yaml: string): string[] {
  const out: string[] = [];
  let inHosts = false;
  let indent = -1;
  for (const line of yaml.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (/^hosts:\s*$/.test(line)) {
      inHosts = true;
      indent = -1;
      continue;
    }
    if (!inHosts) continue;
    const lead = line.length - line.trimStart().length;
    if (lead === 0) {
      inHosts = false;
      continue;
    }
    if (indent < 0) indent = lead;
    if (lead !== indent) continue;
    const m = /^\s+([A-Za-z0-9.-]+(?::\d+)?):\s*$/.exec(line);
    if (m?.[1]) out.push(m[1].toLowerCase());
  }
  return out;
}

/** The hosts of one tool's login, from the first candidate dir that lists any. */
function loginsOf(tool: SelfTool): SelfLogin[] {
  for (const { dir, mounted } of candidateDirs(tool)) {
    const text = readText(join(dir, tool === "gh" ? "hosts.yml" : "config.yml"));
    if (!text) continue;
    const hosts = tool === "gh" ? ghHostsOf(text) : glabHostsOf(text);
    if (hosts.length === 0) continue;
    return hosts.map((host) => ({
      tool,
      host,
      kind: tool === "gh" ? githubHostKind(host) : "gitlab",
      configDir: dir,
      mounted,
    }));
  }
  return [];
}

/** Every host the worker's own gh / glab login covers (gh first; a host listed by both keeps gh's). */
export function discoverSelfLogins(): SelfLogin[] {
  const out: SelfLogin[] = [];
  for (const login of [...loginsOf("gh"), ...loginsOf("glab")]) {
    if (!out.some((l) => l.host === login.host)) out.push(login);
  }
  return out;
}

/**
 * Read a host's token from the login through the real tool binary (`gh auth token --hostname`,
 * `glab config get token --host`), with only that login dir in the env. Null when the tool fails or the
 * login keeps its token elsewhere (e.g. the host's system keyring — not in a mounted folder).
 */
export function readSelfToken(login: SelfLogin, realBin: string, basePath: string): string | null {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: basePath };
  for (const k of TOKEN_ENV) delete env[k];
  if (login.tool === "gh") env.GH_CONFIG_DIR = login.configDir;
  else env.GLAB_CONFIG_DIR = login.configDir;
  const args =
    login.tool === "gh"
      ? ["auth", "token", "--hostname", login.host]
      : ["config", "get", "token", "--host", login.host];
  try {
    const out = execFileSync(realBin, args, {
      env,
      encoding: "utf8",
      timeout: TOKEN_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}
