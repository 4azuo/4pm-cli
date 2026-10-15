/**
 * memory-compact — the worker side of the shared AI memory compaction. After each AI run
 * (when memory is enabled), the cli merges the latest exchange into the rolling memory with a small
 * background run and returns the UPDATED, budget-bounded memory. It runs OUTSIDE the console
 * transcript/command machinery (like support-answer) so it stays invisible and never pollutes the
 * console. Failure ⇒ empty string ⇒ the caller keeps the previous memory. The call is bounded (1 turn,
 * every tool disallowed) and returns its token usage so the caller can meter it like any other AI run;
 * it goes through the shared AI path (every configured account, failover, account lease).
 * @adr 0245 @adr 0340 @adr 0520
 */
import { ONE_SHOT_DISALLOWED_CLAUDE_TOOLS, type AiRunPolicy } from "../../utils/ai-cli";
import { stripUntrustedMarkers } from "@4pm/constants";
import { resolveCliPrompt } from "../ai/prompt-overrides";
import type { AiUsage } from "../ai/ai-stream";
import type { AiTextRunner } from "../ai/ai-text-run";

/** The exchange to fold into the memory. */
export interface MemoryCompactInput {
  oldMemory: string;
  prompt: string;
  answer: string;
  budgetChars: number;
}

/** The outcome of a compaction: the new memory ("" on failure) + the tokens it spent. */
export interface MemoryCompactResult {
  memory: string;
  usage: AiUsage | null;
  /** The profile dir that produced it (null = default profile / failure). */
  dir: string | null;
  /** The provider that produced it (null on failure) — metered per provider. @adr 0340 */
  cmd: string | null;
}

/** Max time to wait for a compaction (ms) — short; it is a background housekeeping call. */
const COMPACT_TIMEOUT_MS = 60_000;

/** Build the compaction prompt fed to the AI CLI over stdin. */
function buildPrompt(input: MemoryCompactInput): string {
  // Admin override (ADR-0381) for `cli.memory.compact`, else the shared registry default.
  // The old memory + exchange are wrapped as untrusted data by the registry (ADR-0421).
  return resolveCliPrompt("cli.memory.compact", {
    budgetChars: input.budgetChars,
    oldMemory: input.oldMemory || "(empty)",
    prompt: input.prompt,
    answer: input.answer,
  });
}

/**
 * The compaction run policy: a single turn with every agentic tool disallowed (`--permission-mode
 * default` terminates the variadic `--disallowedTools`); codex runs in a read-only sandbox.
 * @adr 0520
 */
const COMPACT_POLICY: AiRunPolicy = {
  args: (cmd) =>
    cmd.includes("claude")
      ? ["--max-turns=1", "--disallowedTools", ONE_SHOT_DISALLOWED_CLAUDE_TOOLS, "--permission-mode", "default"]
      : cmd.includes("codex")
        ? ["--sandbox", "read-only"]
        : null,
};

/**
 * Compact the latest exchange into the rolling memory through the shared AI path (working-first,
 * any-error failover). Returns the new memory (clamped to the budget) plus the tokens spent, or
 * `memory: ""` when it could not produce one (the caller then keeps the previous memory).
 * @adr 0057 @adr 0240 @adr 0520
 */
export async function runMemoryCompaction(
  run: AiTextRunner,
  cwd: string,
  input: MemoryCompactInput,
): Promise<MemoryCompactResult> {
  try {
    const result = await run(buildPrompt(input), {
      label: "memory-compact", source: "memory",
      policy: COMPACT_POLICY,
      cwd,
      timeoutMs: COMPACT_TIMEOUT_MS,
      envKind: "projectless",
      quiet: true,
    });
    // Drop any marker the model echoed from the wrapped inputs (ADR-0421) so the memory never grows them.
    const memory = result.ok ? stripUntrustedMarkers(result.text).trim() : "";
    if (!memory) return { memory: "", usage: null, dir: null, cmd: null }; // the caller keeps the previous memory
    return { memory: memory.slice(0, input.budgetChars), usage: result.usage, dir: result.workedDir, cmd: result.workedCmd };
  } catch {
    return { memory: "", usage: null, dir: null, cmd: null };
  }
}
