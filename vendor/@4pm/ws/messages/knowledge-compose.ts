/**
 * KNOWLEDGE_COMPOSE payloads (ADR-0190) — the server's request to a project's cli to AI-distil the
 * project into a knowledge article, and the cli's reply. Request–reply over the `knowledge.compose`
 * channel: the worker runs the AI CLI (claude/codex) in the project's working dir with a distillation
 * prompt and returns the composed markdown. Falls back to a templated draft on the server when the
 * cli/AI is unavailable.
 */

/** Server → cli: distil this project into a knowledge doc. */
export interface KnowledgeComposeRequest {
  /** The project's display name (for the prompt). */
  projectName: string;
  /** Optional extra focus/instruction from the author. */
  prompt?: string;
}

/** cli → server: the composed markdown (or an error the server maps to the templated fallback). */
export interface KnowledgeComposeReply {
  /** The composed knowledge article in markdown (empty when the agent produced nothing). */
  bodyMarkdown: string;
  /** Optional error marker when the worker failed (spawn/timeout/auth). */
  error?: string;
}
