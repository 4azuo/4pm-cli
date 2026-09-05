/**
 * memory-compact — the worker side of the shared AI memory compaction (ADR-0245). After each AI run
 * (when memory is enabled), the cli merges the latest exchange into the rolling memory with a small
 * background `claude -p` call and returns the UPDATED, budget-bounded memory. It runs OUTSIDE the
 * console transcript/command machinery (like knowledge-compose / support-answer) so it stays invisible
 * and never pollutes the console. Failure ⇒ empty string ⇒ the caller keeps the previous memory.
 */
import { spawn } from "node:child_process";
import { reportToolResult } from "./tool-health";
import type { ResolvedClaudeProfile } from "../utils/ai-cli";

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

/** Max time to wait for a compaction (ms) — short; it is a background housekeeping call. */
const COMPACT_TIMEOUT_MS = 60_000;

/** Build the compaction prompt fed to the AI CLI over stdin. */
function buildPrompt(input: MemoryCompactInput): string {
  return [
    "You maintain a COMPACT running memory of an ongoing assistant conversation so it can continue",
    "across sessions and accounts. Merge the latest exchange into the existing memory and return the",
    `UPDATED memory. Keep it UNDER ${input.budgetChars} characters. Use terse Markdown bullets grouped`,
    "as: Decisions, Constraints, Open tasks, Glossary. Keep durable facts; drop chit-chat and anything",
    "now obsolete. Output ONLY the updated memory text — no preamble, no code fences.",
    "",
    "=== EXISTING MEMORY ===",
    input.oldMemory || "(empty)",
    "",
    "=== LATEST USER PROMPT ===",
    input.prompt,
    "",
    "=== LATEST ASSISTANT ANSWER ===",
    input.answer,
  ].join("\n");
}

/** Run the AI CLI once with the prompt on stdin; returns exit code + stdout/stderr. */
function runOnce(
  cmd: string,
  profile: ResolvedClaudeProfile | null,
  prompt: string,
  cwd: string,
  extraEnv: Record<string, string> | undefined,
): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const args = ["-p", ...(profile?.model ? ["--model", profile.model] : [])];
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
 * or `""` when it could not produce one (the caller then keeps the previous memory).
 */
export async function runMemoryCompaction(
  ai: MemoryCompactAi,
  cwd: string,
  input: MemoryCompactInput,
): Promise<string> {
  const prompt = buildPrompt(input);
  const attempts: (ResolvedClaudeProfile | null)[] = ai.profiles.length > 0 ? ai.profiles : [null];
  for (let i = 0; i < attempts.length; i++) {
    try {
      const { code, out } = await runOnce(ai.cmd, attempts[i]!, prompt, cwd, ai.env);
      if (code === 0 && out.trim()) {
        reportToolResult(ai.cmd, true);
        return out.trim().slice(0, input.budgetChars);
      }
      if (i === attempts.length - 1) break;
    } catch {
      break;
    }
  }
  return ""; // failure ⇒ caller keeps the previous memory (no update sent)
}
