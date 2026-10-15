/**
 * `ai.run.state` — the cli's live AI runs (cli → server, one-way). The cli sends the FULL list each
 * time an AI attempt starts or ends (and once per session); the cli-server keeps it on the link's
 * presence record so the server and the web see which AI account each worker is running on right now.
 * Ephemeral: never stored in the DB, gone when the link disconnects.
 * @adr 0522
 */

/** What started an AI run. */
export type AiRunSource =
  | "command" // server-dispatched (web Console, AI suggest / review / compose)
  | "local" // typed in the worker's TUI
  | "autonomous" // an autonomous cycle phase
  | "task" // a one-shot AI task (project create, scaffold)
  | "support" // AI Help answer / admin draft / checklist author
  | "research"
  | "faq"
  | "memory"; // shared-memory compaction

/** One AI attempt running now. */
export interface AiRunInfo {
  runId: string;
  /** Display label of the account — masked to `AI account #N` on a platform-pool worker. @adr 0395 */
  label: string;
  /** The account as `machine.status.aiAccounts` names it (email, else label / folder) — unmasked. */
  account: string;
  /** The AI CLI (claude | codex | …). */
  provider: string;
  source: AiRunSource;
  /** ISO start time of this attempt. */
  startedAt: string;
}

/** The `ai.run.state` payload — every AI attempt running on the cli right now (empty = idle). */
export interface AiRunStatePayload {
  runs: AiRunInfo[];
}
