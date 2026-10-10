/**
 * CHECKLIST_AUTHOR payloads — the server's org-level "AI author checklist items" request
 * and the cli's reply. Request–reply over the `checklist.author` channel: the server picks an idle cli
 * of the org AI pool (ADR-0284 pool designated in Settings) and forwards a ready-built prompt; the
 * worker runs `claude` one-shot (text-in → text-out, no tools — like the support-answer runner) and
 * replies with the raw model output, which the web parses into the draft items. No project is involved.
 * @adr 0376
 */

/** Server → cli: the ready-built authoring prompt (the web composes it; the cli only runs it). */
export interface ChecklistAuthorRequest {
  /** The full prompt to run one-shot (includes the instruction + the current items as context). */
  prompt: string;
}

/** cli → server: the model's raw output text, or an error the server maps to a failed request. */
export interface ChecklistAuthorReply {
  /** The model's raw output (the web parses the proposed items from it); empty when it failed. */
  output?: string;
  /** Error marker when the run failed (no profile, spawn, timeout, empty answer). */
  error?: string;
}
