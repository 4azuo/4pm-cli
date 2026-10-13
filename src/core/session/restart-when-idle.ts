/**
 * Operator restart (`cli.restart`): marks a restart pending and, at the cli's first idle moment — no
 * busy command and no queued/running AI run — asks `4pm start` to re-exec the same binary through the
 * SessionBus restart handoff (keeps `.cre`/profile, reconnects). A running job is never interrupted.
 * @adr 0497 @adr 0473
 */
import { logger } from "../../common/logger/logger";
import { t } from "../../i18n";
import type { SessionBus } from "./session-bus";

/** Re-check interval while waiting — AI-run bookkeeping has no event of its own (ms). */
const POLL_MS = 2_000;

export class RestartWhenIdle {
  private pending = false;
  private timer: NodeJS.Timeout | null = null;
  private offBusy: (() => void) | null = null;

  constructor(
    private readonly bus: SessionBus,
    /** In-flight AI runs (queued or running). */
    private readonly activeAiRuns: () => number,
  ) {}

  /** Request a restart: now when idle, else once the running work finishes. A repeat while pending is a no-op. */
  request(): void {
    if (this.pending) return;
    this.pending = true;
    logger.info("restart.requested", { busy: this.bus.busy, aiRuns: this.activeAiRuns() });
    if (this.tryRestart()) return;
    this.bus.log(t("restart.waiting"));
    this.offBusy = this.bus.onBusy(() => void this.tryRestart());
    this.timer = setInterval(() => void this.tryRestart(), POLL_MS);
    this.timer.unref?.();
  }

  /** Fire the restart handoff when pending and idle; true once fired. */
  private tryRestart(): boolean {
    if (!this.pending || this.bus.busy !== null || this.activeAiRuns() > 0) return false;
    this.pending = false;
    this.offBusy?.();
    this.offBusy = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    logger.info("restart.firing");
    this.bus.log(t("restart.now"));
    this.bus.requestRestart();
    return true;
  }
}
