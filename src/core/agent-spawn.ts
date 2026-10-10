/**
 * Spawn helpers for the agent uid separation (ADR-0430 phase 1). Two rules, both no-ops while
 * separation is off (no `FOURPM_AGENT_USER`):
 *
 * - `execInProject` — the drop-in for `promisify(execFile)` in modules that run git / scripts: a process
 *   whose `cwd` is inside a registered agent root (the workspaces, a shared temp dir) runs as the agent
 *   with an allow-listed environment (the cli's secrets never sit in an agent-readable `/proc/<pid>/environ`);
 *   everything else runs exactly as before.
 * - `agentSpawnArgs` — every AI CLI spawn (claude/codex — dispatch, pool runs, probes, login) always runs
 *   as the agent, whatever its working dir.
 */
import { execFile, type ExecFileOptions } from "node:child_process";
import { promisify } from "node:util";
import { projectAgentEnv } from "./agent-sandbox";
import { agentEnvOverrides, agentUser, asAgent, isAgentCwd } from "../utils/agent-user";
import { prepareCredentialDir } from "../utils/ai-cred-mount";

const execFileP = promisify(execFile);

/** The caller-intended additions of an env (keys absent from, or different to, the cli's own env). */
function callerAdditions(env: NodeJS.ProcessEnv | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!env) return out;
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined && process.env[k] !== v) out[k] = v;
  }
  return out;
}

/** The environment an agent-run project process gets: allow-listed + the caller's additions + agent HOME. */
export function agentProcessEnv(env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  return { ...projectAgentEnv(), ...callerAdditions(env), ...agentEnvOverrides() };
}

/** The folder a command really works in: `git -C <dir>` targets `<dir>` regardless of the spawn's `cwd`. */
function effectiveCwd(cmd: string, args: readonly string[], cwd: string | undefined): string | undefined {
  if (cmd === "git") {
    const i = args.indexOf("-C");
    if (i >= 0 && typeof args[i + 1] === "string") return args[i + 1];
  }
  return cwd;
}

/** Options accepted by {@link execInProject} (a `promisify(execFile)` superset, incl. buffer encoding). */
type ExecOpts = ExecFileOptions & { encoding?: BufferEncoding | "buffer" | null };

/**
 * `promisify(execFile)` that runs the process as the agent when its `cwd` is inside an agent root
 * (ADR-0430): git hooks, repo config, filters and build scripts then execute with the agent's uid, never
 * the cli's. Same resolved value / rejection shape as `promisify(execFile)`.
 */
export function execInProject(
  cmd: string,
  args: readonly string[],
  opts: ExecOpts = {},
): Promise<{ stdout: string; stderr: string }> {
  const cwd = effectiveCwd(cmd, args, typeof opts.cwd === "string" ? opts.cwd : opts.cwd?.toString());
  if (!agentUser() || !isAgentCwd(cwd)) {
    return execFileP(cmd, [...args], opts as ExecFileOptions) as unknown as Promise<{ stdout: string; stderr: string }>;
  }
  const w = asAgent(cmd, [...args]);
  return execFileP(w.cmd, w.args, { ...opts, env: agentProcessEnv(opts.env) } as ExecFileOptions) as unknown as Promise<{
    stdout: string;
    stderr: string;
  }>;
}

/** The env vars that select an AI CLI's credential dir (ADR-0199) — prepared for the agent before a spawn. */
const CREDENTIAL_DIR_VARS = ["CLAUDE_CONFIG_DIR", "CODEX_HOME"] as const;

/**
 * The command, args and env for an AI CLI spawn (ADR-0430): always the agent while separation is on —
 * the env (already allow-listed by the caller) gets the agent's HOME/USER, and the credential dir it
 * selects is made usable by the agent (phase 3). Unchanged when off.
 */
export function agentSpawnArgs(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): { cmd: string; args: string[]; env: NodeJS.ProcessEnv } {
  if (!agentUser()) return { cmd, args, env };
  for (const name of CREDENTIAL_DIR_VARS) {
    const dir = env[name];
    if (dir) prepareCredentialDir(dir);
  }
  const w = asAgent(cmd, args);
  return { cmd: w.cmd, args: w.args, env: { ...env, ...agentEnvOverrides() } };
}

/**
 * The command, args and env for a `spawn` in `cwd` (ADR-0430): as the agent with an allow-listed env when
 * `cwd` is inside an agent root, else unchanged — the `spawn` counterpart of {@link execInProject}.
 */
export function projectSpawnArgs(
  cmd: string,
  args: string[],
  cwd: string | undefined,
  env: NodeJS.ProcessEnv | undefined,
): { cmd: string; args: string[]; env: NodeJS.ProcessEnv | undefined } {
  if (!agentUser() || !isAgentCwd(cwd)) return { cmd, args, env };
  const w = asAgent(cmd, args);
  return { cmd: w.cmd, args: w.args, env: agentProcessEnv(env) };
}
