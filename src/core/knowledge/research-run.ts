/**
 * research-run — the worker side of org AI Research. On a `research.ask` dispatch the cli
 * runs `claude` text-in → text-out with **read-only web tools only** (WebSearch / WebFetch), streaming
 * the answer back in chunks for the live SSE, under a strict content policy (the system prompt instructs
 * the model to return a `REFUSED:` line for disallowed questions). No file/shell/orchestration tools, an
 * empty throwaway working dir, and an allow-listed environment — the agent can look things up on the web
 * but never touch the worker or other systems. Usage is captured so the handler meters it to the org.
 * @adr 0380
 */
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { ResearchAttachmentPayload } from "@4pm/ws";
import { estimateTokens, type AiUsage } from "../ai/ai-stream";
import type { AiTextRunner } from "../ai/ai-text-run";
import { resolveCliPrompt } from "../ai/prompt-overrides";
import type { AiRunPolicy } from "../../utils/ai-cli";
import { makeAgentTempDir, unregisterAgentRoot } from "../../utils/agent-user";
import { writeFileInRootSync } from "../../utils/safe-path";

/** Max time a research run may take (ms) — it may search/read several pages before answering. */
const RESEARCH_TIMEOUT_MS = 9 * 60 * 1000;

/** Fixed agentic turn budget — a few turns to search + read + synthesize, bounded so it can't loop. */
const RESEARCH_MAX_TURNS = 16;

/** Zero usage — the fallback when a run captured no token counts. */
const NO_USAGE: AiUsage = { tokens: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };

/**
 * The tools the research agent may use (auto-approved); everything else is denied. When the question
 * carries attachments `Read` + `Glob` are added so the agent can read the files materialized
 * into its throwaway working dir (the only readable location) — see `toolArgs`.
 * @adr 0385
 */
const RESEARCH_ALLOWED_TOOLS = "WebSearch,WebFetch";
const RESEARCH_ATTACH_TOOLS = "WebSearch,WebFetch,Read,Glob";

/**
 * Every tool denied to the research agent — anything that touches the worker, other systems, or spawns
 * side-effecting work. Only WebSearch/WebFetch (allow-listed above) remain; with attachments, `Read`
 * and `Glob` are lifted (confined to the throwaway working dir).
 */
const RESEARCH_DENIED_BASE = [
  "Bash", "Edit", "Write", "Read", "Glob", "Grep", "NotebookEdit", "Task", "SlashCommand", "Skill",
  "ToolSearch", "TaskCreate", "TaskGet", "TaskList", "TaskOutput", "TaskStop", "TaskUpdate", "Monitor",
  "DesignSync", "CronCreate", "CronDelete", "CronList", "EnterWorktree", "ExitWorktree", "RemoteTrigger",
  "ScheduleWakeup", "SendMessage", "PushNotification",
];

/** A safe on-disk file name for one attachment (strip any path segments / unsafe chars). */
function safeAttachmentName(name: string, index: number): string {
  const base = (name || `file-${index + 1}`).replace(/[/\\]/g, "_").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
  return base || `file-${index + 1}`;
}

/**
 * The research system policy prepended to the user's question. It defines the task and the
 * STRICT content policy, and instructs the model to return a single `REFUSED:` line (parsed by the
 * research-guard) for a disallowed question.
 */
export function buildResearchPrompt(question: string): string {
  // Admin override (ADR-0381) for `cli.research.policy`, else the shared registry default; `question` is
  // wrapped as the member's request by the registry (ADR-0421).
  return resolveCliPrompt("cli.research.policy", { question });
}

/**
 * The research run policy: web tools only (+ `Read`/`Glob` of the scratch dir when attachments are
 * present), every other tool denied, the loop bounded. `--permission-mode default` is the non-variadic
 * terminator so the variadic tool flags consume only their own comma-token. claude only — the content
 * policy and tool fence are claude's.
 * @adr 0380 @adr 0385 @adr 0520
 */
function researchPolicy(hasAttachments: boolean): AiRunPolicy {
  return {
    args: (cmd) =>
      cmd.includes("claude")
        ? [
            `--max-turns=${RESEARCH_MAX_TURNS}`,
            "--allowedTools",
            hasAttachments ? RESEARCH_ATTACH_TOOLS : RESEARCH_ALLOWED_TOOLS,
            "--disallowedTools",
            (hasAttachments ? RESEARCH_DENIED_BASE.filter((t) => t !== "Read" && t !== "Glob") : RESEARCH_DENIED_BASE).join(","),
            "--permission-mode",
            "default",
          ]
        : null,
  };
}

/** Write the attachments into the scratch dir and point the prompt at them (best-effort per file). */
function attachFiles(cwd: string, prompt: string, attachments: ResearchAttachmentPayload[]): string {
  const lines: string[] = [];
  attachments.forEach((a, i) => {
    const file = join(cwd, safeAttachmentName(a.name, i));
    try {
      // Shared with the agent, which reads it (ADR-0487).
      writeFileInRootSync(cwd, file, Buffer.from(a.dataBase64, "base64"));
      lines.push(`- \`${file}\``);
    } catch {
      // best-effort — skip an attachment that fails to write
    }
  });
  return lines.length > 0
    ? `${prompt}\n\nThe user attached these files — use the Read tool to read them before answering:\n${lines.join("\n")}`
    : prompt;
}

/** The outcome of a research run: the answer text + its token usage (or a failure reason). */
export interface ResearchRunResult {
  text: string;
  usage: AiUsage;
  /** The provider that answered (metered per provider — ADR-0340), or null on failure. */
  workedCmd: string | null;
  error?: string;
}

/**
 * Run research through the shared AI path (every configured account, working-first, failover, account
 * lease) in an empty throwaway dir — the per-run scratch where attachments are written and the agent's
 * Read is confined. Streams readable deltas to `onChunk` as they arrive.
 * @adr 0520 @adr 0385
 */
export async function runResearch(
  question: string,
  run: AiTextRunner,
  onChunk: (delta: string) => void,
  attachments: ResearchAttachmentPayload[] = [],
): Promise<ResearchRunResult> {
  // Shared with the agent user when uid separation is on (ADR-0430) — it reads the attachments here.
  const cwd = makeAgentTempDir("4pm-research-");
  try {
    const prompt = attachFiles(cwd, buildResearchPrompt(question), attachments);
    const result = await run(prompt, {
      label: "research", source: "research",
      policy: researchPolicy(attachments.length > 0),
      cwd,
      timeoutMs: RESEARCH_TIMEOUT_MS,
      envKind: "research",
      onChunk,
    });
    if (!result.ok) return { text: "", usage: { ...NO_USAGE }, workedCmd: null, error: result.error ?? "failed" };
    const usage = result.usage.tokens > 0 ? result.usage : { ...NO_USAGE, tokens: estimateTokens(result.text) };
    return { text: result.text, usage, workedCmd: result.workedCmd };
  } finally {
    try {
      unregisterAgentRoot(cwd);
      rmSync(cwd, { recursive: true, force: true });
    } catch {
      // best-effort — an empty leftover temp dir is harmless
    }
  }
}
