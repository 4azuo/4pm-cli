/**
 * `run.slot` messages (ADR-0359) — the per-org concurrent AI-run limit. Before spawning an AI CLI
 * process the cli acquires a slot; over the plan's `maxConcurrentRuns` it gets a FIFO ticket and
 * retries with it until granted. A granted lease is renewed while the process runs and released on
 * exit; a lease/ticket whose cli died simply expires. cli → server (with reply), relayed by the
 * cli-server to the server's internal gRPC `RunSlot`.
 */

/** Lease lifetime (s) — the cli renews every {@link RUN_SLOT_RENEW_MS}. */
export const RUN_SLOT_LEASE_TTL_SEC = 120;
/** How often the cli renews a held lease (ms). */
export const RUN_SLOT_RENEW_MS = 45_000;
/** Liveness of a waiting ticket (s) — refreshed by every queued `acquire` retry. */
export const RUN_SLOT_TICKET_TTL_SEC = 90;
/** Default wait between queued `acquire` retries (ms). */
export const RUN_SLOT_RETRY_MS = 3_000;
/** Longest a run may wait in the queue before it fails with RUN_QUEUE_TIMEOUT (ms). */
export const RUN_SLOT_MAX_WAIT_MS = 30 * 60_000;

/** A `run.slot` request. */
export type RunSlotRequest =
  | { op: "acquire"; ticket?: string }
  | { op: "renew"; lease: string }
  | { op: "release"; lease: string };

/**
 * A `run.slot` reply. `acquire` ⇒ granted (with a lease; `lease: null` = unlimited, nothing to renew or
 * release) or queued (ticket + position); `renew` / `release` ⇒ `{ ok }`.
 */
export type RunSlotReply =
  | { granted: true; lease: string | null; leaseTtlSec: number }
  | { granted: false; ticket: string; position: number; limit: number; running: number; retryAfterMs: number }
  | { ok: boolean };
