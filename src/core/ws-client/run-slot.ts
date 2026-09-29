/**
 * Run-slot client (ADR-0359) — the cli half of the per-org concurrent AI-run limit. Before an AI CLI
 * process is spawned, `acquireRunSlot` asks the server (`run.slot` acquire) for a slot; over the plan's
 * limit it waits in the org's FIFO queue, retrying with its ticket and reporting its position, and gives
 * up after RUN_SLOT_MAX_WAIT_MS (RUN_QUEUE_TIMEOUT). A granted lease is renewed while the run lasts and
 * released by the returned handle. Any transport error fails OPEN (run without a slot) so a server or
 * cli-server outage never blocks AI work; an older server that doesn't answer behaves the same.
 * A stop while queued (ADR-0362) sends `leave` so the ticket is dropped at once and resolves `cancelled`.
 */
import {
  RUN_SLOT_MAX_WAIT_MS,
  RUN_SLOT_RENEW_MS,
  RUN_SLOT_RETRY_MS,
  WsChannels,
  type RunSlotReply,
} from "@4pm/ws";
import { logger } from "../../common/logger/logger";
import type { WsHandlerCtx } from "./context";

/** A held slot — `release()` stops the renewals and frees it (idempotent). */
export interface RunSlotHandle {
  release(): void;
}

/** Where a queued run stands (shown in the transcript + the web Console). */
export interface RunSlotQueueInfo {
  /** 0-based: how many runs are ahead of this one. */
  position: number;
  limit: number;
  running: number;
}

/**
 * The acquire outcome: a slot (possibly a no-op one — `queued` says whether it waited first), a queue
 * timeout, or a stop while queued (ADR-0362).
 */
export type RunSlotOutcome =
  | { kind: "granted"; handle: RunSlotHandle; queued: boolean }
  | { kind: "timeout"; limit: number }
  | { kind: "cancelled" };

/** A handle with nothing to renew or release (unlimited plan / fail-open). */
const NO_SLOT: RunSlotHandle = { release: () => undefined };

/** Sleep `ms`, resolving early when `signal` aborts (a stop while queued — ADR-0362). */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** Start renewing `lease` and return the handle that stops + releases it. */
function holdLease(ctx: WsHandlerCtx, lease: string): RunSlotHandle {
  const timer = setInterval(() => {
    ctx.request<RunSlotReply>(WsChannels.RUN_SLOT, { op: "renew", lease }).catch(() => undefined);
  }, RUN_SLOT_RENEW_MS);
  timer.unref?.();
  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      clearInterval(timer);
      ctx.request<RunSlotReply>(WsChannels.RUN_SLOT, { op: "release", lease }).catch(() => undefined);
    },
  };
}

/**
 * Acquire a concurrent-run slot for one AI run, waiting in the org's queue when the plan limit is
 * reached. `onQueued` is called whenever the queue position changes. `signal` (ADR-0362) stops the wait:
 * the ticket is dropped (`run.slot {op:"leave"}`) and the outcome is `cancelled`.
 */
export async function acquireRunSlot(
  ctx: WsHandlerCtx,
  onQueued: (info: RunSlotQueueInfo) => void,
  signal?: AbortSignal,
): Promise<RunSlotOutcome> {
  const startedAt = Date.now();
  let ticket: string | undefined;
  let lastPosition = -1;
  let limit = 0;
  for (;;) {
    if (signal?.aborted) return leaveQueue(ctx, ticket);
    let reply: RunSlotReply;
    try {
      reply = await ctx.request<RunSlotReply>(WsChannels.RUN_SLOT, { op: "acquire", ...(ticket ? { ticket } : {}) });
    } catch (err) {
      logger.warn("run.slot.unavailable", { error: (err as Error).message });
      return { kind: "granted", handle: NO_SLOT, queued: ticket !== undefined };
    }
    if (!reply || !("granted" in reply)) return { kind: "granted", handle: NO_SLOT, queued: ticket !== undefined };
    if (reply.granted) {
      const handle = reply.lease ? holdLease(ctx, reply.lease) : NO_SLOT;
      // Stopped while this acquire was in flight: give the slot straight back.
      if (signal?.aborted) {
        handle.release();
        return { kind: "cancelled" };
      }
      return { kind: "granted", handle, queued: ticket !== undefined };
    }
    ticket = reply.ticket;
    limit = reply.limit;
    if (reply.position !== lastPosition) {
      lastPosition = reply.position;
      onQueued({ position: reply.position, limit: reply.limit, running: reply.running });
    }
    if (Date.now() - startedAt >= RUN_SLOT_MAX_WAIT_MS) return { kind: "timeout", limit };
    await sleep(reply.retryAfterMs > 0 ? reply.retryAfterMs : RUN_SLOT_RETRY_MS, signal);
  }
}

/** Drop a stopped run's ticket (if it got one) and report `cancelled` (ADR-0362). Best-effort. */
function leaveQueue(ctx: WsHandlerCtx, ticket: string | undefined): RunSlotOutcome {
  if (ticket) ctx.request<RunSlotReply>(WsChannels.RUN_SLOT, { op: "leave", ticket }).catch(() => undefined);
  return { kind: "cancelled" };
}
