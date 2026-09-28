/**
 * Run-slot client (ADR-0359) — the cli half of the per-org concurrent AI-run limit. Before an AI CLI
 * process is spawned, `acquireRunSlot` asks the server (`run.slot` acquire) for a slot; over the plan's
 * limit it waits in the org's FIFO queue, retrying with its ticket and reporting its position, and gives
 * up after RUN_SLOT_MAX_WAIT_MS (RUN_QUEUE_TIMEOUT). A granted lease is renewed while the run lasts and
 * released by the returned handle. Any transport error fails OPEN (run without a slot) so a server or
 * cli-server outage never blocks AI work; an older server that doesn't answer behaves the same.
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

/** The acquire outcome: a slot (possibly a no-op one) or a queue timeout. */
export type RunSlotOutcome = { kind: "granted"; handle: RunSlotHandle } | { kind: "timeout"; limit: number };

/** A handle with nothing to renew or release (unlimited plan / fail-open). */
const NO_SLOT: RunSlotHandle = { release: () => undefined };

/** Sleep `ms`. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
 * reached. `onQueued` is called whenever the queue position changes.
 */
export async function acquireRunSlot(
  ctx: WsHandlerCtx,
  onQueued: (info: RunSlotQueueInfo) => void,
): Promise<RunSlotOutcome> {
  const startedAt = Date.now();
  let ticket: string | undefined;
  let lastPosition = -1;
  let limit = 0;
  for (;;) {
    let reply: RunSlotReply;
    try {
      reply = await ctx.request<RunSlotReply>(WsChannels.RUN_SLOT, { op: "acquire", ...(ticket ? { ticket } : {}) });
    } catch (err) {
      logger.warn("run.slot.unavailable", { error: (err as Error).message });
      return { kind: "granted", handle: NO_SLOT };
    }
    if (!reply || !("granted" in reply)) return { kind: "granted", handle: NO_SLOT };
    if (reply.granted) {
      return { kind: "granted", handle: reply.lease ? holdLease(ctx, reply.lease) : NO_SLOT };
    }
    ticket = reply.ticket;
    limit = reply.limit;
    if (reply.position !== lastPosition) {
      lastPosition = reply.position;
      onQueued({ position: reply.position, limit: reply.limit, running: reply.running });
    }
    if (Date.now() - startedAt >= RUN_SLOT_MAX_WAIT_MS) return { kind: "timeout", limit };
    await sleep(reply.retryAfterMs > 0 ? reply.retryAfterMs : RUN_SLOT_RETRY_MS);
  }
}
