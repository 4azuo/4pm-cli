/**
 * SUPPORT_ANSWER payloads — the server dispatcher's request to a support-agent cli
 * and the cli's reply. Request–reply over the `support.answer` channel: the worker clones/pulls
 * the shared docs/FAQ repo, runs `claude` grounded in it, and returns the composed answer.
 * @adr 0170
 */

/**
 * One image attachment on a support-answer request — the bytes are embedded (base64) since
 * the system-scoped support path has no image-fetch channel. The cli materializes the image into the
 * run folder and rewrites its `[Image#N]` placeholder in the question to the on-disk path before
 * `claude -p`, so the agent can `Read` it (mirrors the Console command-image pipeline).
 * @adr 0273 @adr 0257
 */
export interface SupportAnswerImage {
  /** The `[Image#N]` token in the question this image sits behind. */
  placeholder: string;
  /** MIME (drives the on-disk extension). */
  mime: string;
  /** The image bytes, base64-encoded. */
  dataBase64: string;
}

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
  /** Pasted images the agent should read; the cli materializes + rewrites placeholders. */
  images?: SupportAnswerImage[];
  /**
   * Admin drafting mode. When set, `question` carries the drafting context + the admin's
   * instructions and the cli uses a drafting prompt (grounded, no refusal / moderation JSON) whose
   * whole output is the markdown draft. Absent ⇒ the normal AI-Help Q&A answer.
   * @adr 0345
   */
  task?: SupportAnswerTask;
}

/**
 * The drafting task of a support-answer request: a ticket reply or an outreach message,
 * a legal document body, or drafting/translating an AI prompt template (ADR-0381 —
 * `prompt_generate` writes a template from a description, `prompt_translate` localizes one). For the
 * prompt tasks the server builds the full instruction as the context; the cli runs it focused.
 * @adr 0345 @adr 0360
 */
export type SupportAnswerTask =
  | "reply_draft"
  | "outreach_draft"
  | "legal_draft"
  | "prompt_generate"
  | "prompt_translate";

/** The claude run's token split for a support answer. @adr 0224 */
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
 * The agent's inline moderation verdict on the question — produced in the same claude
 * run that composes the answer, so no extra model/pass. The server persists it onto the user's
 * HelpMessage; the admin Conversations monitor flags off-topic / sensitive questions from it.
 * @adr 0237
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
   * Inline moderation verdict on the question. Absent when the run produced no verdict
   * (older cli, or the structured output could not be parsed) — the server then treats it as
   * on-topic / not-sensitive (never flags).
   * @adr 0237
   */
  moderation?: SupportAnswerModeration;
  /**
   * Real token usage of the claude run — the server records it against the seeded
   * `4pm-faq` project. Absent / 0 when the run produced no usage (older cli, plain-text fallback).
   * @adr 0224
   */
  tokens?: number;
  /** The token split behind `tokens`; absent when `tokens` is. @adr 0224 */
  tokensBreakdown?: SupportAnswerUsage;
  /** When the answer finished, ISO-8601; the server defaults to now when absent. @adr 0224 */
  finishedAt?: string;
}
