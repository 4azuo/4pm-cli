/**
 * Operator restart (`cli.restart`): asks `4pm start` to restart the daemon. The restart is a lifecycle
 * drain — new work is refused at once and the running work (commands, AI runs, an autonomous cycle,
 * book writes, clones) finishes first — so a running job is never interrupted and a busy worker is not
 * starved of its restart by new work arriving.
 * @adr 0497 @adr 0505
 */
import { logger } from "../../common/logger/logger";
import { t } from "../../i18n";
import type { SessionBus } from "./session-bus";
import { work } from "./work-tracker";

export class RestartWhenIdle {
  private pending = false;

  constructor(private readonly bus: SessionBus) {}

  /** Request a restart; the drain waits for running work. A repeat while pending is a no-op. */
  request(): void {
    if (this.pending) return;
    this.pending = true;
    logger.info("restart.requested", { leases: work.leases().map((l) => l.label) });
    this.bus.log(work.idle() ? t("restart.now") : t("restart.waiting"));
    this.bus.requestRestart("restart");
  }

  /** Forget a pending request (the daemon is shutting down anyway). */
  stop(): void {
    this.pending = false;
  }
}
