/**
 * The daemon lifecycle: one state machine (`boot → connecting ⇄ connected → draining → stopped`) and a
 * registry of the background services, so that every way of ending the session goes through one
 * `shutdown(reason)` that drains running work and then stops **every** service. Nothing started by the
 * daemon can outlive it (no timer, server or socket left in a restart's parent process).
 * @adr 0505
 */
import { logger } from "../../common/logger/logger";
import { work, type WorkKind } from "./work-tracker";

/** Where the daemon is in its life. */
export type LifecycleState = "boot" | "connecting" | "connected" | "draining" | "stopped";

/** Why the daemon is shutting down. */
export type ShutdownReason =
  | "restart"
  | "update"
  | "logout"
  | "replaced"
  | "versionRejected"
  | "insecureTransport"
  | "signal"
  | "quit";

/**
 * When a service runs: `process` = boot → stopped; `session` = while connected (stopped on every
 * disconnect, started again on reconnect); `engine` = while connected and not draining.
 */
export type ServiceScope = "process" | "session" | "engine";

/** A registered background service — only its stop is needed (it is started by its owner). */
interface Service {
  name: string;
  scope: ServiceScope;
  stop: () => void | Promise<void>;
}

/** Shutdown options. */
export interface ShutdownOptions {
  /** How long to wait for running work before cancelling it (ms). */
  drainMs: number;
  /** After the cancel hooks ran, how long to wait for the cancelled work to finish (ms). */
  cancelGraceMs?: number;
}

/** Default extra wait after cancelling work at the drain bound (ms). */
const DEFAULT_CANCEL_GRACE_MS = 120_000;

/** The lifecycle of this daemon process. */
export class Lifecycle {
  private current: LifecycleState = "boot";
  private why: ShutdownReason | null = null;
  /** Insertion order = start order; stopped in reverse. */
  private readonly services = new Map<string, Service>();
  private readonly listeners = new Set<(state: LifecycleState) => void>();
  private readonly cancelHooks: Array<() => void> = [];
  private sessionCloser: (() => void | Promise<void>) | null = null;
  private shutdownPromise: Promise<void> | null = null;
  /** Kinds still open while draining (reported in machine.status). */
  private drainingKinds: WorkKind[] = [];

  /** The current state. */
  get state(): LifecycleState {
    return this.current;
  }

  /** The shutdown reason, once a shutdown started. */
  get reason(): ShutdownReason | null {
    return this.why;
  }

  /** True while draining or stopped — no new work may start. */
  get stopping(): boolean {
    return this.current === "draining" || this.current === "stopped";
  }

  /** Lease kinds the drain is waiting for (empty unless draining). */
  get drainingFor(): WorkKind[] {
    return this.current === "draining" ? this.drainingKinds : [];
  }

  /**
   * Register a service's stop under a unique name. Registering a name again replaces the entry (a
   * session service re-registers on every reconnect). Returns an unregister function.
   */
  register(name: string, scope: ServiceScope, stop: () => void | Promise<void>): () => void {
    this.services.delete(name);
    this.services.set(name, { name, scope, stop });
    return () => {
      if (this.services.get(name)?.stop === stop) this.services.delete(name);
    };
  }

  /** Whether a service name is registered (tests / diagnostics). */
  has(name: string): boolean {
    return this.services.has(name);
  }

  /** Names of the registered services, in start order (tests / diagnostics). */
  serviceNames(scope?: ServiceScope): string[] {
    return [...this.services.values()].filter((s) => !scope || s.scope === scope).map((s) => s.name);
  }

  /** The hook that closes the WS session for good (set by the WS client). */
  setSessionCloser(fn: () => void | Promise<void>): void {
    this.sessionCloser = fn;
  }

  /** Register a hook run when the drain bound is reached (e.g. cancel the AI runs). */
  onDrainTimeout(fn: () => void): void {
    this.cancelHooks.push(fn);
  }

  /** Subscribe to state changes; returns the unsubscribe function. */
  onState(fn: (state: LifecycleState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * The WS session went up or down. Ignored once draining. Going down stops the session-scoped
   * services (they are started again by the next connect).
   */
  setConnected(connected: boolean): void {
    if (this.stopping) return;
    this.set(connected ? "connected" : "connecting");
    if (!connected) void this.stopScope("session");
  }

  /** Stop and unregister every service of one scope, in reverse start order. */
  async stopScope(scope: ServiceScope): Promise<void> {
    const list = [...this.services.values()].filter((s) => s.scope === scope).reverse();
    for (const s of list) {
      this.services.delete(s.name);
      try {
        await s.stop();
      } catch (err) {
        logger.warn("lifecycle.service.stopFailed", { service: s.name, error: String(err) });
      }
    }
  }

  /**
   * Drain then stop everything. Idempotent: a second call (another reason) returns the first
   * shutdown's promise. Steps: `draining` (engine services stop, callers refuse new work) → wait for
   * the WorkTracker to go idle (≤ `drainMs`; then run the cancel hooks and wait ≤ `cancelGraceMs`) →
   * stop the session services, close the WS, stop the process services → `stopped`.
   */
  shutdown(reason: ShutdownReason, opts: ShutdownOptions): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.why = reason;
    this.shutdownPromise = this.run(reason, opts);
    return this.shutdownPromise;
  }

  /** The body of {@link shutdown}. */
  private async run(reason: ShutdownReason, opts: ShutdownOptions): Promise<void> {
    this.drainingKinds = work.kinds();
    const offWork = work.onChange(() => {
      this.drainingKinds = work.kinds();
    });
    this.set("draining");
    logger.info("lifecycle.state", { state: "draining", reason, pid: process.pid, leases: work.leases().map((l) => l.label) });
    await this.stopScope("engine");
    let idle = await work.waitIdle(opts.drainMs);
    if (!idle) {
      logger.warn("lifecycle.drain.timeout", { reason, leases: work.leases().map((l) => `${l.kind}:${l.label}`) });
      for (const fn of this.cancelHooks) {
        try {
          fn();
        } catch (err) {
          logger.warn("lifecycle.cancel.failed", { error: String(err) });
        }
      }
      idle = await work.waitIdle(opts.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS);
      if (!idle) logger.warn("lifecycle.drain.abandoned", { leases: work.leases().map((l) => `${l.kind}:${l.label}`) });
    }
    offWork();
    await this.stopScope("session");
    try {
      await this.sessionCloser?.();
    } catch (err) {
      logger.warn("lifecycle.session.closeFailed", { error: String(err) });
    }
    await this.stopScope("process");
    this.set("stopped");
    logger.info("lifecycle.state", { state: "stopped", reason, pid: process.pid });
  }

  /** Change state and notify. */
  private set(state: LifecycleState): void {
    if (this.current === state) return;
    this.current = state;
    for (const fn of [...this.listeners]) {
      try {
        fn(state);
      } catch {
        /* a listener error must not break the lifecycle */
      }
    }
  }
}

/** The process-wide lifecycle (one daemon per process). */
export const lifecycle = new Lifecycle();
