/**
 * SUPPORT_ANSWER payloads (ADR-0170) — the server dispatcher's request to a support-agent cli
 * and the cli's reply. Request–reply over the `support.answer` channel: the worker clones/pulls
 * the shared docs/FAQ repo, runs `claude` grounded in it, and returns the composed answer.
 */

/** Server → cli: the question to answer + the shared docs/FAQ repo to read. */
export interface SupportAnswerRequest {
  /** The user's question. */
  question: string;
  /** The asker's role so the agent hides admin-only features from non-admins. */
  askerRole: "admin" | "user";
  /** The shared docs/FAQ repo the agent reads (cloned/pulled into an isolated folder). */
  repo: {
    url: string;
    branch: string;
    /** Optional read-only token / deploy key for a private repo (null = public / worker creds). */
    token: string | null;
  };
}

/** The claude run's token split for a support answer (ADR-0224). */
export interface SupportAnswerUsage {
  /** input_tokens of the run. */
  input: number;
  /** output_tokens of the run. */
  output: number;
  /** cache_read_input_tokens of the run. */
  cacheRead: number;
  /** cache_creation_input_tokens of the run. */
  cacheCreation: number;
}

/**
 * The agent's inline moderation verdict on the question (ADR-0237) — produced in the same claude
 * run that composes the answer, so no extra model/pass. The server persists it onto the user's
 * HelpMessage; the admin Conversations monitor flags off-topic / sensitive questions from it.
 */
export interface SupportAnswerModeration {
  /** false ⇒ the question is not about how to use 4PM (out of scope). */
  onTopic: boolean;
  /** true ⇒ the question contains sensitive / inappropriate content. */
  sensitive: boolean;
  /** A short human-readable reason for the flag (empty when neither flag is set). */
  reason?: string;
}

/** cli → server: the composed answer (or an error the dispatcher maps to unavailable). */
export interface SupportAnswerReply {
  /** The grounded answer text; empty when the agent could not produce one. */
  body: string;
  /** Optional error marker when the worker failed (repo clone, spawn, timeout…). */
  error?: string;
  /**
   * Inline moderation verdict on the question (ADR-0237). Absent when the run produced no verdict
   * (older cli, or the structured output could not be parsed) — the server then treats it as
   * on-topic / not-sensitive (never flags).
   */
  moderation?: SupportAnswerModeration;
  /**
   * Real token usage of the claude run (ADR-0224) — the server records it against the seeded
   * `4pm-faq` project. Absent / 0 when the run produced no usage (older cli, plain-text fallback).
   */
  tokens?: number;
  /** The token split behind `tokens` (ADR-0224); absent when `tokens` is. */
  tokensBreakdown?: SupportAnswerUsage;
  /** When the answer finished, ISO-8601 (ADR-0224); the server defaults to now when absent. */
  finishedAt?: string;
}
