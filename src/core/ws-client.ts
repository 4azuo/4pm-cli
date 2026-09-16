/**
 * The cli's WS client (arch 0011): request ws_token → open WS → ECDH handshake →
 * send machine.status; heartbeat ping every 30s; reconnect with backoff + jitter;
 * LINK_REVOKED/HASHCODE_EXPIRED ⇒ logout (delete .cre). HASHCODE_INVALID is treated
 * as transient (a token re-issue racing a reconnect) and retried (bounded) before
 * giving up — cli-ws 0001.
 *
 * This file owns the **session lifecycle**: connect/reconnect, the control-message +
 * channel router, encrypted send/request, the offline buffer, heartbeat + usage/log/KB
 * timers, console-sync + worker-metrics leases, and logout. The channel handlers and the
 * AI/command dispatch path are extracted into `./ws-client/*` as pure functions over a
 * `WsHandlerCtx` this class builds (see `buildHandlerCtx`).
 */
import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import WebSocket from "ws";
import { backoffJitterMs } from "@4pm/utils";
import {
  type ConsoleSyncEvent,
  type TranscriptEntry as DtoTranscriptEntry,
  type MachineMetricsPayload,
} from "@4pm/dto";
import { createWorkerMetricsSampler } from "./worker-metrics";
import {
  createEcdhSession,
  decryptPayload,
  deriveSessionKey,
  encryptPayload,
  WsChannels,
  type EcdhSession,
  type ImageFetchReply,
  type ImageFetchRequest,
  type MachineLogPayload,
  type MachineUsagePayload,
  type QuotaCheckReply,
  type ToolRestoreFailureItem,
  type ToolsReportPayload,
  type UsageReportPayload,
  type WsChannelName,
  type WsControlMessage,
  type WsEnvelope,
} from "@4pm/ws";
import { deleteCredential, writeCredential, type Credential } from "./credential";
import type { MachineFingerprint } from "./fingerprint";
import type { SessionBus } from "./session-bus";
import { UpdateScheduler } from "./update-scheduler";
import { CliApiError, requestWsToken } from "../services/api";
import { getWorkingProfile } from "./ai-profile-state";
import { INSECURE_URL_BLOCKED, insecureTransportAllowed, isInsecureRemoteUrl } from "../utils/secure-url";
import { t } from "../i18n";
import { claudeHomeDirs } from "../utils/ai-cli";
import { checkClaudeUsage } from "./claude-usage";
import { pruneCommandHistoryByAge } from "./command-history";
import { sweepOldAttachments } from "./command-images";
import { pruneCommandOutputByAge } from "./command-output-store";
import { refreshSupportKb } from "./support-answer";
import { setToolHealthSink } from "./tool-health";
import { isAutonomousRunning } from "./autonomous";
import { probeNetwork } from "./network-probe";
import { applyGitAuth } from "./git-auth";
import { readProfileConfig, writeProfileConfig } from "../config/profile";
import { detectWorkerTools } from "./worker-tools";
import { logger, readLogUpload } from "../common/logger/logger";
import { CLI_VERSION } from "../version";
import { envReconnectMaxSec, toDtoEntry } from "./ws-client/transcript";
import type { WsHandlerCtx } from "./ws-client/context";
import { handleCommandChannels, resetMemorySession, runLocalCommand } from "./ws-client/command-dispatch";
import { handleFsChannels } from "./ws-client/handlers/fs";
import { handleGitChannels } from "./ws-client/handlers/git";
import { handleMiscChannels } from "./ws-client/handlers/misc";
import { handleProjectChannels } from "./ws-client/handlers/project";
import { handleSupportChannels } from "./ws-client/handlers/support";
import { handleToolsChannels } from "./ws-client/handlers/tools";
import { handleWorkerChannels } from "./ws-client/handlers/worker";

const HEARTBEAT_MS = 30_000;
/** How often to poll the Claude subscription usage API (ADR-0072). */
const USAGE_POLL_MS = 5 * 60_000;

/** How often the cli uploads its own JSONL log to the server (ADR-0122). */
const LOG_UPLOAD_MS = 10 * 60_000;
/** How often a support agent refreshes (git pull) its cloned FAQ/KB repo (ADR-0170). */
const KB_REFRESH_MS = 24 * 60 * 60_000;

/** Base delay (ms) for the exponential reconnect backoff. */
const RECONNECT_BACKOFF_BASE_MS = 1_000;
/** Fallback cap (seconds) when neither the org nor an env var sets one. */
const RECONNECT_MAX_BACKOFF_DEFAULT_SEC = 60;
/**
 * Attempt clamp for the backoff exponent — high enough for `base·2^attempt` to reach
 * the 1-min ceiling (2^6·1s = 64s ⇒ clamped by maxMs), so any cap is reachable.
 */
const RECONNECT_BACKOFF_MAX_ATTEMPT = 6;

/**
 * Consecutive HASHCODE_INVALID token rejections tolerated before giving up (logout).
 * HASHCODE_INVALID can be transient (e.g. a token re-issue racing a reconnect), so it
 * is retried with backoff rather than deleting `.cre` on the first occurrence.
 */
const MAX_HASHCODE_INVALID_RETRIES = 5;

/** Close code server draining (graceful shutdown). */
const CLOSE_DRAINING = 4001;

/** Output buffer cap while disconnected (JSON bytes) — over the cap drops the oldest. */
const OFFLINE_BUFFER_MAX_BYTES = 512 * 1024;

/**
 * While a web Console viewer is attached (console.watch on), re-send a full transcript snapshot
 * this often (ADR-0150) — the self-heal against any dropped add/update/clear event; live edits
 * stream immediately, so this only bounds worst-case drift.
 */
const CONSOLE_SNAPSHOT_INTERVAL_MS = 30_000;

/**
 * console.watch is a renewable **lease** (ADR-0150): the server re-asserts it (~every 15s) while
 * any viewer is attached; the cli stops syncing if no renewal arrives within this window. A lease
 * (vs an explicit on/off) is multi-instance-safe — no server needs a shared viewer count, and a
 * cli reconnect self-heals on the next renewal.
 */
const CONSOLE_WATCH_LEASE_MS = 45_000;

/**
 * Worker resource metrics (ADR-0214): while a viewer has the Workers tab open the server re-asserts
 * `metrics.watch` (~every 15s) and the cli emits a `machine.metrics` sample this often; it stops if
 * no renewal arrives within the lease window. Same lease shape as `console.watch` — viewer-gated so
 * an unwatched cli samples nothing.
 */
const METRICS_SAMPLE_INTERVAL_MS = 5_000;
const METRICS_WATCH_LEASE_MS = 45_000;

/** WsClient run context — credential + machine identity + profile + session bus. */
export interface WsClientContext {
  credential: Credential;
  machine: MachineFingerprint;
  profileDir: string;
  /** Presentation bridge (ADR-0057): lifecycle logs, command I/O, local input. */
  bus: SessionBus;
}

