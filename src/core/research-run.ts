/**
 * research-run (ADR-0380) — the worker side of org AI Research. On a `research.ask` dispatch the cli
 * runs `claude` text-in → text-out with **read-only web tools only** (WebSearch / WebFetch), streaming
 * the answer back in chunks for the live SSE, under a strict content policy (the system prompt instructs
 * the model to return a `REFUSED:` line for disallowed questions). No file/shell/orchestration tools, an
 * empty throwaway working dir, and an allow-listed environment — the agent can look things up on the web
 * but never touch the worker or other systems. Usage is captured so the handler meters it to the org.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAiStreamParser, estimateTokens, type AiUsage } from "./ai-stream";
import { agentEnv } from "./agent-sandbox";
import { denySettingsArgs } from "../utils/agent-deny";
import type { ResolvedClaudeProfile } from "../utils/ai-cli";

/** Max time a research run may take (ms) — it may search/read several pages before answering. */
const RESEARCH_TIMEOUT_MS = 9 * 60 * 1000;

/** Fixed agentic turn budget — a few turns to search + read + synthesize, bounded so it can't loop. */
const RESEARCH_MAX_TURNS = 16;

/** Zero usage — the fallback when a run captured no token counts. */
const NO_USAGE: AiUsage = { tokens: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };

/** The only tools the research agent may use (auto-approved); everything else is denied. */
const RESEARCH_ALLOWED_TOOLS = "WebSearch,WebFetch";

/**
 * Every tool denied to the research agent — anything that touches the worker, other systems, or spawns
 * side-effecting work. Only WebSearch/WebFetch (allow-listed above) remain.
 */
const RESEARCH_DENIED_TOOLS = [
  "Bash", "Edit", "Write", "Read", "Glob", "Grep", "NotebookEdit", "Task", "SlashCommand", "Skill",
  "ToolSearch", "TaskCreate", "TaskGet", "TaskList", "TaskOutput", "TaskStop", "TaskUpdate", "Monitor",
  "DesignSync", "CronCreate", "CronDelete", "CronList", "EnterWorktree", "ExitWorktree", "RemoteTrigger",
  "ScheduleWakeup", "SendMessage", "PushNotification",
].join(",");

/** How to run claude for research — the operator's configured profiles (working-first, ADR-0057). */
export interface ResearchAi {
  cmd: string;
  profiles: ResolvedClaudeProfile[];
  env?: Record<string, string>;
}

/**
 * The research system policy prepended to the user's question (ADR-0380). It defines the task and the
 * STRICT content policy, and instructs the model to return a single `REFUSED:` line (parsed by the
 * research-guard) for a disallowed question.
 */
export function buildResearchPrompt(question: string): string {
  return [
    "You are a research assistant for the 4PM platform. Answer the user's question thoroughly and",
    "accurately, in Markdown. Use the read-only web tools (WebSearch / WebFetch) to find current, factual",
    "information when helpful, and cite sources inline where relevant.",
    "",
    "STRICT CONTENT POLICY — you MUST refuse, and must not answer, if the question (or a faithful answer",
    "to it) would involve any of:",
    "- sexual, abusive, hateful, or illegal content;",
    "- political persuasion, campaigning, or partisan advocacy;",
    "- discrimination or demeaning content targeting a race, ethnicity, religion, gender, nationality, or",
    "  other protected group;",
    "- probing, scanning, exploiting, or attacking the security of ANY system, network, account, device,",
    "  or person you do not own (no vulnerability hunting, no exploit/malware creation, no credential or",
    "  PII harvesting, no evasion of security controls). General defensive-security education is allowed.",
    "- any other seriously harmful activity.",
    "",
    'When you must refuse, reply with EXACTLY one line starting with "REFUSED:" followed by a short,',
    "neutral reason, and output nothing else.",
    "",
    "You have READ-ONLY web tools only. Never attempt to read local files, run shell commands, or interact",
    "with other systems.",
    "",
    "---",
    "",
    "Question:",
    question,
  ].join("\n");
}

/** One research `claude` attempt: web tools only, streaming each readable delta to `onChunk`. */
function runClaudeOnce(
  cmd: string,
  profile: ResolvedClaudeProfile | null,
  prompt: string,
  extraEnv: Record<string, string> | undefined,
  onChunk: (delta: string) => void,
  denyDirs: string[],
): Promise<{ code: number; out: string; err: string; usage: AiUsage }> {
  return new Promise((resolve, reject) => {
    const isClaude = cmd.includes("claude");
    const args = [
      "-p",
      ...(profile?.model ? ["--model", profile.model] : []),
      ...(isClaude ? ["--output-format", "stream-json", "--verbose"] : []),
      // Secret-path deny rules (ADR-0347) — reads are not confined to the working dir.
      ...denySettingsArgs(cmd, [...denyDirs, profile?.dir]),
      // Web-only agent: allow WebSearch/WebFetch (auto-approved), deny everything else, bound the loop.
      // `--permission-mode default` is the non-variadic terminator (so the variadic tool flags consume
      // only their own comma-token — same trick as the one-shot/read-only runners).
      ...(isClaude
        ? [
            `--max-turns=${RESEARCH_MAX_TURNS}`,
            "--allowedTools",
            RESEARCH_ALLOWED_TOOLS,
            "--disallowedTools",
            RESEARCH_DENIED_TOOLS,
            "--permission-mode",
            "default",
          ]
        : []),
    ];
    const env = agentEnv(extraEnv, profile ? { CLAUDE_CONFIG_DIR: profile.dir } : undefined);
    // Empty throwaway dir (the question is in the prompt) so there is nothing to read nearby.
    const cwd = mkdtempSync(join(tmpdir(), "4pm-research-"));
    const cleanup = (): void => {
      try {
        rmSync(cwd, { recursive: true, force: true });
      } catch {
        // best-effort — an empty leftover temp dir is harmless
      }
    };
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], env, cwd });
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
    child.stdin.write(prompt);
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
): Promise<ResearchRunResult> {
  const prompt = buildResearchPrompt(question);
  const denyDirs = ai.profiles.map((p) => p.dir);
  const attempts: (ResolvedClaudeProfile | null)[] = ai.profiles.length > 0 ? ai.profiles : [null];
  let lastReason = "no attempt";
  for (let i = 0; i < attempts.length; i++) {
    try {
      const { code, out, err, usage } = await runClaudeOnce(ai.cmd, attempts[i]!, prompt, ai.env, onChunk, denyDirs);
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
