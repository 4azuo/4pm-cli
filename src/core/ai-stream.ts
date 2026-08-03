/**
 * AI stream parser (ADR-0072) — turns a claude `--output-format stream-json --verbose`
 * OR a codex `exec --json` byte stream into human-readable display text while capturing
 * the **real** token usage (claude: the final `result` event; codex: `turn.completed`).
 * Degrades gracefully: any line that is not a recognized JSON event is passed through
 * verbatim, so a plain-text CLI (older claude / codex / a shell) still renders exactly as
 * before and can never be swallowed.
 */

/** Token usage captured from a run (breakdown + total + optional cost). */
export interface AiUsage {
  tokens: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  costUsd?: number;
}

/** A stateful, chunk-fed parser for one AI run. */
export interface AiStreamParser {
  /** Feed a raw stdout chunk; returns the display text to show (may be empty). */
  push(raw: string): string;
  /** Emit any buffered trailing text (call once at end). */
  flush(): string;
  /** The usage captured so far (from the `result` event; zeros until seen). */
  usage(): AiUsage;
}

/** A claude stream-json OR codex `exec --json` event (only the fields we read). */
interface StreamEvent {
  type?: string;
  /** claude: assistant message content parts. */
  message?: { content?: Array<{ type?: string; text?: string }> };
  usage?: {
    // claude `result` usage
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    // codex `turn.completed` usage
    cached_input_tokens?: number;
    reasoning_output_tokens?: number;
  };
  total_cost_usd?: number;
  /** codex: the completed item (agent_message carries the assistant text). */
  item?: { type?: string; text?: string };
}

/** Extract the readable text of an assistant message event. */
function assistantText(ev: StreamEvent): string {
  const parts = ev.message?.content ?? [];
  return parts
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("");
}

/**
 * Create a parser. `cli` selects the format (claude stream-json / codex `exec --json`);
 * anything else passes through unchanged (usage stays zero ⇒ the caller falls back to a
 * length estimate).
 */
export function createAiStreamParser(cli: string): AiStreamParser {
  const isClaude = cli.includes("claude");
  const isCodex = cli.includes("codex");
  const isJson = isClaude || isCodex;
  let buffer = "";
  const acc: AiUsage = { tokens: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };

  /** Handle one claude stream-json event; returns the display text to show. */
  function handleClaude(ev: StreamEvent): string {
    if (ev.type === "result" && ev.usage) {
      acc.input = ev.usage.input_tokens ?? 0;
      acc.output = ev.usage.output_tokens ?? 0;
      acc.cacheRead = ev.usage.cache_read_input_tokens ?? 0;
      acc.cacheCreation = ev.usage.cache_creation_input_tokens ?? 0;
      acc.tokens = acc.input + acc.output;
      if (typeof ev.total_cost_usd === "number") acc.costUsd = ev.total_cost_usd;
      return ""; // final text already streamed via assistant events
    }
    if (ev.type === "assistant") {
      const text = assistantText(ev);
      return text ? `${text}\n` : "";
    }
    return ""; // known but non-visual event (system/user/tool) ⇒ show nothing
  }

  /** Handle one codex `exec --json` event; returns the display text to show. */
  function handleCodex(ev: StreamEvent): string {
    // `turn.completed` carries the run's token usage. codex's `input_tokens` already
    // includes the cached portion (`cached_input_tokens`), so the total is input+output
    // (cacheRead is surfaced for the breakdown only, not re-added). reasoning tokens are
    // billed as output, so they fold into `output`.
    if (ev.type === "turn.completed" && ev.usage) {
      acc.input = ev.usage.input_tokens ?? 0;
      acc.output = (ev.usage.output_tokens ?? 0) + (ev.usage.reasoning_output_tokens ?? 0);
      acc.cacheRead = ev.usage.cached_input_tokens ?? 0;
      acc.cacheCreation = 0;
      acc.tokens = acc.input + acc.output;
      return "";
    }
    // `item.completed` with an `agent_message` item carries the assistant's text.
    if (ev.type === "item.completed" && ev.item?.type === "agent_message") {
      const text = ev.item.text;
      return text ? `${text}\n` : "";
    }
    return ""; // other codex events (thread/turn/item lifecycle) ⇒ show nothing
  }

  /** Try to consume one complete line as a JSON event; return display text or null. */
  function handleLine(line: string): string | null {
    const trimmed = line.trim();
    if (!isJson || !trimmed.startsWith("{")) return null; // not an event ⇒ pass through
    let ev: StreamEvent;
    try {
      ev = JSON.parse(trimmed) as StreamEvent;
    } catch {
      return null; // not JSON ⇒ pass through verbatim
    }
    if (typeof ev.type !== "string") return null;
    return isCodex ? handleCodex(ev) : handleClaude(ev);
  }

  return {
    push(raw: string): string {
      buffer += raw;
      let out = "";
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        const handled = handleLine(line);
        out += handled === null ? `${line}\n` : handled;
      }
      return out;
    },
    flush(): string {
      if (!buffer) return "";
      const line = buffer;
      buffer = "";
      const handled = handleLine(line);
      return handled === null ? line : handled;
    },
    usage: () => ({ ...acc }),
  };
}

/** Estimate tokens from output length (~4 chars/token) — fallback when usage is absent. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}
