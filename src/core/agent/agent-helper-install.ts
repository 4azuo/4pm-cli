/**
 * Installs the standalone agent helper (`dist/agent-helper.js`) into the run dir at start and builds the
 * commands that invoke it: the git credential helper, the `gh` / `glab` shim token source and the ssh
 * `ProxyCommand` of agent processes. Agent processes therefore never execute the cli bundle, whose path and
 * file modes change with a self-update. Without a built helper (a `tsx` dev run) every command falls back
 * to re-entering the running cli. A start-up self-check runs the helper as the agent.
 * @adr 0499
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "../../common/logger/logger";
import { agentEnvOverrides, agentUser, asAgent, prepareAgentRunDir, readOnlyForAgent } from "../../utils/agent-user";
import { GIT_TOKEN_SOCKET_ENV } from "../git/git-helper-env";

/** File name of the installed helper — `.mjs` so node loads the ESM bundle without a package.json. */
const HELPER_FILE = "agent-helper.mjs";
/** How long the start-up self-check may take. */
const SELF_CHECK_TIMEOUT_MS = 15_000;

/** The installed helper path (null until installed, or when no built helper exists). */
let installedPath: string | null = null;

/** Shell-quote one argument for a `sh -c` command line (git `!` helpers, shims). */
function quote(s: string): string {
  return `"${s.replace(/(["\\$`])/g, "\\$1")}"`;
}

/**
 * The shell-quoted invocation of this very cli: node + its loader flags (e.g. tsx in dev) + the entry
 * script — the fallback when no standalone helper is installed.
 */
export function cliInvocation(): string {
  const script = process.argv[1];
  return [process.execPath, ...process.execArgv, ...(script ? [script] : [])].map(quote).join(" ");
}

/** The built helper next to the running bundle (`dist/agent-helper.js`), or null in a source run. */
function bundledHelper(): string | null {
  const path = join(dirname(fileURLToPath(import.meta.url)), "agent-helper.js");
  return existsSync(path) ? path : null;
}

/**
 * Copy the built helper into the agent-read-only run dir (`<run dir>/bin/`; `<profileDir>/bin/` when
 * separation is off) — atomically, so a git running meanwhile never reads a half-written file. Returns the
 * installed path, or null (fallback to the cli invocation) when there is no built helper or the copy fails.
 * `source` defaults to the built helper next to the running bundle.
 */
export function installAgentHelper(profileDir: string, source: string | null = bundledHelper()): string | null {
  installedPath = null;
  if (!source) return null;
  let tmp: string | null = null;
  try {
    const runDir = prepareAgentRunDir(profileDir);
    const binDir = join(runDir ?? profileDir, "bin");
    mkdirSync(binDir, { recursive: true });
    if (runDir) readOnlyForAgent(binDir, 0o2750);
    const target = join(binDir, HELPER_FILE);
    tmp = `${target}.${process.pid}.tmp`;
    copyFileSync(source, tmp);
    // The agent reads (never writes) it; off ⇒ the copy's own mode inside the private profile dir.
    readOnlyForAgent(tmp, 0o640);
    renameSync(tmp, target);
    installedPath = target;
  } catch (err) {
    logger.warn("agent.helper.install.failed", { error: String(err) });
    if (tmp) rmSync(tmp, { force: true });
  }
  return installedPath;
}

/** The installed helper path (null when the fallback is in use). */
export function agentHelperPath(): string | null {
  return installedPath;
}

/**
 * Shell-quoted command prefix that runs the helper; the caller appends the subcommand (`git-credential`,
 * `git-token`, …). The cli's own invocation (same subcommands) when no helper is installed.
 */
export function agentHelperInvocation(): string {
  return installedPath ? `${quote(process.execPath)} ${quote(installedPath)}` : cliInvocation();
}

/**
 * The ssh `ProxyCommand` value (`… net-connect %h %p`). It sits inside a double-quoted `-o` option of
 * `GIT_SSH_COMMAND`, so the helper form is used only for paths that need no quoting; else `4pm net-connect`.
 */
export function agentProxyCommand(): string {
  const plain = /^[A-Za-z0-9_./+-]+$/;
  if (installedPath && plain.test(process.execPath) && plain.test(installedPath)) {
    return `${process.execPath} ${installedPath} net-connect %h %p`;
  }
  return "4pm net-connect %h %p";
}

/**
 * Run `self-check` of the installed helper as the agent (separation on only): it must load and reach the
 * git-token socket. Logs `agent.helper.unusable` and returns the reason on failure; null when fine or skipped.
 */
export function verifyAgentHelper(): string | null {
  if (!agentUser() || !installedPath) return null;
  const run = asAgent(process.execPath, [installedPath, "self-check"]);
  const socket = process.env[GIT_TOKEN_SOCKET_ENV];
  try {
    const out = execFileSync(run.cmd, run.args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: SELF_CHECK_TIMEOUT_MS,
      env: { PATH: process.env.PATH ?? "", ...agentEnvOverrides(), ...(socket ? { [GIT_TOKEN_SOCKET_ENV]: socket } : {}) },
    });
    if (out.trim() === "ok") return null;
    throw new Error(`unexpected output: ${out.trim().slice(0, 200)}`);
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    const reason = (e.stderr?.trim() || e.message || String(err)).slice(0, 500);
    logger.error("agent.helper.unusable", { path: installedPath, reason });
    return reason;
  }
}
