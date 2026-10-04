/**
 * RESEARCH_ASK + RESEARCH_PROGRESS payloads (ADR-0380) — the server's org-level "AI Research" request
 * and the cli's streamed answer. Request–reply over the `research.ask` channel: the server picks an idle
 * cli of the org AI pool (ADR-0284 pool designated in Settings), forwards the user's question, and the
 * worker runs a one-shot research agent (read-only web/search tools) under a content policy + a
 * research-guard post-check. The cli streams answer chunks over `research.progress` (for live SSE) and
 * returns the final answer — or a structured refusal — in the reply, plus the run's token usage so the
 * server meters it to the org (projectId=null). No project is involved.
 */

/**
 * One research attachment delivered inline on the dispatch (ADR-0385). The server reads the relay blob
 * and base64-encodes it, so delivery works on every storage backend (the worker never reaches storage).
 * The cli writes it into a per-run scratch dir and grants the agent a `Read` scoped to that dir.
 */
export interface ResearchAttachmentPayload {
  /** File name written into the scratch dir (sanitized by the cli). */
  name: string;
  mime: string;
  /** The file bytes, base64-encoded. */
  dataBase64: string;
}

/** Server → cli: the research question to run, tagged with the persisted query id for progress routing. */
export interface ResearchAskRequest {
  /** The `ResearchQuery` row id — echoed on every progress frame so the server routes/accumulates it. */
  queryId: string;
  /** The user's question (plain text / markdown). */
  question: string;
  /** Inline attachments (ADR-0385) — materialized on the worker, read-scoped to the run's scratch dir. */
  attachments?: ResearchAttachmentPayload[];
}

/** cli → server: the final research result — the markdown answer, a structured refusal, or an error. */
export interface ResearchAskReply {
  /** The research answer (markdown) when the run succeeded and passed the guard. */
  answer?: string;
  /** True when the content policy / research-guard declined the question (no answer stored). */
  refused?: boolean;
  /** A short, user-safe reason shown with a refusal. */
  refusalReason?: string;
  /** Error marker when the run failed (no profile, spawn, timeout, empty answer). */
  error?: string;
  /** Raw total tokens the run consumed (for display on the row); the cli also reports usage separately. */
  tokens?: number;
}

/** cli → server (one-way): live progress of a research run for the web's SSE stream. */
export interface ResearchProgressPayload {
  /** The `ResearchQuery` row id this frame belongs to. */
  queryId: string;
  /** A streamed answer chunk (appended in order), when present. */
  chunk?: string;
  /** A short human status line (e.g. "searching…"), when present. */
  message?: string;
  /** True on the terminal frame (the run finished — success, refusal, or failure). */
  done?: boolean;
}
