/**
 * memory-compact — the worker side of the shared AI memory compaction (ADR-0245). After each AI run
 * (when memory is enabled), the cli merges the latest exchange into the rolling memory with a small
 * background `claude -p` call and returns the UPDATED, budget-bounded memory. It runs OUTSIDE the
 * console transcript/command machinery (like knowledge-compose / support-answer) so it stays invisible
 * and never pollutes the console. Failure ⇒ empty string ⇒ the caller keeps the previous memory.
 * The call is bounded (1 turn, every tool disallowed) and returns its token usage so the caller can
 * meter it like any other AI run (ADR-0340).
 */
import { spawn } from "node:child_process";
import { reportToolResult } from "./tool-health";
import { ONE_SHOT_DISALLOWED_CLAUDE_TOOLS, type ResolvedClaudeProfile } from "../utils/ai-cli";
import { denySettingsArgs } from "../utils/agent-deny";
import { resolveCliPrompt } from "./prompt-overrides";
import type { AiUsage } from "./ai-stream";

/** How to run the AI CLI for a compaction (resolved by the caller from the profile config). */
export interface MemoryCompactAi {
  cmd: string;
  profiles: ResolvedClaudeProfile[];
  env?: Record<string, string>;
}

/** The exchange to fold into the memory. */
export interface MemoryCompactInput {
  oldMemory: string;
  prompt: string;
  answer: string;
  budgetChars: number;
}

/** The outcome of a compaction: the new memory ("" on failure) + the tokens it spent (ADR-0340). */
export interface MemoryCompactResult {
  memory: string;
  usage: AiUsage | null;
  /** The profile dir that produced it (null = default profile / failure). */
  dir: string | null;
}

/** claude `-p --output-format json` result (only the fields we read). */
interface ClaudeJsonResult {
  result?: string;
  is_error?: boolean;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

/** Parse claude's JSON result into the answer text + usage (raw total incl. cache — ADR-0340). */
function parseJsonResult(out: string): { text: string; usage: AiUsage | null } | null {
  let parsed: ClaudeJsonResult;
  try {
    parsed = JSON.parse(out.trim()) as ClaudeJsonResult;
  } catch {
    return null;
  }
  if (parsed.is_error || typeof parsed.result !== "string") return null;
  const u = parsed.usage;
  const usage: AiUsage | null = u
    ? {
        input: u.input_tokens ?? 0,
        output: u.output_tokens ?? 0,
        cacheRead: u.cache_read_input_tokens ?? 0,
        cacheCreation: u.cache_creation_input_tokens ?? 0,
        tokens:
          (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
      }
    : null;
  return { text: parsed.result, usage };
}

/** Max time to wait for a compaction (ms) — short; it is a background housekeeping call. */
const COMPACT_TIMEOUT_MS = 60_000;

/** Build the compaction prompt fed to the AI CLI over stdin. */
function buildPrompt(input: MemoryCompactInput): string {
  // Admin override (ADR-0381) for `cli.memory.compact`, else the shared registry default.
  return resolveCliPrompt("cli.memory.compact", {
    budgetChars: input.budgetChars,
    oldMemory: input.oldMemory || "(empty)",
    prompt: input.prompt,
    answer: input.answer,
  });
}

/** Run the AI CLI once with the prompt on stdin; returns exit code + stdout/stderr. */
function runOnce(
  cmd: string,
  profile: ResolvedClaudeProfile | null,
  prompt: string,
  cwd: string,
  extraEnv: Record<string, string> | undefined,
  denyDirs: string[] = [],
): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    // Bounded + metered (ADR-0340): JSON output (carries usage), a single turn, every agentic tool
    // disallowed; `--permission-mode default` terminates the variadic `--disallowedTools`.
    const args = [
      "-p",
      "--output-format",
      "json",
      ...(profile?.model ? ["--model", profile.model] : []),
      // Secret-path deny rules (ADR-0347) — before the variadic `--disallowedTools`.
      ...denySettingsArgs(cmd, [...denyDirs, profile?.dir]),
      "--max-turns=1",
      "--disallowedTools",
      ONE_SHOT_DISALLOWED_CLAUDE_TOOLS,
      "--permission-mode",
      "default",
    ];
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...extraEnv,
      ...(profile ? { CLAUDE_CONFIG_DIR: profile.dir } : {}),
    };
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], cwd, env });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("memory compaction timed out"));
    }, COMPACT_TIMEOUT_MS);
    timer.unref();
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, out, err });
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

/**
 * Compact the latest exchange into the rolling memory, trying the configured claude profiles
 * working-first (any-error failover — ADR-0057/0240). Returns the new memory (clamped to the budget)
 * plus the tokens spent, or `memory: ""` when it could not produce one (the caller then keeps the
 * previous memory).
 */
export async function runMemoryCompaction(
  ai: MemoryCompactAi,
  cwd: string,
  input: MemoryCompactInput,
): Promise<MemoryCompactResult> {
  const prompt = buildPrompt(input);
  const attempts: (ResolvedClaudeProfile | null)[] = ai.profiles.length > 0 ? ai.profiles : [null];
  for (let i = 0; i < attempts.length; i++) {
    try {
      const profile = attempts[i]!;
      const { code, out } = await runOnce(ai.cmd, profile, prompt, cwd, ai.env, ai.profiles.map((p) => p.dir));
      const parsed = code === 0 ? parseJsonResult(out) : null;
      if (parsed && parsed.text.trim()) {
        reportToolResult(ai.cmd, true);
        return { memory: parsed.text.trim().slice(0, input.budgetChars), usage: parsed.usage, dir: profile?.dir ?? null };
      }
      if (i === attempts.length - 1) break;
    } catch {
      break;
    }
  }
  return { memory: "", usage: null, dir: null }; // failure ⇒ caller keeps the previous memory
}
