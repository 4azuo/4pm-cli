/**
 * AI run tracker — the AI attempts running on this cli right now, reported to the server as
 * `ai.run.state` (the full list on every start / end, and again when a session opens) so the web shows
 * whether a worker is running and on which AI account. Attempts register here from `runAiFailover`, so
 * every AI run is covered (dispatched, autonomous, AI tasks, support / research / FAQ, memory compaction).
 * @adr 0522
 */
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type { AiRunInfo, AiRunSource, AiRunStatePayload } from "@4pm/ws";
import { isAiAccountMaskOn, profileAccountEmail, type AiAttempt } from "../../utils/ai-cli";

/** Live attempts by run id. */
const runs = new Map<string, AiRunInfo>();

/** Where snapshots go (the live WS session), or null while disconnected. */
let sink: ((payload: AiRunStatePayload) => void) | null = null;

/** The current snapshot. */
function snapshot(): AiRunStatePayload {
  return { runs: [...runs.values()] };
}

/** Push the current snapshot to the sink (no-op while disconnected). */
function publish(): void {
  try {
    sink?.(snapshot());
  } catch {
    // reporting is best-effort — never break an AI run over it
  }
}

/** Route snapshots to the live session (null on disconnect); a new session gets the current list at once. */
export function setAiRunSink(fn: ((payload: AiRunStatePayload) => void) | null): void {
  sink = fn;
  publish();
}

/**
 * The account as `machine.status.aiAccounts` names it — the signed-in email, else the credential label /
 * folder (the folder while labels are masked, since the masked display label hides the real one).
 */
function accountName(attempt: AiAttempt): string {
  const email = attempt.dir ? profileAccountEmail(attempt.dir) : null;
  if (email) return email;
  if (!attempt.dir) return attempt.label;
  return isAiAccountMaskOn() ? basename(attempt.dir) : attempt.label;
}

/** Register an attempt that is about to spawn; returns its run id for {@link endAiRun}. */
export function startAiRun(attempt: AiAttempt, source: AiRunSource): string {
  const runId = randomUUID();
  runs.set(runId, {
    runId,
    label: attempt.label,
    account: accountName(attempt),
    provider: attempt.cmd,
    source,
    startedAt: new Date().toISOString(),
  });
  publish();
  return runId;
}

/** Drop a finished attempt (idempotent). */
export function endAiRun(runId: string): void {
  if (runs.delete(runId)) publish();
}
