/**
 * Egress event aggregation (Networks) — the proxy records every logged decision here; decisions are
 * folded per run × host × port × decision × minute and flushed every 60 s as one `network.events` batch
 * to the server (the Networks log). While offline up to {@link MAX_BUFFER} aggregates wait; beyond that the
 * oldest are dropped and the drop count rides on the next batch. A run can watch its own refused connections (a
 * marketing run names the hosts it was refused).
 * @adr 0439 @adr 0646
 */
import type { NetworkDecision, NetworkMode } from "@4pm/dto";
import type { NetworkEventAggregate, NetworkEventsPayload } from "@4pm/ws";

/** Aggregates kept while the server is unreachable. */
export const MAX_BUFFER = 2000;
/** Aggregates per sent batch (the server accepts ≤ 500). */
const BATCH = 500;
/** Flush period. */
const FLUSH_MS = 60_000;

/** Pending aggregates by key. */
const pending = new Map<string, NetworkEventAggregate>();
/** Aggregates dropped since the last successful send. */
let dropped = 0;
/** Sends a batch; returns false when it could not be sent (offline). */
let sink: ((payload: NetworkEventsPayload) => boolean) | null = null;
let timer: NodeJS.Timeout | null = null;
/** Watchers of refused connections, by run id. */
const refusedWatchers = new Map<string, (host: string, port: number) => void>();

/** Call `cb` for each blocked / denied connection of run `runId`; returns the unsubscribe. */
export function watchRefusedEgress(runId: string, cb: (host: string, port: number) => void): () => void {
  refusedWatchers.set(runId, cb);
  return () => {
    if (refusedWatchers.get(runId) === cb) refusedWatchers.delete(runId);
  };
}

/** Register the sender (the WS client) and start the flush timer. */
export function setEgressEventSink(send: (payload: NetworkEventsPayload) => boolean): void {
  sink = send;
  if (!timer) {
    timer = setInterval(() => flushEgressEvents(), FLUSH_MS);
    timer.unref();
  }
}

/** Flush what is pending, then stop the timer and drop the sink (the daemon is shutting down). @adr 0505 */
export function stopEgressEventSink(): void {
  flushEgressEvents();
  if (timer) clearInterval(timer);
  timer = null;
  sink = null;
}

/** Record one decision. */
export function recordEgress(e: {
  host: string;
  port: number;
  decision: NetworkDecision;
  mode: NetworkMode;
  projectId: string | null;
  runId?: string;
  taskId?: string;
}): void {
  if (e.runId && (e.decision === "blocked" || e.decision === "denied")) refusedWatchers.get(e.runId)?.(e.host, e.port);
  const now = new Date();
  const minute = Math.floor(now.getTime() / 60_000);
  const key = [e.runId ?? "", e.taskId ?? "", e.projectId ?? "", e.host, e.port, e.decision, e.mode, minute].join("|");
  const cur = pending.get(key);
  if (cur) {
    cur.count += 1;
    cur.lastAt = now.toISOString();
    return;
  }
  if (pending.size >= MAX_BUFFER) {
    const oldest = pending.keys().next().value;
    if (oldest !== undefined) pending.delete(oldest);
    dropped += 1;
  }
  pending.set(key, {
    host: e.host,
    port: e.port,
    decision: e.decision,
    mode: e.mode,
    count: 1,
    firstAt: now.toISOString(),
    lastAt: now.toISOString(),
    projectId: e.projectId,
    ...(e.runId ? { runId: e.runId } : {}),
    ...(e.taskId ? { taskId: e.taskId } : {}),
  });
}

/** Send what is pending (in ≤ 500 batches); keeps it when the sink is missing or offline. */
export function flushEgressEvents(): void {
  if (!sink || pending.size === 0) return;
  while (pending.size > 0) {
    const keys = [...pending.keys()].slice(0, BATCH);
    const events = keys.map((k) => pending.get(k) as NetworkEventAggregate);
    const ok = sink({ events, ...(dropped ? { dropped } : {}) });
    if (!ok) return;
    for (const k of keys) pending.delete(k);
    dropped = 0;
  }
}

/** Test hook: the pending aggregates. */
export function pendingEgressForTest(): NetworkEventAggregate[] {
  return [...pending.values()];
}

/** Test hook: reset. */
export function resetEgressEventsForTest(): void {
  pending.clear();
  dropped = 0;
  sink = null;
  if (timer) clearInterval(timer);
  timer = null;
}
