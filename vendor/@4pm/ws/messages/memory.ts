/**
 * MEMORY_UPDATE payload (ADR-0245) — the cli → server write-back of the shared AI memory for the
 * project a link serves. After each AI run the cli compacts `(old memory + latest prompt + answer)`
 * into a budget-bounded rolling summary and sends the new text here; the server upserts it into
 * `ProjectAiMemory` (per project × machine-user link, `rev++`). Empty `text` clears the memory (a
 * `/clear` reset). The read direction is delivered on `ws_token` (seeds the cli cache), so there is
 * no read message here.
 */

/** cli → server: the new compacted memory text for the served project (empty = cleared). */
export interface MemoryUpdatePayload {
  /** The compacted rolling memory (≤ the resolved budget); empty string clears it. */
  text: string;
}
