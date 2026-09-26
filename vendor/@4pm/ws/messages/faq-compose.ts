/**
 * FAQ_COMPOSE payloads (ADR-0333) — the platform-pool dispatcher's request to a platform-pool cli
 * and the cli's reply. Request–reply over the `faq.compose` channel: the worker clones the 4pm-faq
 * repo with a short-lived WRITE token (a per-job GitHub-App installation token), distils the selected
 * support tickets into FAQ entries, commits, pushes a branch, opens a PR, then wipes the token +
 * clone. The write token never persists on the worker (leak-safety on release/reassign).
 */

/** One message in a ticket transcript sent to the agent (author + text). */
export interface FaqTicketMessage {
  /** Who wrote it — the customer or a platform admin. */
  author: "user" | "admin";
  /** The message body (plain text). */
  body: string;
  /** When it was written, ISO-8601. */
  at: string;
}

/** One support ticket the agent should distil into FAQ content. */
export interface FaqTicket {
  /** The ticket id (for traceability in the PR body). */
  id: string;
  /** The ticket subject. */
  subject: string;
  /** The ticket category. */
  category: string;
  /** The ordered message thread. */
  messages: FaqTicketMessage[];
}

/** Server → cli: the tickets to synthesize + the 4pm-faq repo with a write token + the branch to open. */
export interface FaqComposeRequest {
  /** The selected support tickets to distil into FAQ entries. */
  tickets: FaqTicket[];
  /** The 4pm-faq repo to write, with a short-lived WRITE token minted per job (null ⇒ not configured). */
  repo: {
    url: string;
    branch: string;
    /** Short-lived write token (GitHub-App installation token). Used transiently, then wiped. */
    token: string | null;
  };
  /** The branch the worker creates for the PR (head); base = the repo default branch. */
  headBranch: string;
  /** Optional extra instruction from the admin, appended to the synthesis prompt. */
  customPrompt?: string;
}

/** Per-ticket outcome of a synthesis run (ADR-0333) — one entry per selected ticket. */
export interface FaqTicketResult {
  /** The ticket id this summary is for. */
  ticketId: string;
  /** A short summary of what the agent did for this ticket (created/updated FAQ, or skipped + why). */
  summary: string;
}

/** The claude run's token split for a FAQ synthesis (ADR-0333, mirrors the support usage split). */
export interface FaqComposeUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

/** cli → server: the PR result (or an error the dispatcher maps to a failed run). */
export interface FaqComposeReply {
  /** The opened PR URL; empty when no PR was opened (nothing to write, or push/PR failed). */
  prUrl: string;
  /** The head branch the worker pushed (echoed for the run record). */
  branch?: string;
  /** The AI agent's captured text output/summary (what it did), capped — shown in the admin modal. */
  output?: string;
  /** Per-ticket result summaries parsed from the agent's structured output (ADR-0333). */
  perTicket?: FaqTicketResult[];
  /** Optional error marker when the worker failed (clone/spawn/push/PR/timeout). */
  error?: string;
  /** Real token usage of the claude run (ADR-0333); recorded against the 4pm-faq-sync project. */
  tokens?: number;
  /** The token split behind `tokens`; absent when `tokens` is. */
  tokensBreakdown?: FaqComposeUsage;
  /** When the run finished, ISO-8601; the server defaults to now when absent. */
  finishedAt?: string;
}
