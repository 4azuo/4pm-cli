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
import { autoUpdateFlaggedTools, resolveInstallTimeoutMs } from "./worker-tools";
import type { SessionBus } from "./session-bus";
import { t } from "../i18n";

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
  /** A push/connect-triggered update requested now (ADR-0289) — runs when idle, independent of the
   *  daily policy; cleared once it runs. */
  private forcedPending = false;
  /** Guards against a second update while one is in flight. */
  private updating = false;

  constructor(
    private readonly serverUrl: string,
    private readonly profileDir: string,
    private readonly bus: SessionBus,
    /** Called after the idle tick reconciles the flagged tools, so the cli reports its new snapshot (ADR-0254). */
    private readonly onToolsChanged?: () => void,
  ) {}

  /** Apply the latest policy (called on each ws_token) and start the tick timer once. */
  configure(policy: AutoUpdatePolicy): void {
    this.policy = policy;
    if (!this.timer) {
      this.timer = setInterval(() => void this.tick(), TICK_MS);
      this.timer.unref?.(); // don't keep the process alive just for the scheduler
    }
  }

  /**
   * Request an update to latest NOW (ADR-0289) — the server's `cli.update` push or the
   * update-on-connect hook. Idle-aware like the daily tick (defers while a command runs) and
   * honours the local `autoUpdate:false` opt-out, but is independent of the daily org policy. Also
   * ensures the tick timer is running so the request is served even before the first ws_token.
   */
  updateNow(): void {
    if (this.optedOutLocally()) {
      logger.info("update.push.optedOut");
      return;
    }
    if (CLI_VERSION.startsWith("0.0.0")) return; // dev build never self-updates (ADR-0052)
    this.forcedPending = true;
    if (!this.timer) {
      this.timer = setInterval(() => void this.tick(), TICK_MS);
      this.timer.unref?.();
    }
    void this.tick();
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

  /** One evaluation: run a forced (push/connect) update if pending, else the daily-scheduled one. */
  private async tick(): Promise<void> {
    if (this.updating) return;
    // Dev build (unstamped 0.0.0 — ADR-0052) never self-updates.
    if (CLI_VERSION.startsWith("0.0.0")) return;
    if (this.optedOutLocally()) return;

    // A pushed / connect-triggered update (ADR-0289) runs as soon as the cli is idle, independent of
    // the daily policy — so a manual "Update" or an outdated reconnect updates promptly.
    if (this.forcedPending) {
      if (this.bus.busy !== null) return; // defer until the running command finishes
      this.forcedPending = false;
      await this.runUpdate();
      return;
    }

    const p = this.policy;
    if (!p || !p.autoUpdateDaily) return;

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
      // Per-tool worker auto-update (ADR-0253) runs FIRST — the cli self-update below re-execs the
      // process on success, which would otherwise skip the flagged tools. Best-effort; a failed tool
      // never blocks the cli update. Shares this org-gated, idle-only window (ADR-0074).
      await this.updateFlaggedTools();
      this.bus.log(t("update.scheduledChecking"));
      const result = await updateToLatest(this.serverUrl);
      if (result.action === "already-latest") {
        logger.info("update.scheduled.latest", { version: result.version });
        return;
      }
      if (result.action === "failed") {
        logger.warn("update.scheduled.failed", { error: result.error });
        this.bus.log(t("update.scheduledFailed", { error: result.error ?? "" }), "warn");
        return;
      }
      // Updated ⇒ re-exec into the new binary — same as `4pm start`'s auto-update branch
      // (FOURPM_NO_UPDATE=1 skips the redundant startup check on the child).
      logger.info("update.scheduled.updated", { version: result.version });
      this.bus.log(t("update.scheduledUpdated", { version: result.version ?? "" }));
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

  /** Update each tool flagged for auto-update in config.json to @latest (ADR-0253) — best-effort. */
  private async updateFlaggedTools(): Promise<void> {
    const config = readProfileConfig(this.profileDir);
    const tools = config.autoUpdateTools ?? [];
    if (tools.length === 0) return;
    this.bus.log(t("update.scheduledTools", { tools: tools.join(", ") }));
    const timeoutMs = resolveInstallTimeoutMs(config.toolInstallTimeoutSec);
    await autoUpdateFlaggedTools(tools, (line) => logger.info("update.tool.line", { line }), timeoutMs).catch(
      (err: unknown) => logger.warn("update.tool.error", { error: String(err) }),
    );
    // Report the (possibly changed) tool snapshot to the server (ADR-0254).
    this.onToolsChanged?.();
  }
}
