/**
 * UpdateScheduler — runs the org-configured daily cli auto-update (ADR-0074). The policy
 * is fed from each ws_token; at the target hour (resolved to the org timezone) it updates
 * when the cli is idle — deferring while a command runs so a job is never interrupted —
 * then re-execs the new binary (keeps `.cre`/profile, so the session reconnects). A Node
 * process cannot hot-swap its own code, so re-exec is the seamless equivalent of "no
 * restart". Gated by the org toggle AND the machine's local opt-out (`autoUpdate:false`).
 */
import { spawn } from "node:child_process";
import { logger } from "../common/logger/logger";
import { CLI_VERSION } from "../version";
import { readProfileConfig } from "../config/profile";
import { updateToLatest } from "./update";
import type { SessionBus } from "./session-bus";

/** How often the scheduler re-evaluates whether the daily update is due (ms). */
const TICK_MS = 60_000;

/** Org-configured daily auto-update policy carried by the ws_token (ADR-0074). */
export interface AutoUpdatePolicy {
  autoUpdateDaily: boolean;
  autoUpdateHour: number;
  timezone: string;
}

export class UpdateScheduler {
  private policy: AutoUpdatePolicy | null = null;
  private timer: NodeJS.Timeout | null = null;
  /** Date key (YYYY-MM-DD in org tz) whose update already ran — enforces once per day. */
  private lastDoneDateKey: string | null = null;
  /** Date key marked due but deferred because the cli was busy (stays set past the hour). */
  private pendingDateKey: string | null = null;
  /** Guards against a second update while one is in flight. */
  private updating = false;

  constructor(
    private readonly serverUrl: string,
    private readonly profileDir: string,
    private readonly bus: SessionBus,
  ) {}

  /** Apply the latest policy (called on each ws_token) and start the tick timer once. */
  configure(policy: AutoUpdatePolicy): void {
    this.policy = policy;
    if (!this.timer) {
      this.timer = setInterval(() => void this.tick(), TICK_MS);
      this.timer.unref?.(); // don't keep the process alive just for the scheduler
    }
  }

  /** Stop the scheduler when the session ends (logout / replaced / stopped). */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Local machine opt-out honored on top of the org toggle (ADR-0074). */
  private optedOutLocally(): boolean {
    return readProfileConfig(this.profileDir).autoUpdate === false;
  }

  /** `{ hour, dateKey }` for now, resolved to the org timezone (ADR-0074). */
  private orgClock(): { hour: number; dateKey: string } | null {
    const tz = this.policy?.timezone || "UTC";
    try {
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: tz,
        hour12: false,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
      }).formatToParts(new Date());
      const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
      const hour = Number.parseInt(get("hour"), 10);
      const dateKey = `${get("year")}-${get("month")}-${get("day")}`;
      if (Number.isNaN(hour)) return null;
      return { hour: hour % 24, dateKey };
    } catch {
      return null;
    }
  }

  /** One evaluation: mark the update due at the target hour, then update once idle. */
  private async tick(): Promise<void> {
    const p = this.policy;
    if (!p || !p.autoUpdateDaily || this.updating) return;
    // Dev build (unstamped 0.0.0 — ADR-0052) never self-updates.
    if (CLI_VERSION.startsWith("0.0.0")) return;
    if (this.optedOutLocally()) return;

    const clock = this.orgClock();
    if (!clock) return;
    if (clock.dateKey === this.lastDoneDateKey) return; // already handled today

    // Mark today's update due once the target hour arrives; it stays pending past the
    // hour so a busy cli still updates when it next goes idle (ADR-0074).
    if (this.pendingDateKey !== clock.dateKey && clock.hour === p.autoUpdateHour) {
      this.pendingDateKey = clock.dateKey;
      logger.info("update.scheduled.due", { dateKey: clock.dateKey, hour: p.autoUpdateHour });
    }
    if (this.pendingDateKey !== clock.dateKey) return; // not due yet today

    // A command is running ⇒ defer until idle rather than interrupt the job (ADR-0074).
    if (this.bus.busy !== null) return;

    this.lastDoneDateKey = clock.dateKey;
    this.pendingDateKey = null;
    await this.runUpdate();
  }

  /** Check + update, then re-exec the new binary on success (keeps `.cre`/profile). */
  private async runUpdate(): Promise<void> {
    this.updating = true;
    try {
      this.bus.log("Scheduled auto-update: checking for a new version…");
      const result = await updateToLatest(this.serverUrl);
      if (result.action === "already-latest") {
        logger.info("update.scheduled.latest", { version: result.version });
        return;
      }
      if (result.action === "failed") {
        logger.warn("update.scheduled.failed", { error: result.error });
        this.bus.log(`Scheduled auto-update failed: ${result.error}`, "warn");
        return;
      }
      // Updated ⇒ re-exec into the new binary — same as `4pm start`'s auto-update branch
      // (FOURPM_NO_UPDATE=1 skips the redundant startup check on the child).
      logger.info("update.scheduled.updated", { version: result.version });
      this.bus.log(`Updated to ${result.version} — restarting to apply…`);
      const child = spawn(process.execPath, process.argv.slice(1), {
        stdio: "inherit",
        env: { ...process.env, FOURPM_NO_UPDATE: "1" },
      });
      child.on("exit", (code) => process.exit(code ?? 0));
    } catch (err) {
      logger.warn("update.scheduled.error", { error: String(err) });
    } finally {
      this.updating = false;
    }
  }
}