export class WsClient {
  private socket: WebSocket | null = null;
  private sessionKey: Buffer | null = null;
  // True once the current connectOnce() reached hello_ack — a *real* session. Gates the
  // backoff reset so a socket that opens then closes before the handshake keeps backing off
  // instead of hammering the server every ~1s.
  private sessionEstablished = false;
  private ecdh: EcdhSession | null = null;
  private wsToken = "";
  /** Warn about a plaintext-remote server URL only once per process (ADR-0194 finding #1). */
  private heartbeat: NodeJS.Timeout | null = null;
  private usageTimer: NodeJS.Timeout | null = null;
  private logUploadTimer: NodeJS.Timeout | null = null;
  private kbRefreshTimer: NodeJS.Timeout | null = null;
  /** Signature (fileName + totalBytes) of the last log upload — skip re-sending if unchanged. */
  private lastLogSig: string | null = null;
  private usageSnapshot: MachineUsagePayload | null = null;
  /** Whether the serving project requires outbound review before each AI spawn (ADR-0082). */
  private outboundReviewEnabled = false;
  /**
   * Whether the serving project restricts the AI to its worker folder (project aiScope) —
   * when true the cli prepends a folder-scope guard to every AI prompt. Fed by each ws_token.
   */
  private restrictToFolder = false;
  /**
   * Shared AI memory (ADR-0245) cache for the served project: the rolling compacted text (seeded by
   * `ws_token`, updated after each run) + the last native `session_id` per credential key (for
   * `--resume` on the same profile). Per (project × link) — this cli instance is one link.
   */
  private aiMemory = "";
  private readonly sessionIdByKey = new Map<string, string>();
  private stopped = false;
  /** Resolver to wake the backoff sleep early (set while waiting) — for /reconnect. */
  private wakeReconnect: (() => void) | null = null;
  /** When set, the next backoff sleep returns immediately (forced reconnect). */
  private forceReconnect = false;
  /**
   * The single "reconnecting…" transcript line for the current outage (approach B): created on
   * the first failed attempt and updated in place each retry, then finalized to the "connected"
   * line on the next hello_ack — so one outage adds one line, not an error + a wait line per
   * attempt. Null while connected / between outages.
   */
  private reconnectEntryId: string | null = null;
  /** Org-configured reconnect cap (seconds) from the last ws_token — overrides env. */
  private orgReconnectMaxSec: number | null = null;
  /** Org timezone (IANA) from the last ws_token (ADR-0132) — a rented worker follows its renter's
   *  org; used to stamp the AI-run start time on the `aireq` transcript marker (ADR-0249). */
  private orgTimezone = "UTC";
  /** Env override for the reconnect cap (seconds); resolved once at construction. */
  private readonly envReconnectMaxSec = envReconnectMaxSec();
  /** Process start (ms) — uptime for a web-dispatched `/status` (ADR-0249). */
  private readonly startedAtMs = Date.now();
  private readonly credential: Credential;
  /** The physic project folder root this cli serves (null = no project) — fs.list is
   *  scoped to it so the web FsPicker can only browse inward, never out. */
  private physicRoot: string | null = null;
  /** This machine-user's username — the git commit author for this project (ADR-0097).
   *  Push uses the account already logged in with gh/glab on the worker. */
  private machineUsername = "";
  /** Waiters resolved when the session next becomes connected (readiness gate before
   *  running a local prompt). */
  private connectWaiters: Array<() => void> = [];
  /** Output buffered while disconnected (flushed on reconnect). */
  private readonly offlineBuffer: { channel: WsChannelName; data: unknown }[] = [];
  /**
   * Command ids already accepted (insertion-ordered, bounded). WS delivery is at-least-once —
   * a redelivered `COMMAND_DISPATCH` (reconnect/blip during a long AI run) must NOT run again:
   * re-running an AI prompt would waste tokens and echo the prompt a second time in the console.
   */
  private readonly handledCommands = new Set<string>();
  private offlineBufferBytes = 0;
  /**
   * Console-sync state (ADR-0150). `consoleWatching` is set by `console.watch` from the server
   * (a web Console viewer is attached); only then does the cli emit `console.sync`. `consoleRev`
   * is the monotonic revision the web uses to detect a gap; `consoleSnapshotTimer` periodically
   * re-sends a full snapshot to self-heal. Watching resets to false on each reconnect (the server
   * re-asserts it), so a fresh session re-snapshots.
   */
  private consoleWatching = false;
  private consoleRev = 0;
  private consoleSnapshotTimer: NodeJS.Timeout | null = null;
  /** Lease expiry: stop syncing if the server does not renew `console.watch` in time. */
  private consoleWatchExpiry: NodeJS.Timeout | null = null;
  /**
   * Worker-metrics state (ADR-0214). `metricsWatching` is set by `metrics.watch` (a viewer has the
   * Workers tab open); only then does the cli sample + emit `machine.metrics`. The sampler holds the
   * CPU-delta baseline; both timers are lease-driven like console-sync and reset on reconnect.
   */
  private metricsWatching = false;
  private metricsTimer: NodeJS.Timeout | null = null;
  private metricsWatchExpiry: NodeJS.Timeout | null = null;
  /** Lazily created on the first `metrics.watch` (keeps the CPU-delta baseline across samples). */
  private metricsSampler: ReturnType<typeof createWorkerMetricsSampler> | null = null;
  /** cli → server requests awaiting a reply (quota.check — ADR-0020). */
  private readonly pending = new Map<
    string,
    { resolve: (payload: unknown) => void; timer: NodeJS.Timeout }
  >();

  /** Daily scheduled cli auto-update (ADR-0074); policy fed from each ws_token. */
  private readonly updateScheduler: UpdateScheduler;

  /** The narrow host handed to the extracted channel handlers + command-dispatch (built once). */
  private readonly hctx: WsHandlerCtx;

  /** Shortcut to the presentation bridge (ADR-0057). */
  private get bus(): SessionBus {
    return this.context.bus;
  }

  /** True once the session stopped for good (logout / replaced / version) — the
   *  resilient run wrapper uses this to tell a clean stop from a crash to recover from. */
  get isStopped(): boolean {
    return this.stopped;
  }

