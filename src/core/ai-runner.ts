/**
 * Run an AI-CLI prompt with profile failover (ADR-0057, ADR-0240): try the plan's profile
 * attempts in order; on **any** failed attempt move to the next profile (auth / session-limit /
 * out-of-credits / other), and stop on the first success — or once every profile is exhausted,
 * surfacing that last failure. Streams readable text through onChunk (parsed from claude
 * stream-json / codex `exec --json`) and captures the run's real token usage (ADR-0072). The
 * caller reports it to the server + transcript.
 */
import { runCommand } from "./executor";
import { reportToolResult } from "./tool-health";
import type { AiPlan } from "../utils/ai-cli";
import { createAiStreamParser, estimateTokens, type AiUsage } from "./ai-stream";

/** Why an attempt was skipped, so the caller can log an accurate reason (ADR-0240: any error fails over). */
export type AttemptFailReason = "auth" | "limit" | "credits" | "other";

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

/**
 * Detect an out-of-credits / payment-required failure (ADR-0249) — e.g. claude's "You're out of
 * usage credits. Run /usage-credits …" or a `credits_required` / `out_of_credits` marker. Claude
 * returns **exit 0** for this, so the failover relies on the `result` event's `is_error` flag; this
 * text check only classifies the reason for an accurate log.
 */
export function isOutOfCredits(text: string): boolean {
  return /out of (?:usage )?credits|credits[_ ]required|out[_ ]of[_ ]credits|insufficient credits/i.test(
    text,
  );
}

/** Callbacks while running the failover. */
export interface AiRunHandlers {
  /** One batched output chunk (verbatim) — forward to transcript + server. */
  onChunk: (text: string) => void;
  /**
   * An attempt is starting (only meaningful when there are multiple profiles). `cmd` is the
   * attempt's own provider command so a mixed plan logs the right CLI per attempt (ADR-0197).
   */
  onAttemptStart: (label: string, index: number, total: number, cmd: string) => void;
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
  /** The claude session id of the successful attempt (ADR-0245 native resume); "" when none. */
  sessionId: string;
}

/** Run a single attempt, resolving with its exit code; streams chunks to onChunk. */
function runAttempt(
  commandId: string,
  cmd: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
  onChunk: (text: string) => void,
  timeoutMs: number,
): Promise<number> {
  return new Promise((resolve) => {
    void runCommand({ commandId, cmd, args, path: cwd, env }, (out) => {
      if (out.chunk) onChunk(out.chunk);
      if (out.done) resolve(out.exitCode ?? -1);
    }, timeoutMs > 0 ? { timeoutMs } : undefined);
  });
}

/**
 * Execute the plan with failover. Returns the final exit code + the working profile
 * dir (if any) so the caller can remember it for next time. `timeoutMs` (ADR-0243) caps EACH
 * attempt's wall-clock — a hung/looping AI CLI is terminated and reported as a failed attempt so
 * failover still moves on; 0 ⇒ no cap.
 */
export async function runAiFailover(
  plan: AiPlan,
  commandId: string,
  cwd: string,
  handlers: AiRunHandlers,
  timeoutMs = 0,
): Promise<AiRunResult> {
  const total = plan.attempts.length;
  let finalExit = -1;
  // Track the last attempt's provider + captured output so a total failure can report the AI
  // CLI's health to the admin pool (ADR-0223).
  let lastCmd = plan.attempts[0]?.cmd ?? "claude";
  let lastCaptured = "";
  for (let i = 0; i < total; i++) {
    const attempt = plan.attempts[i]!;
    lastCmd = attempt.cmd;
    if (total > 1) handlers.onAttemptStart(attempt.label, i, total, attempt.cmd);
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
    finalExit = await runAttempt(commandId, attempt.cmd, attempt.args, cwd, attempt.env, emit, timeoutMs);
    const tail = parser.flush();
    if (tail) {
      captured += tail;
      handlers.onChunk(tail);
    }
    lastCaptured = captured;
    // A clean exit is NOT enough (ADR-0249): claude returns exit 0 even when out of credits /
    // rate-limited / not logged in, marking the terminal `result` with `is_error:true`. Treat such
    // a run as a FAILED attempt so failover moves to the next profile instead of handing the
    // "out of usage credits" text back as the answer.
    const apiErr = parser.apiError();
    if (finalExit === 0 && !apiErr.isError) {
      const usage = parser.usage();
      if (usage.tokens === 0) usage.tokens = estimateTokens(captured);
      reportToolResult(attempt.cmd, true); // AI CLI ran ok (ADR-0223)
      return {
        exitCode: 0,
        workedDir: attempt.dir,
        workedKey: attempt.key,
        workedCmd: attempt.cmd,
        usage,
        sessionId: parser.sessionId(),
      };
    }
    // Reflect an exit-0-but-errored run as a non-zero exit so the last-attempt return (and the web)
    // surfaces the streamed error text instead of treating it as success (ADR-0249).
    if (finalExit === 0 && apiErr.isError) finalExit = apiErr.status && apiErr.status > 0 ? apiErr.status : 1;
    // Fail over on ANY failed attempt (ADR-0240): auth / session-limit / out-of-credits / other —
    // classify only for an accurate log. Stop once the last profile is reached (all exhausted).
    const reason: AttemptFailReason = isAuthFailure(captured)
      ? "auth"
      : apiErr.status === 429 || isOutOfCredits(captured)
        ? "credits"
        : isSessionLimit(captured)
          ? "limit"
          : "other";
    if (i === total - 1) break;
    handlers.onAttemptFail(attempt.label, reason);
  }
  // Every attempt failed — report the AI CLI's health with a short reason (ADR-0223).
  reportToolResult(lastCmd, false, summarizeAiFailure(lastCaptured, finalExit));
  return { exitCode: finalExit, workedDir: null, workedKey: null, workedCmd: null, usage: { tokens: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, sessionId: "" };
}

/** A short, human reason for a failed AI run — reused by the tool-health report (ADR-0223). */
function summarizeAiFailure(captured: string, exitCode: number): string {
  if (isAuthFailure(captured)) return "Not logged in";
  if (isOutOfCredits(captured)) return "Out of usage credits";
  if (isSessionLimit(captured)) return "Usage limit reached";
  const firstLine = captured.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
  return firstLine || `exited ${exitCode}`;
}
