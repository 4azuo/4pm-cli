/**
 * The agent's view of the worker tools under the uid separation: the tool trees the cli installs
 * (`~/.npm-global`, incl. a staged cli self-update, and `~/.4pm/tools`) are re-exposed to the agent, and an
 * AI CLI is judged present only when the **agent** can execute it — `ok` / `missing` / `blocked`. A blocked CLI
 * is repaired once (tree walk) and re-checked; one still blocked is logged and reported with the path that
 * blocks it. Every helper is a no-op (`ok`) while separation is off.
 * @adr 0502
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { logger } from "../../common/logger/logger";
import { agentAccessBlocker, agentCanRun, agentUser, exposeToAgent } from "../../utils/agent-user";

/** An AI CLI the cli can self-install. */
export type AiCliTool = "claude" | "codex";

/** Verdict on one AI CLI as seen by the agent. */
export type AgentAiCliStatus = { state: "ok" } | { state: "missing" } | { state: "blocked"; reason: string };

/** The marker that starts the line a dispatched AI run ends with when its CLI is blocked (read by the web). */
export const AI_CLI_NOT_RUNNABLE_MARKER = "[4PM] AI_CLI_NOT_RUNNABLE";

/** Commands the agent was seen to run this process — re-checked only after a tool install / at start. */
const runnable = new Set<string>();

/** The per-user tool dir for release binaries — on the `~/.4pm` volume in a container. */
export function toolBinDir(): string {
  return join(homedir(), ".4pm", "tools", "bin");
}

/** Map an AI-CLI command (as spawned) to its self-installable tool id, or null. */
export function aiToolOfCommand(cmd: string): AiCliTool | null {
  const base = cmd.split(/[\\/]/).pop() ?? cmd;
  if (/^claude(\.exe|\.cmd)?$/.test(base)) return "claude";
  if (/^codex(\.exe|\.cmd)?$/.test(base)) return "codex";
  return null;
}

/**
 * Give the tool trees the agent-runnable modes (cli-fs 0002 §4 rule 4): the release-binary dir and the runtime
 * npm prefix, including the staged cli self-update. Called at `start` and after every tool install / update /
 * uninstall; forgets the cached verdicts. A no-op when separation is off.
 */
export function exposeInstalledTools(): void {
  runnable.clear();
  if (!agentUser()) return;
  exposeToAgent(join(homedir(), ".4pm", "tools"));
  const prefix = process.env.NPM_CONFIG_PREFIX;
  if (prefix) exposeToAgent(prefix);
}

/** Whether `cmd` resolves on the cli's own PATH (a path is checked as given). */
function onPath(cmd: string): boolean {
  if (cmd.includes(sep)) return existsSync(cmd);
  return (process.env.PATH ?? "")
    .split(":")
    .filter(Boolean)
    .some((d) => existsSync(join(d, cmd)));
}

/**
 * Whether the agent can execute the AI CLI `cmd` (`claude`, `codex`, or a path to one): `missing` when the cli
 * cannot find it either (the ADR-0396 install path), `blocked` when it is there but the agent cannot run it —
 * after one repair walk — with the reason, else `ok` (cached for this process until the next install).
 */
export function agentAiCliStatus(cmd: string): AgentAiCliStatus {
  if (!agentUser() || runnable.has(cmd)) return { state: "ok" };
  if (!onPath(cmd)) return { state: "missing" };
  if (agentCanRun(cmd)) {
    runnable.add(cmd);
    return { state: "ok" };
  }
  exposeInstalledTools();
  if (agentCanRun(cmd)) {
    logger.info("agent.aiCli.repaired", { cmd });
    runnable.add(cmd);
    return { state: "ok" };
  }
  const reason = agentAccessBlocker(cmd) ?? `the agent user cannot execute ${cmd} (permissions)`;
  logger.warn("agent.aiCli.blocked", { cmd, reason });
  return { state: "blocked", reason };
}

/** The line a dispatched AI run ends with when its CLI is blocked. */
export function aiCliNotRunnableLine(cmd: string, reason: string): string {
  return `${AI_CLI_NOT_RUNNABLE_MARKER}: ${aiToolOfCommand(cmd) ?? cmd} — ${reason}\n`;
}

/**
 * Start-up check: each AI CLI in `cmds` that the cli has must be runnable by the agent (repaired once if not).
 * Returns the still-blocked ones with their reason, each also logged `agent.aiCli.unusable`.
 */
export function checkAgentAiClis(cmds: string[]): { cmd: string; reason: string }[] {
  const out: { cmd: string; reason: string }[] = [];
  for (const cmd of new Set(cmds)) {
    const status = agentAiCliStatus(cmd);
    if (status.state !== "blocked") continue;
    logger.warn("agent.aiCli.unusable", { cmd, reason: status.reason });
    out.push({ cmd, reason: status.reason });
  }
  return out;
}
