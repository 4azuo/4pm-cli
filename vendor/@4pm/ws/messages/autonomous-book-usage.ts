/**
 * `autonomous.bookUsage` messages — the org's monthly autonomous-book counters. Before a tick the
 * cli reads them (no `added`) to decide whether the analysis step may add rows; after the tick it reports
 * the rows the agent added per book. cli → server (with reply), relayed by the cli-server to the server's
 * internal gRPC `AutonomousBookUsage`. Book names match the book files (`USER_TODO.md`, …).
 * @adr 0365
 */

/** The capped autonomous books. */
export type AutonomousBookName = "USER_TODO" | "USER_QA" | "AI_TODO";

/** A `autonomous.bookUsage` request: optionally add newly written rows per book. */
export interface AutonomousBookUsageRequest {
  added?: Partial<Record<AutonomousBookName, number>>;
}

/** The counters after the request (`limit` null = unlimited). */
export interface AutonomousBookUsageReply {
  books: Record<AutonomousBookName, { used: number; limit: number | null }>;
  /** Start of the next UTC month — when the counters reset. */
  resetAt: string;
}
