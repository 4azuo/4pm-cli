/**
 * WorkTracker — the daemon's single "is anything running?" signal. Every piece of work takes a lease
 * (`begin(kind, label)` … `end()`); `idle()` is true when no lease is open. The update scheduler, the
 * operator restart, idle auto-clear, the git snapshot reporter and the lifecycle drain all read it, so
 * no work (an autonomous cycle's git phases, a clone, a book write) is invisible to a restart.
 * @adr 0505
 */

/** What a lease covers. */
export type WorkKind =
  | "command"
  | "aiRun"
  | "autonomousCycle"
  | "bookWrite"
  | "gitOp"
  | "clone"
  | "toolInstall"
  | "cliUpdate";

/** One open piece of work; `end()` is idempotent. */
export interface WorkLease {
  readonly id: number;
  readonly kind: WorkKind;
  readonly label: string;
  end(): void;
}

/** Tracks the open leases of this process. */
export class WorkTracker {
  private readonly open = new Map<number, WorkLease>();
  private nextId = 1;
  private readonly listeners = new Set<() => void>();

  /** Open a lease for one piece of work. */
  begin(kind: WorkKind, label: string = kind): WorkLease {
    const id = this.nextId++;
    let ended = false;
    const lease: WorkLease = {
      id,
      kind,
      label,
      end: () => {
        if (ended) return;
        ended = true;
        this.open.delete(id);
        this.emit();
      },
    };
    this.open.set(id, lease);
    this.emit();
    return lease;
  }

  /** Run `fn` under a lease that ends when it settles. */
  async track<T>(kind: WorkKind, label: string, fn: () => Promise<T>): Promise<T> {
    const lease = this.begin(kind, label);
    try {
      return await fn();
    } finally {
      lease.end();
    }
  }

  /** True when no lease is open. */
  idle(): boolean {
    return this.open.size === 0;
  }

  /** The distinct kinds of the open leases (reported while draining). */
  kinds(): WorkKind[] {
    return [...new Set([...this.open.values()].map((l) => l.kind))];
  }

  /** The open leases (labels for logs). */
  leases(): WorkLease[] {
    return [...this.open.values()];
  }

  /** Subscribe to lease changes; returns the unsubscribe function. */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Resolve true once idle, or false after `timeoutMs` (0 = check once). */
  waitIdle(timeoutMs: number): Promise<boolean> {
    if (this.idle()) return Promise.resolve(true);
    if (timeoutMs <= 0) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const off = this.onChange(() => {
        if (!this.idle()) return;
        clearTimeout(timer);
        off();
        resolve(true);
      });
      const timer = setTimeout(() => {
        off();
        resolve(this.idle());
      }, timeoutMs);
    });
  }

  /** Notify the listeners (a throwing listener never breaks the tracker). */
  private emit(): void {
    for (const fn of [...this.listeners]) {
      try {
        fn();
      } catch {
        /* a listener error must not affect the lease */
      }
    }
  }
}

/** The process-wide tracker (one daemon per process). */
export const work = new WorkTracker();