  constructor(private readonly context: WsClientContext) {
    this.credential = context.credential;
    this.updateScheduler = new UpdateScheduler(
      context.credential.serverUrl,
      context.profileDir,
      context.bus,
      // After the idle daily tick updates flagged tools, report the fresh snapshot (ADR-0254). The
      // `daily` trigger lets the server re-drive a still-failing restore on this spaced tick (ADR-0258).
      () => void this.reportWorkerTools("daily"),
    );
    this.hctx = this.buildHandlerCtx();
    // The operator's local commands (TUI input box) run through the same executor.
    context.bus.onLocalSubmit((input) => void runLocalCommand(this.hctx, input));
    // /reconnect ⇒ drop the socket / wake the backoff so the loop reconnects now.
    context.bus.onReconnect(() => this.reconnectNow());
    // Console sync (ADR-0150): mirror the authoritative transcript to the server while a web
    // Console viewer is attached (console.watch). The subscriptions are always live but only
    // send when watching — no cost when unwatched.
    context.bus.onTranscript((entry) => this.emitConsole({ kind: "add", entry: toDtoEntry(entry) }));
    context.bus.onTranscriptUpdate((entry) =>
      this.emitConsole({ kind: "update", entry: toDtoEntry(entry) }),
    );
    context.bus.onClear(() => this.emitConsoleClear());
    // A manual `/clear` (not idle auto-clear) resets the shared AI memory + native sessions (ADR-0245).
    context.bus.onClearSession(() => resetMemorySession(this.hctx));
  }

  /**
   * Build the `WsHandlerCtx` the extracted handlers use: live getters/setters over this
   * client's private state + bound methods. Built once in the constructor so the handler
   * modules never reach into the class internals directly.
   */
  private buildHandlerCtx(): WsHandlerCtx {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return {
      bus: this.context.bus,
      profileDir: this.context.profileDir,
      serverUrl: this.context.credential.serverUrl,
      startedAtMs: this.startedAtMs,
      sessionIdByKey: this.sessionIdByKey,
      get machineUsername() {
        return self.machineUsername;
      },
      get orgTimezone() {
        return self.orgTimezone;
      },
      get usageSnapshot() {
        return self.usageSnapshot;
      },
      get outboundReviewEnabled() {
        return self.outboundReviewEnabled;
      },
      get restrictToFolder() {
        return self.restrictToFolder;
      },
      get isReady() {
        return !!self.sessionKey && self.bus.status === "connected";
      },
      get isStopped() {
        return self.stopped;
      },
      get physicRoot() {
        return self.physicRoot;
      },
      set physicRoot(value: string | null) {
        self.physicRoot = value;
      },
      get aiMemory() {
        return self.aiMemory;
      },
      set aiMemory(value: string) {
        self.aiMemory = value;
      },
      setRestrictToFolder: (value) => {
        self.restrictToFolder = value;
      },
      hasHandledCommand: (commandId) => self.handledCommands.has(commandId),
      markCommandHandled: (commandId) => self.markCommandHandled(commandId),
      send: (channel, data, replyTo) => self.send(channel, data, replyTo ?? null),
      request<T>(channel: WsChannelName, data: unknown): Promise<T> {
        return self.request<T>(channel, data);
      },
      imageFetch: (commandId, imageId) => self.imageFetch(commandId, imageId),
      reportUsage: (events, profile) => self.reportUsage(events, profile),
      reportWorkerTools: (trigger, restoreFailed) => self.reportWorkerTools(trigger, restoreFailed),
      uploadLog: () => self.uploadLog(),
      pollUsage: () => self.pollUsage(),
      reconnectNow: () => self.reconnectNow(),
      awaitConnected: (timeoutMs) => self.awaitConnected(timeoutMs),
      setConsoleWatching: (on) => self.setConsoleWatching(on),
      setMetricsWatching: (on) => self.setMetricsWatching(on),
      ensurePhysicFolderPath: (folder) => self.ensurePhysicFolderPath(folder),
      physicFolderPath: (projectName) => self.physicFolderPath(projectName),
    };
  }

  /**
   * Detect the worker's tools and report the snapshot to the server (ADR-0254, `tools.report`) so the
   * DB-backed Tools panel + restore target stay current. One-way, best-effort — a detect/send failure
   * never disrupts the session. Called after each tool op (`op`), after the daily tick (`daily`), and
   * after a restore reconcile (`boot`/`manual`). `trigger` gates the server re-drive (ADR-0258: only
   * `daily` re-drives a still-failing restore); `restoreFailed` is passed only after a reconcile — a
   * plain `op`/`daily` report omits it so the server preserves the last known failed set.
   */
  private async reportWorkerTools(
    trigger: NonNullable<ToolsReportPayload["trigger"]> = "op",
    restoreFailed?: ToolRestoreFailureItem[],
  ): Promise<void> {
    try {
      const autoUpdate = readProfileConfig(this.context.profileDir).autoUpdateTools ?? [];
      const { catalog, extras } = await detectWorkerTools(autoUpdate);
      this.send(WsChannels.TOOLS_REPORT, {
        catalog,
        extras,
        trigger,
        ...(restoreFailed !== undefined ? { restoreFailed } : {}),
      } satisfies ToolsReportPayload);
    } catch (err) {
      logger.warn("tools.report.error", { error: String(err) });
    }
  }

  /**
   * Force an immediate reconnect: wake the backoff sleep if waiting, else drop the live
   * socket so the run() loop reconnects (the next backoff is skipped). No-op if stopped.
   */
  reconnectNow(): void {
    if (this.stopped) {
      this.bus.log(t("session.stoppedReconnect"), "warn");
      return;
    }
    this.bus.log(t("session.reconnectingNow"));
    this.forceReconnect = true;
    if (this.wakeReconnect) this.wakeReconnect();
    else this.socket?.close();
  }

