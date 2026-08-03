/**
 * Run an AI-CLI prompt with profile failover (ADR-0057): try the plan's profile
 * attempts in order; if an attempt fails to authenticate (401 / revoked token) **or hits
 * its session/usage limit**, move to the next profile; stop on the first success (or a
 * genuine error, or once every profile is exhausted). Streams readable text through
 * onChunk (parsed from claude stream-json / codex `exec --json`) and captures the run's
 * real token usage (ADR-0072). The caller reports it to the server + transcript.
 */
import { runCommand } from "./executor";
import type { AiPlan } from "../utils/ai-cli";
import { createAiStreamParser, estimateTokens, type AiUsage } from "./ai-stream";

/** Why an attempt was skipped, so the caller can log an accurate reason. */
export type AttemptFailReason = "auth" | "limit";

/** Detect an auth failure in an attempt's output (to decide whether to try the next). */
export function isAuthFailure(text: string): boolean {
  return /\b401\b|invalid authentication|authentication credentials|oauth[^]*revoked|not authenticated|please run.*login/i.test(
    text,
  );
}

/**
 * Detect a Claude session/usage limit hit (e.g. "You've hit your session limit — resets
 * 2am"). Treated as retryable so failover moves to the next profile.
 */
export function isSessionLimit(text: string): boolean {
  return /hit your (?:session|usage|weekly) limit|(?:session|usage|rate|weekly) limit (?:reached|exceeded)|\b(?:session|usage|weekly) limit\b|usage limit reached/i.test(
    text,
  );
}

/** Callbacks while running the failover. */
export interface AiRunHandlers {
  /** One batched output chunk (verbatim) — forward to transcript + server. */
  onChunk: (text: string) => void;
  /** An attempt is starting (only meaningful when there are multiple profiles). */
  onAttemptStart: (label: string, index: number, total: number) => void;
  /** An attempt failed (auth or session-limit) — will try the next profile. */
  onAttemptFail: (label: string, reason: AttemptFailReason) => void;
}

/** Result of the failover run. */
export interface AiRunResult {
  exitCode: number;
  /** The profile dir that worked (to remember), or null (default env / none worked). */
  workedDir: string | null;
  /** The credential key that worked (unified working memory — ADR-0182), or null. */
  workedKey: string | null;
  /** The provider command of the successful attempt (mixed plans vary — ADR-0182), or null. */
  workedCmd: string | null;
  /** Real token usage of the successful attempt (estimate fallback — ADR-0072). */
  usage: AiUsage;
}

/** Run a single attempt, resolving with its exit code; streams chunks to onChunk. */
function runAttempt(
  commandId: string,
  cmd: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
  onChunk: (text: string) => void,
): Promise<number> {
  return new Promise((resolve) => {
    void runCommand({ commandId, cmd, args, path: cwd, env }, (out) => {
      if (out.chunk) onChunk(out.chunk);
      if (out.done) resolve(out.exitCode ?? -1);
    });
  });
}

/**
 * Execute the plan with failover. Returns the final exit code + the working profile
 * dir (if any) so the caller can remember it for next time.
 */
export async function runAiFailover(
  plan: AiPlan,
  commandId: string,
  cwd: string,
  handlers: AiRunHandlers,
): Promise<AiRunResult> {
  const total = plan.attempts.length;
  let finalExit = -1;
  for (let i = 0; i < total; i++) {
    const attempt = plan.attempts[i]!;
    if (total > 1) handlers.onAttemptStart(attempt.label, i, total);
    // Parse claude stream-json / codex `exec --json` → readable text for the transcript +
    // real usage; any non-event line passes through verbatim (ADR-0072). Per-attempt, since a
    // mixed plan can switch provider between attempts (ADR-0182). `captured` = display text
    // (used for auth-failure detection + the estimate fallback).
    const parser = createAiStreamParser(attempt.cmd);
    let captured = "";
    const emit = (raw: string): void => {
      const text = parser.push(raw);
      if (text) {
        captured += text;
        handlers.onChunk(text);
      }
    };
    finalExit = await runAttempt(commandId, attempt.cmd, attempt.args, cwd, attempt.env, emit);
    const tail = parser.flush();
    if (tail) {
      captured += tail;
      handlers.onChunk(tail);
    }
    if (finalExit === 0) {
      const usage = parser.usage();
      if (usage.tokens === 0) usage.tokens = estimateTokens(captured);
      return { exitCode: 0, workedDir: attempt.dir, workedKey: attempt.key, workedCmd: attempt.cmd, usage };
    }
    // Retry on an auth failure OR a session/usage-limit hit; a genuine error surfaces
    // as-is. Once the last profile is reached (all exhausted), stop and surface it.
    const reason: AttemptFailReason | null = isAuthFailure(captured)
      ? "auth"
      : isSessionLimit(captured)
        ? "limit"
        : null;
    if (!reason || i === total - 1) break;
    handlers.onAttemptFail(attempt.label, reason);
  }
  return { exitCode: finalExit, workedDir: null, workedKey: null, workedCmd: null, usage: { tokens: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0 } };
}
