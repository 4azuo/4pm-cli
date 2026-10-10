/**
 * research-run — the worker side of org AI Research. On a `research.ask` dispatch the cli
 * runs `claude` text-in → text-out with **read-only web tools only** (WebSearch / WebFetch), streaming
 * the answer back in chunks for the live SSE, under a strict content policy (the system prompt instructs
 * the model to return a `REFUSED:` line for disallowed questions). No file/shell/orchestration tools, an
 * empty throwaway working dir, and an allow-listed environment — the agent can look things up on the web
 * but never touch the worker or other systems. Usage is captured so the handler meters it to the org.
 * @adr 0380
 */
import { spawn } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ResearchAttachmentPayload } from "@4pm/ws";
import { createAiStreamParser, estimateTokens, type AiUsage } from "../ai/ai-stream";
import { agentEnv } from "../agent/agent-sandbox";
import { denySettingsArgs } from "../../utils/agent-deny";
import { strictMcpArgs } from "../../utils/agent-mcp";
import { resolveCliPrompt } from "../ai/prompt-overrides";
import type { ResolvedClaudeProfile } from "../../utils/ai-cli";
import { agentSpawnArgs } from "../agent/agent-spawn";
import { makeAgentTempDir, unregisterAgentRoot } from "../../utils/agent-user";

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

/** How to run claude for research — the operator's configured profiles (working-first). @adr 0057 */
export interface ResearchAi {
  cmd: string;
  profiles: ResolvedClaudeProfile[];
  env?: Record<string, string>;
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

/** One research `claude` attempt: web tools only, streaming each readable delta to `onChunk`. */
function runClaudeOnce(
  cmd: string,
  profile: ResolvedClaudeProfile | null,
  prompt: string,
  extraEnv: Record<string, string> | undefined,
  onChunk: (delta: string) => void,
  denyDirs: string[],
  attachments: ResearchAttachmentPayload[],
): Promise<{ code: number; out: string; err: string; usage: AiUsage }> {
  return new Promise((resolve, reject) => {
    const isClaude = cmd.includes("claude");
    // Empty throwaway dir (the per-run scratch — ADR-0385): attachments are written here and the agent's
    // Read is confined to it, so a project-less run never touches a project folder or the wider machine.
    // Shared with the agent user when uid separation is on (ADR-0430) — it reads the attachments here.
    const cwd = makeAgentTempDir("4pm-research-");
    const hasAttachments = attachments.length > 0;
    let finalPrompt = prompt;
    if (hasAttachments) {
      const lines: string[] = [];
      attachments.forEach((a, i) => {
        const file = join(cwd, safeAttachmentName(a.name, i));
        try {
          writeFileSync(file, Buffer.from(a.dataBase64, "base64"));
          lines.push(`- \`${file}\``);
        } catch {
          // best-effort — skip an attachment that fails to write
        }
      });
      if (lines.length > 0) {
        finalPrompt = `${prompt}\n\nThe user attached these files — use the Read tool to read them before answering:\n${lines.join("\n")}`;
      }
    }
    const args = [
      "-p",
      ...(profile?.model ? ["--model", profile.model] : []),
      ...(isClaude ? ["--output-format", "stream-json", "--verbose"] : []),
      // Secret-path deny rules (ADR-0347) — reads are not confined to the working dir.
      // No MCP server on this run (ADR-0427): repo/user MCP config is ignored.
      ...strictMcpArgs(cmd),
      ...denySettingsArgs(cmd, [...denyDirs, profile?.dir]),
      // Web-only agent (+ Read/Glob of the scratch dir when attachments are present): allow the tool set,
      // deny everything else, bound the loop. `--permission-mode default` is the non-variadic terminator
      // (so the variadic tool flags consume only their own comma-token — same trick as the other runners).
      ...(isClaude
        ? [
            `--max-turns=${RESEARCH_MAX_TURNS}`,
            "--allowedTools",
            hasAttachments ? RESEARCH_ATTACH_TOOLS : RESEARCH_ALLOWED_TOOLS,
            "--disallowedTools",
            (hasAttachments ? RESEARCH_DENIED_BASE.filter((t) => t !== "Read" && t !== "Glob") : RESEARCH_DENIED_BASE).join(","),
            "--permission-mode",
            "default",
          ]
        : []),
    ];
    const env = agentEnv(extraEnv, profile ? { CLAUDE_CONFIG_DIR: profile.dir } : undefined, { kind: "research" });
    const cleanup = (): void => {
      try {
        unregisterAgentRoot(cwd);
        rmSync(cwd, { recursive: true, force: true });
      } catch {
        // best-effort — an empty leftover temp dir is harmless
      }
    };
    // The AI CLI always runs as the agent user when uid separation is on (ADR-0430).
    const run = agentSpawnArgs(cmd, args, env);
    const child = spawn(run.cmd, run.args, { stdio: ["pipe", "pipe", "pipe"], env: run.env, cwd });
    const parser = createAiStreamParser(cmd);
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("research run timed out"));
    }, RESEARCH_TIMEOUT_MS);
    timer.unref();
    child.stdout.on("data", (d: Buffer) => {
      const delta = parser.push(d.toString());
      if (delta) {
        out += delta;
        onChunk(delta);
      }
    });
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      cleanup();
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      cleanup();
      const tail = parser.flush();
      if (tail) {
        out += tail;
        onChunk(tail);
      }
      resolve({ code: code ?? -1, out, err, usage: parser.usage() });
    });
    child.stdin.write(finalPrompt);
    child.stdin.end();
  });
}

/** The outcome of a research run: the answer text + its token usage (or a failure reason). */
export interface ResearchRunResult {
  text: string;
  usage: AiUsage;
  error?: string;
}

/**
 * Run research across the configured profiles (working-first), failing over on any failed attempt.
 * Streams readable deltas to `onChunk` as they arrive. A run that captured no token counts falls back to
 * a length estimate so metering is never zero on a real answer.
 */
export async function runResearch(
  question: string,
  ai: ResearchAi,
  onChunk: (delta: string) => void,
  attachments: ResearchAttachmentPayload[] = [],
): Promise<ResearchRunResult> {
  const prompt = buildResearchPrompt(question);
  const denyDirs = ai.profiles.map((p) => p.dir);
  const attempts: (ResolvedClaudeProfile | null)[] = ai.profiles.length > 0 ? ai.profiles : [null];
  let lastReason = "no attempt";
  for (let i = 0; i < attempts.length; i++) {
    try {
      const { code, out, err, usage } = await runClaudeOnce(ai.cmd, attempts[i]!, prompt, ai.env, onChunk, denyDirs, attachments);
      if (code === 0 && out.trim()) {
        const u = usage.tokens > 0 ? usage : { ...NO_USAGE, tokens: estimateTokens(out) };
        return { text: out.trim(), usage: u };
      }
      lastReason = `exited ${code}: ${(err || out).slice(0, 300)}`;
    } catch (e) {
      lastReason = e instanceof Error ? e.message : String(e);
    }
  }
  return { text: "", usage: { ...NO_USAGE }, error: lastReason };
}