  /**
   * Resolve `true` once the session becomes connected, or `false` after `timeoutMs`.
   * Used to gate a local prompt on a ready session (correct order — ADR-0064).
   */
  private awaitConnected(timeoutMs: number): Promise<boolean> {
    if (this.sessionKey && this.bus.status === "connected") return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const waiter = (): void => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.connectWaiters = this.connectWaiters.filter((w) => w !== waiter);
        resolve(false);
      }, timeoutMs);
      this.connectWaiters.push(waiter);
    });
  }

  /**
   * Resolve the reconnect-backoff cap (ms): the org value (from ws_token) over the
   * env override over the default. Each is already clamped to the 1-min ceiling.
   */
  private reconnectMaxMs(): number {
    const sec =
      this.orgReconnectMaxSec ?? this.envReconnectMaxSec ?? RECONNECT_MAX_BACKOFF_DEFAULT_SEC;
    return sec * 1000;
  }

  /** Mark a commandId as accepted for dedup, keeping the set bounded (drop the oldest). */
  private markCommandHandled(commandId: string): void {
    this.handledCommands.add(commandId);
    if (this.handledCommands.size > 1000) {
      const oldest = this.handledCommands.values().next().value;
      if (oldest !== undefined) this.handledCommands.delete(oldest);
    }
  }

  /** Backoff sleep that can be woken early by reconnectNow(). */
  private interruptibleSleep(ms: number): Promise<void> {
    if (this.forceReconnect) {
      this.forceReconnect = false;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.wakeReconnect = null;
        resolve();
      }, ms);
      // NOT unref'd: this backoff timer is what keeps the process alive while
      // disconnected. Un-refing it made the cli exit during the backoff when nothing
      // else held the event loop (e.g. headless / no Ink) instead of reconnecting.
      this.wakeReconnect = (): void => {
        clearTimeout(timer);
        this.wakeReconnect = null;
        this.forceReconnect = false;
        resolve();
      };
    });
  }

  /**
   * Main lifecycle: connect + reconnect backoff until revoked.
   */
  async run(): Promise<void> {
    // Consecutive HASHCODE_INVALID token rejections (reset on any successful session).
    let hashcodeInvalidStreak = 0;
    for (let attempt = 0; !this.stopped; attempt++) {
      // Why this outage is retrying — folded into the single reconnect status line below.
      let reconnectDetail = "Disconnected";
      try {
        await this.connectOnce();
        // Only a *real* session (hello_ack) resets the backoff. A socket that opened then
        // closed before the handshake must keep backing off, else it hot-loops at ~1s.
        if (this.sessionEstablished) {
          attempt = 0;
          hashcodeInvalidStreak = 0;
        }
      } catch (err) {
        if (err instanceof CliApiError) {
          // Definitive: the pairing is gone ⇒ logout (delete .cre).
          if (["HASHCODE_EXPIRED", "LINK_REVOKED"].includes(err.errorCode)) {
            this.logout(err.errorCode);
            return;
          }
          // Transient/unknown: retry with backoff; only give up after a streak so a
          // brief race (token re-issue vs reconnect) doesn't unpair the cli.
          if (err.errorCode === "HASHCODE_INVALID") {
            if (++hashcodeInvalidStreak > MAX_HASHCODE_INVALID_RETRIES) {
              this.logout(err.errorCode);
              return;
            }
            reconnectDetail = `Token rejected (HASHCODE_INVALID ${hashcodeInvalidStreak}/${MAX_HASHCODE_INVALID_RETRIES})`;
          } else if (err.errorCode === "USER_PAUSED") {
            // The account is paused (ADR-0093) — reversible. Keep `.cre` and back off
            // until an ADMIN/PM resumes it; never logout.
            reconnectDetail = "This account is paused — retrying until it is resumed";
          } else {
            reconnectDetail = `Connection error: ${err}`;
          }
        } else {
          reconnectDetail = `Connection error: ${err}`;
        }
      }
      if (this.stopped) return;
      const wait = backoffJitterMs(
        Math.min(attempt, RECONNECT_BACKOFF_MAX_ATTEMPT),
        RECONNECT_BACKOFF_BASE_MS,
        this.reconnectMaxMs(),
      );
      logger.info("ws.reconnect", { attempt, waitMs: wait });
      this.bus.setStatus("reconnecting");
      // One updating line per outage (approach B) — not an error + a wait line per attempt.
      this.showReconnectStatus(reconnectDetail, Math.round(wait / 1000), attempt + 1);
      await this.interruptibleSleep(wait);
    }
  }

  /**
   * One WS session: token → connect → handshake → handle messages until close.
   */
  private connectOnce(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      void (async () => {
        this.sessionEstablished = false;
        this.bus.setStatus("connecting");
        // 1. ws_token for the day (kept in memory — machine-0003)
        const token = await requestWsToken(this.credential.serverUrl, this.credential.hashcode3);
        this.wsToken = token.wsToken;
        // The org's reconnect cap (ADR-0056) overrides the local env for the next backoff.
        if (typeof token.reconnectMaxBackoffSec === "number") {
          this.orgReconnectMaxSec = token.reconnectMaxBackoffSec;
        }
        // Org timezone (ADR-0132) — rented workers carry the renter's; used for the AI-run start
        // stamp. Kept even if empty-guarded so a stale token never blanks it.
        if (typeof token.timezone === "string" && token.timezone) {
          this.orgTimezone = token.timezone;
        }
        // Refresh the org's daily auto-update policy (ADR-0074) — carried by each ws_token.
        if (typeof token.autoUpdateDaily === "boolean") {
          this.updateScheduler.configure({
            autoUpdateDaily: token.autoUpdateDaily,
            autoUpdateHour: token.autoUpdateHour,
            timezone: token.timezone,
          });
        }
        // Apply the machine user's cli data-retention window (ADR-0115): prune logs,
        // command-history and command-output older than N days. 0 ⇒ keep the cli defaults.
        if (typeof token.cliRetentionDays === "number" && token.cliRetentionDays > 0) {
          logger.setRetentionDays(token.cliRetentionDays);
          pruneCommandHistoryByAge(token.cliRetentionDays);
          pruneCommandOutputByAge(token.cliRetentionDays);
        }
        // Sweep stale Console image attachments (>24h) inside the served folder (ADR-0257).
        if (this.physicRoot) sweepOldAttachments(this.physicRoot);
        // Cache the serving project's runtime token knobs (ADR-0081) so the AI prompt path
        // can rotate profiles on session pressure + cap per-prompt tokens without a
        // round-trip. Server is the source of truth; null ⇒ knobs off (orchestrator/idle).
        writeProfileConfig(this.context.profileDir, {
          sessionSwitchPct: token.projectTokens?.sessionSwitchPct ?? 0,
          perPromptTokenLimit: token.projectTokens?.perPromptTokenLimit ?? 0,
          // Project AI-run timeout override (ADR-0243) — 0 ⇒ inherit the machine-user setting.
          projectAiRunTimeoutSec: token.projectTokens?.aiRunTimeoutSec ?? 0,
          // Project idle auto-clear override (ADR-0244) — 0 ⇒ inherit the machine-user setting.
          projectAutoClearIdleMinutes: token.projectTokens?.autoClearIdleMinutes ?? 0,
          // Project shared-AI-memory override mirrors (ADR-0245).
          projectAiMemoryMode: token.aiMemory?.mode ?? "inherit",
          projectAiMemoryBudgetChars: token.aiMemory?.budgetChars ?? 0,
          // Per-tool auto-update flags (ADR-0253) are now DB-owned (ADR-0254) — mirror the server's
          // list locally so the idle daily tick (UpdateScheduler) can read it without a round-trip.
          autoUpdateTools: token.toolRestore?.autoUpdate ?? [],
        });
        // Seed the shared-AI-memory cache (ADR-0245) from the server's stored copy — only when the
        // cli holds none yet (a fresh process / reconnect), so a periodic ws_token refresh never
        // clobbers a newer value this cli itself wrote (it is the sole writer for its link).
        if (token.aiMemory && !this.aiMemory) this.aiMemory = token.aiMemory.text;
        // Whether inputs must pass outbound review before spawning AI (ADR-0082) — the cli
        // asks the server (it picks the outbound reviewer) on each prompt when enabled.
        this.outboundReviewEnabled = token.outboundReview?.enabled === true;
        // Folder-scope hardening (project aiScope): when on, prepend a guard to every AI
        // prompt so the agent only uses content inside the served project folder.
        this.restrictToFolder = token.aiRestrictToFolder === true;
        // Git-auth method (ADR-0192 §4): for a token method + an injected `FOURPM_GIT_TOKEN`, write
        // the HTTPS git credential the store helper uses; `self`/`deploy-key` are a no-op.
        applyGitAuth(token.gitAuth ?? null);
        // The machine username is the git commit author for this project (ADR-0097); push
        // uses the account already logged in with gh/glab on the worker.
        this.machineUsername = token.machineUsername ?? "";

        // Heal the link scope from the server (older `.cre` stored "unknown" — ADR-0057):
        // persist it + update the header so orchestrator hides "serving", etc.
        if (token.scope && token.scope !== this.credential.scope) {
          this.credential.scope = token.scope;
          writeCredential(this.context.profileDir, this.credential);
          this.bus.setScope(token.scope);
        } else if (token.scope) {
          this.bus.setScope(token.scope);
        }

        // Heal the gateway WS URL from the server (ADR-0131 phase 3 cutover): once the server
        // hands a `wsUrl` (the cli-server), persist it so this + every reconnect use it. The
        // server omits it until the migration is switched on ⇒ the cli keeps the server gateway.
        if (token.wsUrl !== undefined && token.wsUrl !== this.credential.wsUrl) {
          this.credential.wsUrl = token.wsUrl || undefined;
          writeCredential(this.context.profileDir, this.credential);
        }

        // 2. Open WS — the healed cli-server URL when present, else derive from serverUrl.
        // `replace(/^http/,"ws")` maps http→ws / https→wss and is a no-op on a ws(s):// base.
        const wsBase = this.credential.wsUrl ?? this.credential.serverUrl;
        const wsUrl = wsBase.replace(/^http/, "ws") + "/ws";
        // Plaintext WS to a non-local host ⇒ the ws_token + session travel unauthenticated
        // (the ECDH handshake doesn't authenticate the server — ADR-0194 finding #1). Hard-block
        // and stop for good (no reconnect loop over an insecure link); opt out only on a trusted
        // private network via FOURPM_ALLOW_INSECURE_TRANSPORT=1.
        if (isInsecureRemoteUrl(wsUrl) && !insecureTransportAllowed()) {
          this.stopped = true;
          this.bus.log(INSECURE_URL_BLOCKED, "error");
          this.bus.setStatus("stopped");
          logger.error("ws.insecure-transport-blocked", { url: wsBase });
          throw new Error(INSECURE_URL_BLOCKED);
        }
        const socket = new WebSocket(wsUrl);
        this.socket = socket;

        socket.on("open", () => {
          // 3. Session-key handshake (ephemeral ECDH — a fresh key per session)
          //    with cliVersion (ADR-0015) + the worker fingerprint
          this.ecdh = createEcdhSession();
          socket.send(
            JSON.stringify({
              type: "hello",
              wsToken: this.wsToken,
              pubkey: this.ecdh.publicKeyBase64,
              cliVersion: CLI_VERSION,
              fingerprint: this.context.machine.fingerprint,
              hostname: this.context.machine.hostname,
            }),
          );
        });

        socket.on("message", (raw) => {
          try {
            this.handleMessage(JSON.parse(String(raw)));
          } catch (err) {
            this.bus.log(t("error.messageError", { error: String(err) }), "error");
          }
        });

        socket.on("close", (code) => {
          this.clearHeartbeat();
          this.sessionKey = null;
          setToolHealthSink(null); // stop tool-health reporting until the next session (ADR-0223)
          logger.debug("ws.close", { code });
          if (code === CLOSE_DRAINING) {
            // Server draining (rolling deploy) — reconnect to another instance
            this.bus.log(t("error.serverDraining"));
          }
          resolve(); // let the run() loop reconnect (redo the ECDH handshake)
        });
        socket.on("error", (err) => {
          this.clearHeartbeat();
          reject(err);
        });
      })().catch(reject);
    });
  }

  /**
   * Handle control messages (hello_ack/error) then route channel envelopes to the extracted
   * handlers (`./ws-client/*`). Each handler returns true when it owns the channel.
   */
  private handleMessage(message: WsControlMessage | WsEnvelope): void {
    if ("type" in message) {
      if (message.type === "hello_ack" && this.ecdh) {
        // Handshake done ⇒ Connected: derive key + status + heartbeat
        this.sessionKey = deriveSessionKey(this.ecdh, message.pubkey);
        this.sessionEstablished = true; // a real session ⇒ safe to reset the backoff
        // Worker + logical project names from the server — heal the TUI header.
        if (message.workerName) this.bus.setWorker(message.workerName);
        if (message.projectName) {
          this.bus.setProject(message.projectName);
          // Ensure the physic project folder exists (folder = project name — ADR-0064),
          // covering attach-after-pair where `4pm link` never created it, and remember it
          // as the fs.list browse root.
          this.ensurePhysicFolder(message.projectName);
          this.physicRoot = this.physicFolderPath(message.projectName);
        } else {
          // No project ⇒ idle cli. Clear the header too, else a cli that reconnects
          // after its project was deleted keeps showing "serving <project>" (ADR-0068).
          this.bus.setProject(null);
          this.physicRoot = null; // idle cli ⇒ nothing to browse
        }
        logger.info("ws.connected", { version: CLI_VERSION });
        // A fresh session ⇒ drop any prior console-watch state; the server re-asserts
        // console.watch while a viewer is attached, which re-snapshots (ADR-0150).
        this.stopConsoleSync();
        // Same for the metrics lease (ADR-0214) — re-armed by the next `metrics.watch`.
        this.stopMetricsSync();
        this.bus.setStatus("connected");
        this.finishReconnect();
        this.sendMachineStatus();
        this.flushOfflineBuffer();
        this.startHeartbeat();
        this.startUsagePolling();
        this.startLogUpload();
        this.startKbRefresh();
        // Route per-tool health reports to the server over the live session (ADR-0223); `send`
        // is a no-op until the session key is set, so this is safe to (re)wire here each connect.
        setToolHealthSink((report) => this.send(WsChannels.TOOL_HEALTH, report));
        // Wake anything awaiting readiness (a prompt queued during reconnect).
        this.connectWaiters.splice(0).forEach((fn) => fn());
        return;
      }
      if (message.type === "error") {
        logger.warn("ws.error", { errorCode: message.errorCode });
        if (["LINK_REVOKED", "HASHCODE_EXPIRED"].includes(message.errorCode)) {
          this.logout(message.errorCode);
          return;
        }
        if (message.errorCode === "CLI_VERSION_UNSUPPORTED") {
          // Server rejected the version — stop entirely; the user updates then reruns
          this.stopped = true;
          this.updateScheduler.stop();
          this.bus.setStatus("stopped");
          this.bus.log(t("error.versionRejected", { version: message.message ?? "" }), "error");
          this.socket?.close();
          return;
        }
        if (message.errorCode === "SESSION_REPLACED") {
          // A newer session for this profile took over (ADR-0047). Stop — reconnecting
          // would evict that session and thrash. Keep `.cre` (the link is still valid).
          this.stopped = true;
          this.updateScheduler.stop();
          this.bus.setStatus("stopped");
          this.bus.log(t("error.sessionReplaced"), "error");
          this.socket?.close();
          return;
        }
        if (message.errorCode === "USER_PAUSED") {
          // Paused account (ADR-0093) — reversible; keep `.cre`, reconnect with backoff.
          this.bus.log(t("error.accountPaused"), "warn");
          this.socket?.close();
          return;
        }
        // WS_TOKEN_INVALID ⇒ close; the run() loop requests a new token then reconnects
        this.bus.log(t("error.serverError", { code: message.errorCode }), "warn");
        this.socket?.close();
        return;
      }
      return;
    }

    // Channel envelope (server → cli)
    if (!this.sessionKey) return;
    const payload = decryptPayload<Record<string, unknown>>(
      this.sessionKey,
      message.payload,
      message.nonce,
    );
    // Reply for a pending cli → server request (quota.check…)
    if (message.replyTo) {
      const waiting = this.pending.get(message.replyTo);
      if (waiting) {
        clearTimeout(waiting.timer);
        this.pending.delete(message.replyTo);
        waiting.resolve(payload);
        return;
      }
    }
    // Route to the topic handler that owns this channel (each returns true when handled).
    if (handleProjectChannels(this.hctx, message, payload)) return;
    if (handleCommandChannels(this.hctx, message, payload)) return;
    if (handleFsChannels(this.hctx, message, payload)) return;
    if (handleWorkerChannels(this.hctx, message, payload)) return;
    if (handleToolsChannels(this.hctx, message, payload)) return;
    if (handleGitChannels(this.hctx, message, payload)) return;
    if (handleSupportChannels(this.hctx, message, payload)) return;
    if (handleMiscChannels(this.hctx, message, payload)) return;
    this.bus.log(t("error.unsupportedChannel", { channel: message.channel }), "warn");
  }

  /**
   * Send one envelope (encrypted payload + per-message wsToken — arch 0004).
   * When disconnected: the running command's output is held in a buffer (512KB cap,
   * dropping the oldest) then flushed on reconnect.
   */
  private send(channel: WsChannelName, data: unknown, replyTo: string | null = null): void {
    if (!this.socket || !this.sessionKey) {
      if (channel === WsChannels.COMMAND_OUTPUT) this.bufferOffline(channel, data);
      return;
    }
    const { payload, nonce } = encryptPayload(this.sessionKey, data);
    const envelope: WsEnvelope = {
      id: randomUUID(),
      replyTo,
      channel,
      wsToken: this.wsToken,
      payload,
      nonce,
    };
    this.socket.send(JSON.stringify(envelope));
  }

  /**
   * Send a cli → server request and await the reply by envelope id (15s timeout).
   * Used for quota.check before spawning an AI cli (ADR-0020).
   */
  request<T>(channel: WsChannelName, data: unknown): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this.socket || !this.sessionKey) {
        reject(new Error("Not connected to the server."));
        return;
      }
      const { payload, nonce } = encryptPayload(this.sessionKey, data);
      const envelope: WsEnvelope = {
        id: randomUUID(),
        replyTo: null,
        channel,
        wsToken: this.wsToken,
        payload,
        nonce,
      };
      const timer = setTimeout(() => {
        this.pending.delete(envelope.id);
        reject(new Error("Server did not respond (timeout)."));
      }, 15_000);
      timer.unref?.();
      this.pending.set(envelope.id, {
        resolve: (value) => resolve(value as T),
        timer,
      });
      this.socket.send(JSON.stringify(envelope));
    });
  }

  /** quota.check before spawning an AI cli (ADR-0020). */
  checkQuota(metric: string, amount = 1): Promise<QuotaCheckReply> {
    return this.request<QuotaCheckReply>(WsChannels.QUOTA_CHECK, { metric, amount });
  }

  /** Fetch a Console prompt image blob from the server to materialize on the worker (ADR-0257). */
  imageFetch(commandId: string, imageId: string): Promise<ImageFetchReply> {
    return this.request<ImageFetchReply>(WsChannels.IMAGE_FETCH, {
      commandId,
      imageId,
    } satisfies ImageFetchRequest);
  }

  /** usage.report batched to the server (ADR-0020); tags each event with the AI profile. */
  reportUsage(events: UsageReportPayload["events"], profile?: string | null): void {
    const tagged = profile ? events.map((e) => ({ ...e, profile })) : events;
    this.send(WsChannels.USAGE_REPORT, { events: tagged } satisfies UsageReportPayload);
  }

  /**
   * Buffer output while offline (byte cap — drop the oldest message when exceeded).
   */
  private bufferOffline(channel: WsChannelName, data: unknown): void {
    const bytes = JSON.stringify(data).length;
    this.offlineBuffer.push({ channel, data });
    this.offlineBufferBytes += bytes;
    while (this.offlineBufferBytes > OFFLINE_BUFFER_MAX_BYTES && this.offlineBuffer.length > 1) {
      const dropped = this.offlineBuffer.shift();
      this.offlineBufferBytes -= JSON.stringify(dropped?.data ?? "").length;
    }
  }

  /**
   * Flush the output buffer after a successful re-handshake.
   */
  private flushOfflineBuffer(): void {
    const queued = this.offlineBuffer.splice(0);
    this.offlineBufferBytes = 0;
    for (const item of queued) this.send(item.channel, item.data);
  }

  /**
   * Ensure the physic project folder exists inside the profile dir (folder = project
   * name — ADR-0064), covering attach-after-pair where `4pm link` never created it.
   * Just the folder — no config change. Best-effort.
   */
  private ensurePhysicFolder(projectName: string): void {
    const folder = this.physicFolderPath(projectName);
    if (folder) this.ensurePhysicFolderPath(folder);
  }

  /** Create the physic folder at an absolute path if missing (best-effort). */
  private ensurePhysicFolderPath(folder: string): void {
    try {
      if (!existsSync(folder)) {
        mkdirSync(folder, { recursive: true });
        this.bus.log(t("project.createdFolder", { folder }));
      }
    } catch (err) {
      this.bus.log(t("error.folderCreateFailed", { error: String(err) }), "warn");
    }
  }

  /**
   * Absolute path of the physic project folder (`<profile>/<name>`, folder = project
   * name — ADR-0064). Sanitises the name to a single segment (no traversal); returns
   * null for an empty name.
   */
  private physicFolderPath(projectName: string): string | null {
    const safe = projectName.replace(/[/\\]/g, "_").replace(/\.\./g, "_").trim();
    return safe ? join(this.context.profileDir, safe) : null;
  }

  /**
   * Report machine.status: version + the state of the physic project being served
   * (path, does the folder exist?, autonomous).
   */
  private sendMachineStatus(): void {
    const config = readProfileConfig(this.context.profileDir);
    const physicPath = config.physicPath ?? null;
    // Configured AI-credential count (ADR-0256): the unified list (ADR-0182) when present, else the
    // legacy per-provider lists — the failover profile count the server uses as the derived
    // re-attach-cap floor factor (`effective × profileCount × 1.2`).
    const aiProfileCount = Array.isArray(config.aiProfiles)
      ? config.aiProfiles.length
      : (config.claudeHome?.length ?? 0) +
        (config.codexHome?.length ?? 0) +
        (config.antigravityHome?.length ?? 0);
    this.send(WsChannels.MACHINE_STATUS, {
      status: "online",
      projects: [],
      version: CLI_VERSION,
      physicPath,
      physicPathExists: physicPath ? existsSync(physicPath) : undefined,
      // Real coarse state (ADR-0152): !paused and a recent tick (was hard-coded false).
      autonomousRunning: physicPath ? isAutonomousRunning(physicPath) : false,
      // The machine-user AI-run limit (0 = unlimited) + profile count so a dispatch can resolve the
      // effective timeout and derive the SSE reply windows server-side (ADR-0256).
      aiRunTimeoutSec: config.aiRunTimeoutSec ?? 0,
      aiProfileCount,
    });
  }

  /** Heartbeat every 30s: ping + periodically re-report machine.status. */
  private startHeartbeat(): void {
    this.clearHeartbeat();
    this.heartbeat = setInterval(() => {
      this.socket?.ping();
      this.sendMachineStatus();
    }, HEARTBEAT_MS);
    this.heartbeat.unref?.();
  }

  private clearHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    if (this.usageTimer) clearInterval(this.usageTimer);
    this.usageTimer = null;
    if (this.logUploadTimer) clearInterval(this.logUploadTimer);
    this.logUploadTimer = null;
    if (this.kbRefreshTimer) clearInterval(this.kbRefreshTimer);
    this.kbRefreshTimer = null;
    this.stopMetricsSync();
  }

  /**
   * Poll the Claude subscription usage API and push a `machine.usage` snapshot (ADR-0072).
   * Fail-safe: the checker returns null when creds/API are unavailable ⇒ we just skip.
   * Only utilization %/reset/plan is sent — the OAuth token never leaves the machine.
   */
  private async pollUsage(): Promise<void> {
    if (!this.sessionKey) return;
    try {
      const config = readProfileConfig(this.context.profileDir);
      // Usage is a Claude-subscription metric; a blank/mixed aiCli (ADR-0182) reads Claude.
      const aiCli = config.aiCli || "claude";
      const working = getWorkingProfile(this.context.profileDir, aiCli);
      // Check the profile actually in use first (its creds + `/usage`), then the rest.
      const configured = claudeHomeDirs(config);
      const dirs = working ? [working, ...configured.filter((d) => d !== working)] : configured;
      const profile = working ? basename(working) : dirs[0] ? basename(dirs[0]) : "default";
      // Real windows from the API / `/usage` text; else a placeholder so the active
      // profile/plan still surface (ADR-0072). Never send the token.
      const api = await checkClaudeUsage(dirs, aiCli);
      const snapshot: MachineUsagePayload = api ?? {
        plan: "?",
        session: { utilizationPct: 0, resetsAt: null },
        weekly: { utilizationPct: 0, resetsAt: null },
        checkedAt: new Date().toISOString(),
      };
      snapshot.aiCli = aiCli;
      snapshot.profile = profile;
      // Worker network probe (ADR-0221): detect outbound reachability + inbound exposure +
      // containerized-ness so the web can warn when the worker's network isn't sandboxed.
      // Observe-only, never blocks.
      snapshot.network = await probeNetwork();
      this.usageSnapshot = snapshot; // for the TUI header
      this.bus.setUsage?.(snapshot);
      this.send(WsChannels.MACHINE_USAGE, snapshot);
    } catch {
      // best-effort — never let a usage check disrupt the session
    }
  }

  /** Start the periodic usage poll (alongside the heartbeat). */
  private startUsagePolling(): void {
    if (this.usageTimer) clearInterval(this.usageTimer);
    this.usageTimer = setInterval(() => void this.pollUsage(), USAGE_POLL_MS);
    this.usageTimer.unref?.();
    void this.pollUsage(); // one immediate check on (re)connect
  }

  /** Start the periodic upload of the cli's own JSONL log to the server (ADR-0122). */
  private startLogUpload(): void {
    if (this.logUploadTimer) clearInterval(this.logUploadTimer);
    this.logUploadTimer = setInterval(() => this.uploadLog(), LOG_UPLOAD_MS);
    this.logUploadTimer.unref?.();
    this.uploadLog(); // one immediate upload on (re)connect
  }

  /**
   * Start the daily FAQ/KB refresh for a support agent (ADR-0170): pull each KB clone already
   * present in this profile so answers stay current without fetching on each dispatch. A no-op
   * for a normal project cli (no `support-kb` dir), so it is safe to start on every session.
   */
  private startKbRefresh(): void {
    if (this.kbRefreshTimer) clearInterval(this.kbRefreshTimer);
    this.kbRefreshTimer = setInterval(
      () => void refreshSupportKb(this.context.profileDir),
      KB_REFRESH_MS,
    );
    this.kbRefreshTimer.unref?.();
    void refreshSupportKb(this.context.profileDir); // one immediate refresh on (re)connect
  }

  /**
   * Upload the newest cli log file + the total log footprint to the server (ADR-0122), so it is
   * stored + retained server-side and counted in the machine user's storage. Skips when nothing
   * changed since the last upload. Best-effort — never disrupts the session.
   */
  private uploadLog(): void {
    try {
      const upload = readLogUpload(join(this.context.profileDir, "logs"));
      if (!upload) return;
      const sig = `${upload.fileName}:${upload.totalBytes}`;
      if (sig === this.lastLogSig) return; // unchanged since last upload
      this.lastLogSig = sig;
      this.send(WsChannels.MACHINE_LOG, upload satisfies MachineLogPayload);
    } catch {
      // best-effort — logging must never break the session
    }
  }

  /**
   * Console sync (ADR-0150): emit one incremental `console.sync` event (add/update/clear) — only
   * while a web Console viewer is attached (`consoleWatching`); each carries the next `rev` so the
   * web detects a gap. Dropped when disconnected — the next snapshot on (re)attach re-syncs.
   */
  private emitConsole(
    ev:
      | { kind: "add"; entry: DtoTranscriptEntry }
      | { kind: "update"; entry: DtoTranscriptEntry }
      | { kind: "clear" },
  ): void {
    if (!this.consoleWatching) return;
    this.send(WsChannels.CONSOLE_SYNC, { ...ev, rev: ++this.consoleRev } as ConsoleSyncEvent);
  }

  /**
   * A `/clear` (or idle auto-clear) wiped the transcript (ADR-0150). Emit it as an absolute empty
   * **snapshot** rather than an incremental `clear` event: a snapshot is applied unconditionally on
   * the web (no `rev`-gap check), so the clear can't be silently dropped when the web's revision
   * drifted during a reconnect flap. No-op while unwatched — the next `console.watch` re-arm
   * snapshots the (now empty) buffer anyway. The history is already emptied before this fires, so
   * the snapshot carries no entries.
   */
  private emitConsoleClear(): void {
    if (!this.consoleWatching) return;
    this.sendConsoleSnapshot();
  }

  /**
   * Show the reconnect-backoff status as a SINGLE transcript line for the current outage
   * (approach B): create it on the first failed attempt, then update it in place on every retry —
   * so an outage adds one line instead of an error + a "reconnecting in Ns" line per attempt
   * (which flooded the TUI and, on the next snapshot, the web Console).
   */
  private showReconnectStatus(detail: string, waitSec: number, attempt: number): void {
    const text = `⟳ ${detail} — reconnecting in ${waitSec}s (attempt ${attempt}, /reconnect to retry now)`;
    if (this.reconnectEntryId) {
      this.bus.updateEntry(this.reconnectEntryId, text, "warn");
    } else {
      this.reconnectEntryId = this.bus.push({ source: "system", kind: "log", text, level: "warn" });
    }
  }

  /**
   * A session became ready (hello_ack): finalize any in-flight reconnect line in place to the
   * "connected" line (so the outage's single line resolves cleanly), or — on a first connect with
   * no prior outage — push a fresh connected line.
   */
  private finishReconnect(): void {
    const msg = "✔ Connected to the server (session encryption ready).";
    if (this.reconnectEntryId) {
      this.bus.updateEntry(this.reconnectEntryId, msg, "info");
      this.reconnectEntryId = null;
    } else {
      this.bus.log(msg);
    }
  }

  /** Send a full transcript snapshot (on attach + the periodic self-heal — ADR-0150). */
  private sendConsoleSnapshot(): void {
    const entries = this.bus.snapshot().map(toDtoEntry);
    this.send(WsChannels.CONSOLE_SYNC, {
      kind: "snapshot",
      rev: ++this.consoleRev,
      entries,
    } satisfies ConsoleSyncEvent);
  }

  /**
   * Handle `console.watch` (ADR-0150) — a renewable lease. `on` renews it: start mirroring on the
   * first assertion (fresh snapshot + arm the periodic snapshot); later renewals just extend the
   * lease (no re-snapshot). No renewal within `CONSOLE_WATCH_LEASE_MS` ⇒ the lease expires and
   * syncing stops. An explicit `on:false` stops immediately.
   */
  private setConsoleWatching(on: boolean): void {
    if (!on) {
      this.stopConsoleSync();
      return;
    }
    // (Re)arm the lease expiry on every renewal.
    if (this.consoleWatchExpiry) clearTimeout(this.consoleWatchExpiry);
    this.consoleWatchExpiry = setTimeout(() => this.stopConsoleSync(), CONSOLE_WATCH_LEASE_MS);
    this.consoleWatchExpiry.unref?.();
    if (this.consoleWatching) return; // already syncing — this was a renewal
    this.consoleWatching = true;
    this.sendConsoleSnapshot();
    this.consoleSnapshotTimer = setInterval(
      () => this.sendConsoleSnapshot(),
      CONSOLE_SNAPSHOT_INTERVAL_MS,
    );
    this.consoleSnapshotTimer.unref?.();
  }

  /** Stop mirroring the transcript (lease expired / viewer left / reconnect) — clears both timers. */
  private stopConsoleSync(): void {
    this.consoleWatching = false;
    if (this.consoleSnapshotTimer) {
      clearInterval(this.consoleSnapshotTimer);
      this.consoleSnapshotTimer = null;
    }
    if (this.consoleWatchExpiry) {
      clearTimeout(this.consoleWatchExpiry);
      this.consoleWatchExpiry = null;
    }
  }

  /**
   * Handle `metrics.watch` (ADR-0214) — a renewable lease mirroring `console.watch`. `on` renews it:
   * on the first assertion the cli samples immediately + starts the ~5s sampler; later renewals just
   * extend the lease. No renewal within `METRICS_WATCH_LEASE_MS` (or an explicit `on:false`) ⇒ stop.
   */
  private setMetricsWatching(on: boolean): void {
    if (!on) {
      this.stopMetricsSync();
      return;
    }
    if (this.metricsWatchExpiry) clearTimeout(this.metricsWatchExpiry);
    this.metricsWatchExpiry = setTimeout(() => this.stopMetricsSync(), METRICS_WATCH_LEASE_MS);
    this.metricsWatchExpiry.unref?.();
    if (this.metricsWatching) return; // already sampling — this was a renewal
    this.metricsWatching = true;
    void this.sendMachineMetrics();
    this.metricsTimer = setInterval(() => void this.sendMachineMetrics(), METRICS_SAMPLE_INTERVAL_MS);
    this.metricsTimer.unref?.();
  }

  /** Stop sampling worker resources (lease expired / viewer left / reconnect) — clears both timers. */
  private stopMetricsSync(): void {
    this.metricsWatching = false;
    if (this.metricsTimer) {
      clearInterval(this.metricsTimer);
      this.metricsTimer = null;
    }
    if (this.metricsWatchExpiry) {
      clearTimeout(this.metricsWatchExpiry);
      this.metricsWatchExpiry = null;
    }
  }

  /** Sample the worker's live CPU/RAM/disk and push a `machine.metrics` frame (ADR-0214). */
  private async sendMachineMetrics(): Promise<void> {
    if (!this.sessionKey) return;
    try {
      if (!this.metricsSampler) this.metricsSampler = createWorkerMetricsSampler(this.context.profileDir);
      const resources = await this.metricsSampler.sample();
      this.send(WsChannels.MACHINE_METRICS, {
        fingerprint: this.context.machine.fingerprint,
        resources,
      } satisfies MachineMetricsPayload);
    } catch {
      // best-effort — a sampling error must never disrupt the session
    }
  }

  /**
   * Logout: close WS, delete `.cre`, and prompt to pair again (Unlinked state).
   */
  private logout(reason: string): void {
    this.stopped = true;
    this.updateScheduler.stop();
    this.clearHeartbeat();
    this.socket?.close();
    this.bus.setStatus("stopped");
    logger.warn("ws.logout", { reason });
    deleteCredential(this.context.profileDir);
    this.bus.log(t("error.linkInvalid", { reason }), "error");
  }
}
