/**
 * The cli's WS client (arch 0011): request ws_token → open WS → ECDH handshake →
 * send machine.status; heartbeat ping every 30s; reconnect with backoff + jitter;
 * LINK_REVOKED/HASHCODE_EXPIRED ⇒ logout (delete .cre). HASHCODE_INVALID is treated
 * as transient (a token re-issue racing a reconnect) and retried (bounded) before
 * giving up — cli-ws 0001.
 */
import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import WebSocket from "ws";
import { backoffJitterMs, looksLikeJsonOrCode } from "@4pm/utils";
import { UsageMetric } from "@4pm/constants";
import {
  CLI_SETTINGS_BOUNDS,
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
  type CommandAnnouncePayload,
  type CommandDispatchPayload,
  type CommandHistoryPayload,
  type CommandOrigin,
  type EcdhSession,
  type FsListRequest,
  type FsReadRequest,
  type FsWriteRequest,
  type AutonomousLogsRequest,
  type AutonomousWriteRequest,
  type AgentReadRequest,
  type AgentWriteRequest,
  type PackagesInstallRequest,
  type PackagesPackRequest,
  type PackagesRemoveRequest,
  type SecretsWriteRequest,
  type AgentToolsReadRequest,
  type AgentToolsWriteRequest,
  type GraphBuildRequest,
  type RagInstallRequest,
  type RagQueryRequest,
  type ConfigReadReply,
  type ConfigWriteRequest,
  type ConfigWriteReply,
  type ToolsListReply,
  type ToolsMutateRequest,
  type ToolsMutateReply,
  type ToolsProgressPayload,
  type ToolsDonePayload,
  type GitDiffRequest,
  type GitEnvRequest,
  type GitSshKeyRequest,
  type GitLogRequest,
  type GitCommitRequest,
  type GitCommitDiffRequest,
  type LogReadReply,
  type LogReadRequest,
  type CommandOutputRequest,
  type CommandOutputReply,
  type RentalFlushReply,
  type ConsoleWatchPayload,
  type MetricsWatchPayload,
  type MachineUsagePayload,
  type MachineLogPayload,
  type PhysicDeletePayload,
  type PhysicSyncPayload,
  type ProjectAddPayload,
  type ProjectCreatePayload,
  type QuotaCheckReply,
  type ReviewEvaluatePayload,
  type ReviewResultPayload,
  type SupportAnswerRequest,
  type KnowledgeComposeRequest,
  type UsageReportPayload,
  type WsChannelName,
  type WsControlMessage,
  type WsEnvelope,
} from "@4pm/ws";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { randomUUID as randomCommandId } from "node:crypto";
import { deleteCredential, writeCredential, type Credential } from "./credential";
import type { MachineFingerprint } from "./fingerprint";
import type { SessionBus, TranscriptEntry as BusTranscriptEntry } from "./session-bus";
import { UpdateScheduler } from "./update-scheduler";
import { CliApiError, requestWsToken } from "../services/api";
import { runCommand } from "./executor";
import { runAiFailover } from "./ai-runner";
import { estimateTokens } from "./ai-stream";
import {
  getWorkingCredential,
  getWorkingProfile,
  setWorkingCredential,
  setWorkingProfile,
} from "./ai-profile-state";
import { INSECURE_URL_BLOCKED, insecureTransportAllowed, isInsecureRemoteUrl } from "../utils/secure-url";
import {
  claudeCredentialKeys,
  claudeHomeDirs,
  folderScopeGuard,
  isUnifiedConfig,
  labelFromCredentialKey,
  planAiRun,
  profileDisplayLabel,
  resolveClaudeAuthMode,
  resolveClaudeProfiles,
} from "../utils/ai-cli";
import { checkClaudeUsage } from "./claude-usage";
import { evaluateReview } from "./outbound-review";
import { finishCommand, recordCommand, pruneCommandHistoryByAge } from "./command-history";
import { appendCommandOutput, readCommandOutput, pruneCommandOutputByAge } from "./command-output-store";
import { listDir } from "./fs-browse";
import { readWorkerFile } from "./fs-read";
import { writeWorkerFile } from "./fs-write";
import { runSupportAnswer, refreshSupportKb } from "./support-answer";
import { runKnowledgeCompose } from "./knowledge-compose";
import { setToolHealthSink, reportToolResult } from "./tool-health";
import {
  isAutonomousRunning,
  readAutonomous,
  readAutonomousLogs,
  uninstallCron,
  writeAutonomous,
} from "./autonomous";
import { listAgents, readAgent, writeAgent } from "./agents";
import { installPackage, listPackages, packPackage, removePackage } from "./packages";
import { probeNetwork } from "./network-probe";
import { applyGitAuth } from "./git-auth";
import { readSecrets, writeSecrets } from "./secrets";
import { readAgentTools, writeAgentTools } from "./agent-tools";
import { buildGraph } from "./graph";
import { ragInstall, ragQuery, ragReindex, ragStatus } from "./rag";
import { gitDiff } from "./git-diff";
import { checkGitEnv } from "./git-env";
import { manageSshKey } from "./git-ssh-key";
import { gitCommit, gitCommitDiff, gitLog, gitRepos } from "./git-history";
import { setCommitAuthor } from "./git-commit-identity";
import { addProject, scaffoldProject } from "./scaffold";
import { readProfileConfig, writeProfileConfig } from "../config/profile";
import { applyConfigText, readConfigText } from "./config-sync";
import { detectWorkerTools, runWorkerToolOp } from "./worker-tools";
import { logger, readRecentLogLines, readLogUpload } from "../common/logger/logger";
import { CLI_VERSION } from "../version";

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
 * Read the env override for the reconnect cap (`FOURPM_RECONNECT_MAX_BACKOFF_SEC`),
 * clamped to the 1-min ceiling; null when unset/invalid. The org value (delivered via
 * the ws_token) takes precedence over this — env only applies before the first connect.
 */
function envReconnectMaxSec(): number | null {
  const raw = Number(process.env.FOURPM_RECONNECT_MAX_BACKOFF_SEC);
  if (!Number.isFinite(raw)) return null;
  const { min, max } = CLI_SETTINGS_BOUNDS.reconnectMaxBackoffSec;
  return Math.min(Math.max(Math.floor(raw), min), max);
}

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

/** Map a SessionBus transcript entry to the console-sync wire shape (drops the cli-only `ts`). */
function toDtoEntry(e: BusTranscriptEntry): DtoTranscriptEntry {
  return { id: e.id, source: e.source, kind: e.kind, text: e.text, level: e.level, resultKind: e.resultKind };
}

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
  /** Env override for the reconnect cap (seconds); resolved once at construction. */
  private readonly envReconnectMaxSec = envReconnectMaxSec();
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
    );
    // The operator's local commands (TUI input box) run through the same executor.
    context.bus.onLocalSubmit((input) => void this.runLocalCommand(input));
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
  }

  /**
   * Force an immediate reconnect: wake the backoff sleep if waiting, else drop the live
   * socket so the run() loop reconnects (the next backoff is skipped). No-op if stopped.
   */
  reconnectNow(): void {
    if (this.stopped) {
      this.bus.log("Session stopped — restart 4pm to reconnect.", "warn");
      return;
    }
    this.bus.log("Reconnecting now…");
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
        // Cache the serving project's runtime token knobs (ADR-0081) so the AI prompt path
        // can rotate profiles on session pressure + cap per-prompt tokens without a
        // round-trip. Server is the source of truth; null ⇒ knobs off (orchestrator/idle).
        writeProfileConfig(this.context.profileDir, {
          sessionSwitchPct: token.projectTokens?.sessionSwitchPct ?? 0,
          perPromptTokenLimit: token.projectTokens?.perPromptTokenLimit ?? 0,
        });
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
            this.bus.log(`Message error: ${err}`, "error");
          }
        });

        socket.on("close", (code) => {
          this.clearHeartbeat();
          this.sessionKey = null;
          setToolHealthSink(null); // stop tool-health reporting until the next session (ADR-0223)
          logger.debug("ws.close", { code });
          if (code === CLOSE_DRAINING) {
            // Server draining (rolling deploy) — reconnect to another instance
            this.bus.log("Server draining — will reconnect (backoff + jitter).");
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
   * Handle control messages (hello_ack/error) and channel envelopes.
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
          this.bus.log(`Server rejected the cli version (${message.message}) — please update.`, "error");
          this.socket?.close();
          return;
        }
        if (message.errorCode === "SESSION_REPLACED") {
          // A newer session for this profile took over (ADR-0047). Stop — reconnecting
          // would evict that session and thrash. Keep `.cre` (the link is still valid).
          this.stopped = true;
          this.updateScheduler.stop();
          this.bus.setStatus("stopped");
          this.bus.log(
            "Another session for this profile took over — this instance is stopping. " +
              "(Are you running `4pm start` twice for the same profile?)",
            "error",
          );
          this.socket?.close();
          return;
        }
        if (message.errorCode === "USER_PAUSED") {
          // Paused account (ADR-0093) — reversible; keep `.cre`, reconnect with backoff.
          this.bus.log("This account is paused — retrying until it is resumed.", "warn");
          this.socket?.close();
          return;
        }
        // WS_TOKEN_INVALID ⇒ close; the run() loop requests a new token then reconnects
        this.bus.log(`Server reported an error: ${message.errorCode}`, "warn");
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
    switch (message.channel) {
      case WsChannels.PHYSIC_SYNC: {
        // Project renamed ⇒ delete the old physic folder + (re)create the new one
        // inside the profile (folder = project name — ADR-0064).
        const sync = payload as unknown as PhysicSyncPayload;
        // Clean up the old physic project's cron before dropping its folder (ADR-0152) — a
        // renamed/rebound project must not leave an orphan tick firing at the old path.
        if (sync.oldName) {
          const oldRoot = this.physicFolderPath(sync.oldName);
          if (oldRoot) void uninstallCron(oldRoot).catch(() => undefined);
        }
        if (sync.oldName) rmSync(join(this.context.profileDir, sync.oldName), { recursive: true, force: true });
        mkdirSync(join(this.context.profileDir, sync.newName), { recursive: true });
        this.physicRoot = this.physicFolderPath(sync.newName); // browse root follows the rename
        this.bus.setProject(sync.newName); // header updates live — now serving this project
        this.bus.log(`Physic project folder synced → ${sync.newName}`);
        break;
      }
      case WsChannels.PHYSIC_DELETE: {
        // Project deleted ⇒ delete the physic folder inside the profile. The cli keeps
        // its pairing and goes idle (ADR-0068).
        const del = payload as unknown as PhysicDeletePayload;
        // Guard: an empty name would resolve to the profile dir itself — never delete that.
        if (del.name) {
          const delRoot = this.physicFolderPath(del.name);
          // Uninstall the physic project's cron first (ADR-0152) — no orphan tick after delete.
          if (delRoot) void uninstallCron(delRoot).catch(() => undefined);
          rmSync(join(this.context.profileDir, del.name), { recursive: true, force: true });
          this.bus.log(`Physic project folder deleted (project removed) → ${del.name}`);
        }
        // Scrub the ssh deploy key whenever the worker leaves a project — the key granted
        // access to the OLD project's repos, so a rented worker switching projects (or going
        // idle) must not keep it (ADR-0173 §5). No-op for an org's own worker (no `id_4pm`).
        void manageSshKey("delete", this.context.profileDir).catch(() => undefined);
        this.bus.setProject(null); // header goes idle — no longer serving a project
        this.physicRoot = null; // idle now ⇒ nothing to browse
        break;
      }
      case WsChannels.COMMAND_DISPATCH: {
        // Record in the local history (per cli), stream output, mark finished.
        const dispatch = payload as unknown as CommandDispatchPayload;
        // Idempotency: WS delivery is at-least-once, so ignore a duplicate dispatch of a
        // commandId we already accepted (a redelivery must not re-run the command — #3).
        if (this.handledCommands.has(dispatch.commandId)) {
          logger.info("command.dispatch.duplicate", { commandId: dispatch.commandId });
          break;
        }
        this.markCommandHandled(dispatch.commandId);
        logger.info("command.dispatch", {
          commandId: dispatch.commandId,
          cmd: dispatch.cmd,
          ai: dispatch.ai ?? false,
        });
        // AI-prompt dispatch (web AI mode): `cmd` is the raw prompt — run it through the
        // same profile-failover path as a locally-typed prompt (not a raw spawn).
        if (dispatch.ai) {
          void this.runAiPrompt(dispatch.cmd, dispatch.commandId, "server");
          break;
        }
        recordCommand({
          commandId: dispatch.commandId,
          projectId: dispatch.projectId,
          cmd: dispatch.cmd,
          args: dispatch.args,
        });
        this.bus.push({
          source: "server",
          kind: "cmd",
          text: `$ ${dispatch.cmd} ${dispatch.args.join(" ")}`.trimEnd(),
        });
        this.bus.startBusy(dispatch.cmd);
        void runCommand(dispatch, (out) => {
          if (out.chunk) {
            this.bus.push({ source: "server", kind: "out", text: out.chunk });
            appendCommandOutput(out.commandId, out.chunk);
          }
          this.send(WsChannels.COMMAND_OUTPUT, out);
          if (out.done) {
            this.bus.endBusy(dispatch.cmd);
            const code = out.exitCode ?? -1;
            finishCommand(out.commandId, code);
            this.bus.push({
              source: "server",
              kind: "exit",
              text: code === 0 ? "✓ done" : `✗ failed (exit ${code})`,
              level: code === 0 ? "info" : "error",
            });
          }
        });
        break;
      }
      case WsChannels.FS_LIST:
        // Request/reply (machine-0007): reply on the same channel via replyTo. Scoped to
        // the physic project root — the browser can only go inward, never out.
        void listDir((payload as unknown as FsListRequest).path, this.physicRoot).then((reply) =>
          this.send(WsChannels.FS_LIST, reply, message.id),
        );
        break;
      case WsChannels.FS_READ:
        // Request/reply — read a file for the dashboard files tab.
        void readWorkerFile((payload as unknown as FsReadRequest).path).then((reply) =>
          this.send(WsChannels.FS_READ, reply, message.id),
        );
        break;
      case WsChannels.FS_WRITE: {
        // Request/reply (machine-0027, ADR-0151): write a file, clamped to the physic root —
        // the Git tab's manual conflict resolution.
        const req = payload as unknown as FsWriteRequest;
        void writeWorkerFile(this.physicRoot, req.path, req.content).then((reply) =>
          this.send(WsChannels.FS_WRITE, reply, message.id),
        );
        break;
      }
      case WsChannels.SUPPORT_ANSWER: {
        // Request/reply (ADR-0170): a support agent answers a "how to use 4PM" question by
        // reading the shared docs/FAQ repo. Isolated from any customer project (own cache dir).
        // Resolve the operator's configured claude profiles (working-first) so claude runs with a
        // signed-in account (CLAUDE_CONFIG_DIR) + its model and fails over on auth/limit — the same
        // profile handling as the normal AI dispatch (ADR-0057), which a bare `claude` lacked.
        const req = payload as unknown as SupportAnswerRequest;
        const supportConfig = readProfileConfig(this.context.profileDir);
        const supportCmd = supportConfig.aiCli || "claude";
        const supportAi = {
          cmd: supportCmd,
          profiles: resolveClaudeProfiles(
            supportConfig,
            getWorkingProfile(this.context.profileDir, supportCmd),
          ),
          env: supportConfig.aiEnv,
        };
        // Echo the Q&A into the transcript like a normal AI dispatch (ADR-0057/0108) so the
        // operator at the support machine sees the question and the composed answer, not just
        // the "processing" spinner. Server-dispatched ⇒ source "server".
        this.bus.push({ source: "server", kind: "aireq", text: `${supportCmd} ‹ ${req.question}` });
        this.bus.startBusy("support-answer");
        void runSupportAnswer(req, supportAi, this.context.profileDir)
          .then((reply) => {
            if (reply.error) {
              this.bus.push({
                source: "server",
                kind: "log",
                text: `support-answer failed: ${reply.error}`,
                level: "warn",
              });
            } else {
              this.bus.push({ source: "server", kind: "aires", text: `${supportCmd} ›` });
              this.bus.push({ source: "server", kind: "out", text: reply.body });
            }
            // Surface the AI CLI's health to the admin pool (ADR-0223) — the support agent's most
            // common failure ("Not logged in") is exactly what an operator needs to see.
            reportToolResult(supportCmd, !reply.error, reply.error);
            this.send(WsChannels.SUPPORT_ANSWER, reply, message.id);
          })
          .finally(() => this.bus.endBusy("support-answer"));
        break;
      }
      case WsChannels.KNOWLEDGE_COMPOSE: {
        // Request/reply (ADR-0190): AI-distil this project into a knowledge article, run in the
        // project's working dir so the model can read the code/docs. Same profile handling as the
        // normal AI dispatch (ADR-0057). No physic root (idle cli) ⇒ error ⇒ server templates it.
        const kreq = payload as unknown as KnowledgeComposeRequest;
        if (!this.physicRoot) {
          this.send(WsChannels.KNOWLEDGE_COMPOSE, { bodyMarkdown: "", error: "no project" }, message.id);
          break;
        }
        const kcfg = readProfileConfig(this.context.profileDir);
        const kcmd = kcfg.aiCli || "claude";
        const kai = {
          cmd: kcmd,
          profiles: resolveClaudeProfiles(kcfg, getWorkingProfile(this.context.profileDir, kcmd)),
          env: kcfg.aiEnv,
        };
        this.bus.push({ source: "server", kind: "aireq", text: `${kcmd} ‹ distil knowledge` });
        this.bus.startBusy("knowledge-compose");
        void runKnowledgeCompose(kreq, kai, this.physicRoot)
          .then((reply) => {
            if (reply.error) {
              this.bus.push({ source: "server", kind: "log", text: `knowledge-compose failed: ${reply.error}`, level: "warn" });
            } else {
              this.bus.push({ source: "server", kind: "aires", text: `${kcmd} ›` });
            }
            this.send(WsChannels.KNOWLEDGE_COMPOSE, reply, message.id);
          })
          .finally(() => this.bus.endBusy("knowledge-compose"));
        break;
      }
      case WsChannels.AUTONOMOUS_READ:
        // Request/reply (machine-0028, ADR-0152): settings + status + books + approvals.
        if (this.physicRoot) {
          void readAutonomous(this.physicRoot).then((reply) =>
            this.send(WsChannels.AUTONOMOUS_READ, reply, message.id),
          );
        }
        break;
      case WsChannels.AUTONOMOUS_LOGS: {
        // Request/reply (machine-0030, ADR-0152): tail one day's tick log.
        const req = payload as unknown as AutonomousLogsRequest;
        if (this.physicRoot) {
          void readAutonomousLogs(this.physicRoot, req.date).then((reply) =>
            this.send(WsChannels.AUTONOMOUS_LOGS, reply, message.id),
          );
        }
        break;
      }
      case WsChannels.AUTONOMOUS_WRITE: {
        // Request/reply (machine-0029, ADR-0152): settings/approvals/userTodo/cron. `by` (the
        // author, for trace) is filled server-side and rides the payload.
        const req = payload as unknown as AutonomousWriteRequest & { by?: string };
        if (this.physicRoot) {
          void writeAutonomous(this.physicRoot, req, req.by ?? "unknown").then((reply) =>
            this.send(WsChannels.AUTONOMOUS_WRITE, reply, message.id),
          );
        }
        break;
      }
      case WsChannels.AGENTS_LIST:
        // Request/reply (machine-0031, ADR-0153): list subagents + skills.
        if (this.physicRoot) {
          void listAgents(this.physicRoot).then((reply) =>
            this.send(WsChannels.AGENTS_LIST, reply, message.id),
          );
        }
        break;
      case WsChannels.AGENTS_READ: {
        // Request/reply (machine-0032, ADR-0153): one subagent/skill's content (+ subagent memory).
        const req = payload as unknown as AgentReadRequest;
        if (this.physicRoot) {
          void readAgent(this.physicRoot, req.kind, req.name).then((reply) =>
            this.send(WsChannels.AGENTS_READ, reply, message.id),
          );
        }
        break;
      }
      case WsChannels.AGENTS_WRITE: {
        // Request/reply (machine-0033, ADR-0153): create/edit or delete a subagent/skill.
        const req = payload as unknown as AgentWriteRequest;
        if (this.physicRoot) {
          void writeAgent(this.physicRoot, req).then((reply) =>
            this.send(WsChannels.AGENTS_WRITE, reply, message.id),
          );
        }
        break;
      }
      case WsChannels.SECRETS_READ:
        // Request/reply (machine-0034, ADR-0154): security docs + placeholder keys (no values).
        if (this.physicRoot) {
          void readSecrets(this.physicRoot).then((reply) =>
            this.send(WsChannels.SECRETS_READ, reply, message.id),
          );
        }
        break;
      case WsChannels.SECRETS_WRITE: {
        // Request/reply (machine-0035, ADR-0154): write a doc, or set/rotate/delete a secret value.
        const req = payload as unknown as SecretsWriteRequest;
        if (this.physicRoot) {
          void writeSecrets(this.physicRoot, req).then((reply) =>
            this.send(WsChannels.SECRETS_WRITE, reply, message.id),
          );
        }
        break;
      }
      case WsChannels.AGENT_TOOLS_READ: {
        // Request/reply (machine-0044, ADR-0183): the permissions block of a settings file.
        const req = payload as unknown as AgentToolsReadRequest;
        if (this.physicRoot) {
          void readAgentTools(this.physicRoot, req.scope).then((reply) =>
            this.send(WsChannels.AGENT_TOOLS_READ, reply, message.id),
          );
        }
        break;
      }
      case WsChannels.AGENT_TOOLS_WRITE: {
        // Request/reply (machine-0045, ADR-0183): replace a permissions block (preserve rest + secrets deny).
        const req = payload as unknown as AgentToolsWriteRequest;
        if (this.physicRoot) {
          void writeAgentTools(this.physicRoot, req.scope, req.permissions).then((reply) =>
            this.send(WsChannels.AGENT_TOOLS_WRITE, reply, message.id),
          );
        }
        break;
      }
      case WsChannels.PACKAGES_PACK: {
        // Request/reply (machine-0049, ADR-0185): read a subagent/skill into a payload file set.
        const req = payload as unknown as PackagesPackRequest;
        if (this.physicRoot) {
          void packPackage(this.physicRoot, req.kind, req.name).then((reply) =>
            this.send(WsChannels.PACKAGES_PACK, reply, message.id),
          );
        }
        break;
      }
      case WsChannels.PACKAGES_INSTALL: {
        // Request/reply (machine-0046, ADR-0185): write a package version into .claude (drift-guarded).
        const req = payload as unknown as PackagesInstallRequest;
        if (this.physicRoot) {
          void installPackage(this.physicRoot, req).then((reply) =>
            this.send(WsChannels.PACKAGES_INSTALL, reply, message.id),
          );
        }
        break;
      }
      case WsChannels.PACKAGES_LIST:
        // Request/reply (machine-0047, ADR-0185): installed manifest + on-disk sha256 (drift).
        if (this.physicRoot) {
          void listPackages(this.physicRoot).then((reply) =>
            this.send(WsChannels.PACKAGES_LIST, reply, message.id),
          );
        }
        break;
      case WsChannels.PACKAGES_REMOVE: {
        // Request/reply (machine-0048, ADR-0185): delete an installed artifact + manifest entry.
        const req = payload as unknown as PackagesRemoveRequest;
        if (this.physicRoot) {
          void removePackage(this.physicRoot, req.slug).then((reply) =>
            this.send(WsChannels.PACKAGES_REMOVE, reply, message.id),
          );
        }
        break;
      }
      case WsChannels.GRAPH_BUILD: {
        // Request/reply (machine-0036, ADR-0155): build the docs/code dependency graph.
        const req = payload as unknown as GraphBuildRequest;
        if (this.physicRoot) {
          void buildGraph(this.physicRoot, req.mode).then((reply) =>
            this.send(WsChannels.GRAPH_BUILD, reply, message.id),
          );
        }
        break;
      }
      case WsChannels.RAG_STATUS:
        // Request/reply (machine-0037, ADR-0156): probe RAG capability + install state.
        if (this.physicRoot) {
          void ragStatus(this.physicRoot).then((reply) =>
            this.send(WsChannels.RAG_STATUS, reply, message.id),
          );
        }
        break;
      case WsChannels.RAG_INSTALL: {
        // Request/reply (machine-0038, ADR-0156): launch a background RAG install.
        const req = payload as unknown as RagInstallRequest;
        if (this.physicRoot) {
          void ragInstall(this.physicRoot, req.model).then((reply) =>
            this.send(WsChannels.RAG_INSTALL, reply, message.id),
          );
        }
        break;
      }
      case WsChannels.RAG_REINDEX:
        // Request/reply (machine-0039, ADR-0157): (re)build the vector index in the background.
        if (this.physicRoot) {
          void ragReindex(this.physicRoot).then((reply) =>
            this.send(WsChannels.RAG_REINDEX, reply, message.id),
          );
        }
        break;
      case WsChannels.RAG_QUERY: {
        // Request/reply (machine-0040, ADR-0157): semantic search over the index.
        const req = payload as unknown as RagQueryRequest;
        if (this.physicRoot) {
          void ragQuery(this.physicRoot, req.query, req.k).then((reply) =>
            this.send(WsChannels.RAG_QUERY, reply, message.id),
          );
        }
        break;
      }
      case WsChannels.CONFIG_READ:
        // Request/reply (machine-0025, ADR-0141): the paired profile's config.json as text.
        this.send(
          WsChannels.CONFIG_READ,
          { config: readConfigText(this.context.profileDir) } satisfies ConfigReadReply,
          message.id,
        );
        break;
      case WsChannels.CONFIG_WRITE: {
        // Request/reply (machine-0026, ADR-0141): validate + replace config.json; server-managed
        // fields (physicPath + ws_token mirror) are preserved from the current file.
        const res = applyConfigText(
          this.context.profileDir,
          (payload as unknown as ConfigWriteRequest).config,
        );
        this.send(WsChannels.CONFIG_WRITE, res satisfies ConfigWriteReply, message.id);
        break;
      }
      case WsChannels.TOOLS_LIST:
        // Request/reply (machine-0050, ADR-0206): probe the default catalog + extra globals.
        void detectWorkerTools().then((reply) =>
          this.send(WsChannels.TOOLS_LIST, reply satisfies ToolsListReply, message.id),
        );
        break;
      case WsChannels.TOOLS_INSTALL:
      case WsChannels.TOOLS_UNINSTALL: {
        // Streamed op (machine-0051/0052, ADR-0206): ack acceptance, then push progress lines and
        // one terminal `tools.done` frame keyed by opId (server relays them to the browser over SSE).
        const req = payload as unknown as ToolsMutateRequest;
        const op = message.channel === WsChannels.TOOLS_INSTALL ? "install" : "uninstall";
        this.send(message.channel, { started: true } satisfies ToolsMutateReply, message.id);
        void runWorkerToolOp(op, req.name, req.manager, (line) =>
          this.send(WsChannels.TOOLS_PROGRESS, { opId: req.opId, line } satisfies ToolsProgressPayload),
        ).then((res) =>
          this.send(WsChannels.TOOLS_DONE, {
            opId: req.opId,
            ok: res.ok,
            exitCode: res.exitCode,
            error: res.error,
          } satisfies ToolsDonePayload),
        );
        break;
      }
      case WsChannels.GIT_DIFF:
        // Request/reply — HEAD vs working-tree content for Monaco diff.
        void gitDiff((payload as unknown as GitDiffRequest).path).then((reply) =>
          this.send(WsChannels.GIT_DIFF, reply, message.id),
        );
        break;
      case WsChannels.GIT_ENV:
        // Request/reply (machine-0008).
        void checkGitEnv((payload as unknown as GitEnvRequest).provider).then((reply) =>
          this.send(WsChannels.GIT_ENV, reply, message.id),
        );
        break;
      case WsChannels.GIT_REPOS:
        // Request/reply (machine-0021): repos under the physic project (read-only — ADR-0089).
        void gitRepos(this.physicRoot).then((reply) =>
          this.send(WsChannels.GIT_REPOS, reply, message.id),
        );
        break;
      case WsChannels.GIT_SSH_KEY: {
        // Request/reply (ADR-0173): manage the rented worker's ssh deploy key (on the worker).
        const req = payload as unknown as GitSshKeyRequest;
        void manageSshKey(req.op, this.context.profileDir).then((reply) =>
          this.send(WsChannels.GIT_SSH_KEY, reply, message.id),
        );
        break;
      }
      case WsChannels.GIT_LOG: {
        // Request/reply (machine-0022): commit history of a repo, paged.
        const req = payload as unknown as GitLogRequest;
        void gitLog(this.physicRoot, req.repo ?? "", req.skip ?? 0, req.limit ?? 50).then((reply) =>
          this.send(WsChannels.GIT_LOG, reply, message.id),
        );
        break;
      }
      case WsChannels.GIT_COMMIT: {
        // Request/reply (machine-0023): files changed in a commit.
        const req = payload as unknown as GitCommitRequest;
        void gitCommit(this.physicRoot, req.repo ?? "", req.hash).then((reply) =>
          this.send(WsChannels.GIT_COMMIT, reply, message.id),
        );
        break;
      }
      case WsChannels.GIT_COMMIT_DIFF: {
        // Request/reply (machine-0024): parent↔commit content of one file (Monaco diff).
        const req = payload as unknown as GitCommitDiffRequest;
        void gitCommitDiff(this.physicRoot, req.repo ?? "", req.hash, req.path).then((reply) =>
          this.send(WsChannels.GIT_COMMIT_DIFF, reply, message.id),
        );
        break;
      }
      case WsChannels.LOG_READ: {
        // Request/reply (machine-0019): tail this cli's own JSONL logs (ADR-0072).
        const limit = Math.min(Math.max((payload as LogReadRequest).limit ?? 200, 1), 2000);
        const lines = readRecentLogLines(join(this.context.profileDir, "logs"), limit);
        this.send(WsChannels.LOG_READ, { lines } satisfies LogReadReply, message.id);
        break;
      }
      case WsChannels.COMMAND_OUTPUT_READ: {
        // Request/reply (ADR-0115): read a finished command's captured output from the local
        // command-output store; null when pruned (>200 files) or never captured.
        const output = readCommandOutput((payload as unknown as CommandOutputRequest).commandId);
        this.send(WsChannels.COMMAND_OUTPUT_READ, { output } satisfies CommandOutputReply, message.id);
        break;
      }
      case WsChannels.RENTAL_FLUSH: {
        // Request/reply (ADR-0210): the machine is being released — flush the pending log tail so
        // it is persisted server-side before the scrub, then ack. Per-command history was already
        // pushed on finish, so the log upload is the only queued data. Best-effort; always acks.
        this.uploadLog();
        this.send(WsChannels.RENTAL_FLUSH, { ok: true } satisfies RentalFlushReply, message.id);
        break;
      }
      case WsChannels.PROJECT_CREATE:
        // Scaffold into <profileDir>/<projectName> (ADR-0080) + AI init + stream progress.
        void scaffoldProject(
          payload as unknown as ProjectCreatePayload,
          this.context.profileDir,
          (p) => this.send(WsChannels.PROJECT_PROGRESS, p),
        ).then((reply) => this.send(WsChannels.PROJECT_CREATE, reply, message.id));
        break;
      case WsChannels.PROJECT_ADD:
        // Register an existing project: clone/link its repos into <profileDir>/<projectName>
        // (ADR-0080/0117), no scaffold/AI-init + stream progress.
        void addProject(
          payload as unknown as ProjectAddPayload,
          this.context.profileDir,
          (p) => this.send(WsChannels.PROJECT_PROGRESS, p),
        ).then((reply) => this.send(WsChannels.PROJECT_ADD, reply, message.id));
        break;
      // AI spec-assist (project-0012/0013/0033) now runs via command.dispatch({ ai:true })
      // → runAiPrompt (profile-failover), not dedicated ai.* channels (ADR-0100).
      case WsChannels.REVIEW_EVALUATE:
        // This cli is an outbound reviewer (ADR-0082): vet another cli's input, reply verdict.
        void evaluateReview(payload as unknown as ReviewEvaluatePayload).then((reply) =>
          this.send(WsChannels.REVIEW_EVALUATE, reply, message.id),
        );
        break;
      case WsChannels.CONSOLE_WATCH:
        // A web Console viewer attached/detached (ADR-0150) — start/stop mirroring the transcript.
        this.setConsoleWatching((payload as unknown as ConsoleWatchPayload).on);
        break;
      case WsChannels.METRICS_WATCH:
        // A viewer has the Workers tab open (ADR-0214) — start/stop sampling worker resources.
        this.setMetricsWatching((payload as unknown as MetricsWatchPayload).on);
        break;
      default:
        this.bus.log(`Unsupported channel: ${message.channel}`, "warn");
    }
  }

  /**
   * Run a prompt the operator typed in the TUI input box (ADR-0057). There is no
   * command whitelist: the prompt is handed to the configured AI CLI (default
   * `claude`) so the AI agent decides whether to call gh/glab/git/etc. The command is
   * announced to the server (tracking record + history) then spawned through the
   * shared executor — streaming output to BOTH the local transcript and the server
   * (origin = local).
   */
  private async runLocalCommand(input: string): Promise<void> {
    const prompt = input.trim();
    if (!prompt) return;
    if (this.stopped) {
      this.bus.log("Session stopped — restart 4pm to run prompts.", "warn");
      return;
    }
    // Correct order (ADR-0064): make the session + physic project ready BEFORE spawning
    // claude. Check status → reconnect + wait if the socket dropped → then run. While
    // connected, project changes already arrive live via PHYSIC_SYNC/PHYSIC_DELETE, so
    // `physicRoot` is current without a reconnect.
    if (!this.sessionKey || this.bus.status !== "connected") {
      this.bus.log("Not connected — reconnecting before running the prompt…");
      this.reconnectNow();
      const ready = await this.awaitConnected(10_000);
      if (!ready) {
        this.bus.log("Still not connected — run /reconnect then try again.", "warn");
        return;
      }
    }
    const commandId = randomCommandId();
    await this.runAiPrompt(prompt, commandId, "local");
  }

  /**
   * Run an AI prompt through the AI-CLI **profile-failover** path (ADR-0057). Shared by a
   * locally-typed prompt (`origin: "local"`) and a server-dispatched AI prompt
   * (`origin: "server"` — command.dispatch with `ai:true`), so the web console behaves
   * exactly like typing the prompt in the cli (tries profiles, meters real tokens) instead
   * of spawning the text as a raw command. Streams output to the transcript AND the server.
   */
  private async runAiPrompt(prompt: string, commandId: string, origin: CommandOrigin): Promise<void> {
    const config = readProfileConfig(this.context.profileDir);
    // Per-prompt token cap (ADR-0081): reject before spawning when the prompt's estimated
    // tokens exceed the project limit. Cheaper than starting a run just to abort it.
    const perPromptLimit = config.perPromptTokenLimit ?? 0;
    if (perPromptLimit > 0) {
      const estimated = estimateTokens(prompt);
      if (estimated > perPromptLimit) {
        this.rejectPromptOverLimit(commandId, origin, prompt, estimated, perPromptLimit);
        return;
      }
    }
    // Outbound review (ADR-0082): when the project requires it, an outbound cli must approve
    // this input before we spawn. The verdict is server-authoritative; a failure to obtain
    // one (timeout/offline) blocks (fail closed) — the input never reaches the AI.
    if (this.outboundReviewEnabled) {
      let verdict: ReviewResultPayload;
      try {
        verdict = await this.request<ReviewResultPayload>(WsChannels.REVIEW_REQUEST, {
          commandId,
          prompt,
        });
      } catch {
        verdict = { commandId, ok: false, reasons: ["unavailable"] };
      }
      if (!verdict.ok) {
        this.rejectByReview(commandId, origin, prompt, verdict.reasons);
        return;
      }
    }
    // Run inside the live serving-project folder (kept current by the connect handler +
    // PHYSIC_SYNC/DELETE), not the stale manual `physicPath`. Idle cli ⇒ warn and fall
    // back to the launch dir so the operator knows no project is attached.
    const cwd = this.physicRoot ?? config.physicPath ?? process.cwd();
    if (this.physicRoot) {
      this.ensurePhysicFolderPath(this.physicRoot); // (re)create if a new/removed folder
      // Set the git commit author to the machine username before the AI (which may commit)
      // runs (ADR-0097); push uses the worker's logged-in gh/glab account. Best-effort.
      await setCommitAuthor(cwd, this.machineUsername);
    } else {
      this.bus.log("No project attached — running in the current directory.", "warn");
    }
    // `||` (not `??`): a blank aiCli ("mixed"/none — ADR-0182) falls back to claude. In unified
    // mode `cmd` is only used by the legacy-only branches below, so this is just a safe default.
    const cmd = config.aiCli || "claude";
    // Working-first memory (ADR-0057): the unified mixed list (ADR-0182) remembers one
    // cross-provider credential key; the legacy plan remembers the per-cmd profile dir. In
    // "priority" mode (ADR-0182) the memory is ignored so every prompt starts at the list top.
    const unified = isUnifiedConfig(config);
    const mode = config.aiFailoverMode ?? "remember";
    const workingDir = unified ? null : getWorkingProfile(this.context.profileDir, cmd);
    const workingCred =
      unified && mode === "remember" ? getWorkingCredential(this.context.profileDir) : null;
    // Rotate the Claude profile under session pressure (ADR-0081): when the project set
    // sessionSwitchPct and the current 5h session utilization is at/over it, prefer the
    // NEXT candidate profile for this run instead of the near-exhausted working one. Claude-only.
    const startDir = unified ? null : this.profileUnderSessionPressure(config, cmd, workingDir);
    const startCred = unified ? this.credentialUnderSessionPressure(config, workingCred) : null;
    if (startDir && startDir !== workingDir) {
      this.bus.push({
        source: origin,
        kind: "log",
        text: `session ${this.usageSnapshot?.session.utilizationPct ?? 0}% ≥ ${config.sessionSwitchPct}% — switching to Claude profile "${profileDisplayLabel(startDir)}"`,
      });
    }
    if (startCred && startCred !== workingCred) {
      this.bus.push({
        source: origin,
        kind: "log",
        text: `session ${this.usageSnapshot?.session.utilizationPct ?? 0}% ≥ ${config.sessionSwitchPct}% — switching to Claude profile "${labelFromCredentialKey(startCred)}"`,
      });
    }
    // Folder-scope hardening (project aiScope): when the project restricts the AI to its
    // folder, prepend a guard so the agent only uses content inside the served worker
    // folder. Only the AI actually sees this — the markers/announce/history below keep
    // echoing the raw operator prompt so the console shows exactly what was typed.
    const effectivePrompt =
      this.restrictToFolder && this.physicRoot ? folderScopeGuard(this.physicRoot, prompt) : prompt;
    const plan = planAiRun(
      effectivePrompt,
      config,
      unified ? { credential: startCred ?? workingCred } : { dir: startDir ?? workingDir },
    );
    // Representative argv for the announce/history markers (args are now per-profile —
    // the first attempt's are used; failover may run a different profile's args).
    const markerArgs = plan.attempts[0]?.args ?? [];
    // Request marker: "<cmd> ‹ <prompt>" (the CLI name is colored in the transcript).
    this.bus.push({ source: origin, kind: "aireq", text: `${plan.cmd} ‹ ${prompt}` });
    logger.info("command.ai", { commandId, origin, cmd: plan.cmd, profiles: plan.attempts.length });
    // A local prompt has no server record yet ⇒ announce it (ADR-0057); a server-dispatched
    // AI prompt already has a tracking record from command-0001.
    if (origin === "local") {
      this.send(WsChannels.COMMAND_ANNOUNCE, {
        commandId,
        cmd: plan.cmd,
        args: markerArgs,
        // The raw prompt so the web console echoes it like this TUI (ADR-0108), not "claude".
        prompt,
        origin: "local",
      } satisfies CommandAnnouncePayload);
    }
    recordCommand({ commandId, cmd: plan.cmd, args: markerArgs });
    const startedAt = new Date().toISOString();
    this.bus.startBusy(plan.cmd);

    // Try the profile candidates until one authenticates; stream verbatim to the
    // transcript AND the server (one commandId, a single final "done").
    let seq = 0;
    // Response marker: emitted once, right before the first output chunk, as "<cmd> ›".
    let responseHeaderShown = false;
    // Result auto-collapse (ADR-0108): decide once from the leading output whether the whole
    // response is json/code (collapse into one growing `result` block) or prose (stream as
    // `out` lines). `resultId` is the growing block's entry id while in "result" mode.
    let displayMode: "pending" | "prose" | "result" = "pending";
    let resultId: string | null = null;
    let resultBuf = "";
    const result = await runAiFailover(plan, commandId, cwd, {
      onChunk: (text) => {
        if (!responseHeaderShown) {
          this.bus.push({ source: origin, kind: "aires", text: `${plan.cmd} ›` });
          responseHeaderShown = true;
        }
        // Server stream + local history are always verbatim (display collapse is render-only).
        appendCommandOutput(commandId, text);
        this.send(WsChannels.COMMAND_OUTPUT, { commandId, seq: seq++, chunk: text });
        if (displayMode === "result") {
          resultBuf += text;
          if (resultId) this.bus.updateEntry(resultId, resultBuf);
          return;
        }
        if (displayMode === "prose") {
          this.bus.push({ source: origin, kind: "out", text });
          return;
        }
        // Pending: buffer until the first non-whitespace char, then commit to a mode.
        resultBuf += text;
        if (resultBuf.replace(/^\s+/, "").length === 0) return;
        const kind = looksLikeJsonOrCode(resultBuf);
        if (kind) {
          displayMode = "result";
          resultId = this.bus.push({ source: origin, kind: "result", text: resultBuf, resultKind: kind });
        } else {
          displayMode = "prose";
          this.bus.push({ source: origin, kind: "out", text: resultBuf });
        }
      },
      onAttemptStart: (label, index, total, cmd) => {
        // Use the attempt's OWN provider command (ADR-0197): a mixed plan must not label a codex
        // attempt as "claude". `plan.cmd` is only the first attempt's representative command.
        const text = `→ trying ${cmd} profile "${label}" (${index + 1}/${total})…`;
        this.bus.push({ source: origin, kind: "log", text });
        // Mirror the status line to the web console (memo #5) as a `log` frame so it shows
        // there too, without polluting the persisted transcript or the result-collapse detector.
        this.send(WsChannels.COMMAND_OUTPUT, { commandId, seq: seq++, chunk: `${text}\n`, log: true });
      },
      onAttemptFail: (label, reason) => {
        const text =
          reason === "limit"
            ? `profile "${label}" hit its session limit — trying next`
            : `profile "${label}" failed to authenticate — trying next`;
        this.bus.push({ source: origin, kind: "log", text, level: "warn" });
        this.send(WsChannels.COMMAND_OUTPUT, { commandId, seq: seq++, chunk: `${text}\n`, log: true });
      },
    });

    this.bus.endBusy(plan.cmd);
    // Remember the working profile so the next prompt tries it first (ADR-0057) + show it in the
    // header. Unified plans remember one cross-provider credential key (ADR-0182); the legacy plan
    // remembers the per-cmd dir. (In "priority" mode the memory is written but ignored on read.)
    const profileLabel = result.workedDir ? profileDisplayLabel(result.workedDir) : null;
    if (result.workedDir) {
      if (unified && result.workedKey) {
        setWorkingCredential(this.context.profileDir, result.workedKey);
      } else {
        setWorkingProfile(this.context.profileDir, result.workedCmd ?? plan.cmd, result.workedDir);
      }
      this.bus.setActiveProfile(profileLabel ?? plan.cmd);
    }
    this.send(WsChannels.COMMAND_OUTPUT, {
      commandId,
      seq: seq++,
      chunk: "",
      done: true,
      exitCode: result.exitCode,
    });
    finishCommand(commandId, result.exitCode, result.usage);
    // Push a durable command-history record (rich: cmd + real tokens + exit — ADR-0072).
    this.send(WsChannels.COMMAND_HISTORY, {
      commandId,
      cmd: plan.cmd,
      args: markerArgs,
      status: result.exitCode === 0 ? "done" : "failed",
      exitCode: result.exitCode,
      tokens: result.usage.tokens,
      // The ai_tokens split for this run (ADR-0145); attached only when we metered real tokens.
      ...(result.usage.tokens > 0 && {
        tokensBreakdown: {
          input: result.usage.input,
          output: result.usage.output,
          cacheRead: result.usage.cacheRead,
          cacheCreation: result.usage.cacheCreation,
        },
      }),
      startedAt,
      finishedAt: new Date().toISOString(),
    } satisfies CommandHistoryPayload);
    // Report usage so the server can meter quota + build the per-profile breakdown
    // (ADR-0020/0072); `profile` = the account/dir that worked. One AI run = 1 command;
    // ai_tokens = the run's real tokens (when known).
    const occurredAt = new Date().toISOString();
    const events: UsageReportPayload["events"] = [
      { metric: UsageMetric.COMMANDS, amount: 1, occurredAt },
    ];
    if (result.exitCode === 0 && result.usage.tokens > 0) {
      events.push({
        metric: UsageMetric.AI_TOKENS,
        amount: result.usage.tokens,
        occurredAt,
        // The ai_tokens split so the server can persist + display it (ADR-0145).
        inputTokens: result.usage.input,
        outputTokens: result.usage.output,
        cacheReadTokens: result.usage.cacheRead,
        cacheCreationTokens: result.usage.cacheCreation,
        // Auth mode for billing split (ADR-0192 §5): subscription (OAuth) vs api-key (API-billed).
        authMode: resolveClaudeAuthMode(config),
      });
      this.bus.addTokens?.(result.usage.tokens); // session token counter for the header
    }
    this.reportUsage(events, profileLabel);
    // Refresh the usage snapshot after any run (e.g. `/usage` rotates the token — ADR-0072).
    void this.pollUsage();
    // Report a friendly completion line instead of a raw exit code: on success prompt
    // for the next message; on failure surface an error (details are streamed above).
    this.bus.push({
      source: origin,
      kind: "exit",
      text:
        result.exitCode === 0
          ? "✓ ready — enter your next prompt"
          : `✗ ${plan.cmd} failed (exit ${result.exitCode}) — see the error above`,
      level: result.exitCode === 0 ? "info" : "error",
    });
  }

  /**
   * Pick the Claude profile to try first when under session pressure (ADR-0081). Returns
   * the next candidate dir (cyclically after the current working one) when the knob is set
   * and the live session utilization is at/over it AND there is more than one candidate;
   * otherwise null (keep the normal working-first ordering). Claude-only (session % is a
   * Claude subscription metric).
   */
  private profileUnderSessionPressure(
    config: ReturnType<typeof readProfileConfig>,
    cmd: string,
    workingDir: string | null,
  ): string | null {
    const threshold = config.sessionSwitchPct ?? 0;
    if (threshold <= 0 || cmd !== "claude") return null;
    const util = this.usageSnapshot?.session.utilizationPct ?? 0;
    if (util < threshold) return null;
    const dirs = claudeHomeDirs(config);
    if (dirs.length < 2) return null;
    const currentIndex = workingDir ? dirs.indexOf(workingDir) : -1;
    const next = dirs[(currentIndex + 1) % dirs.length];
    return next ?? null;
  }

  /**
   * Unified-list equivalent of {@link profileUnderSessionPressure} (ADR-0182): under session
   * pressure, return the next **claude** credential key (cyclically after the working one) so the
   * failover starts on a fresher Claude account. Claude-only — %session is a Claude subscription
   * metric; codex/antigravity entries are unaffected. Null ⇒ keep the working-first order.
   */
  private credentialUnderSessionPressure(
    config: ReturnType<typeof readProfileConfig>,
    workingCred: string | null,
  ): string | null {
    const threshold = config.sessionSwitchPct ?? 0;
    if (threshold <= 0) return null;
    const util = this.usageSnapshot?.session.utilizationPct ?? 0;
    if (util < threshold) return null;
    const keys = claudeCredentialKeys(config);
    if (keys.length < 2) return null;
    const currentIndex = workingCred ? keys.indexOf(workingCred) : -1;
    return keys[(currentIndex + 1) % keys.length] ?? null;
  }

  /**
   * Reject a prompt whose estimated tokens exceed the project's per-prompt limit (ADR-0081)
   * without spawning: surface it in the transcript + close the command on the server with a
   * PROMPT_TOKEN_LIMIT_EXCEEDED note (exit 1). No usage is metered (nothing ran).
   */
  private rejectPromptOverLimit(
    commandId: string,
    origin: CommandOrigin,
    prompt: string,
    estimated: number,
    limit: number,
  ): void {
    const message = `[PROMPT_TOKEN_LIMIT_EXCEEDED] Prompt (~${estimated} tokens) exceeds the project per-prompt limit of ${limit} tokens.`;
    logger.warn("command.ai.prompt-limit", { commandId, origin, estimated, limit });
    this.bus.push({ source: origin, kind: "log", text: message, level: "error" });
    // A local prompt has no server record yet ⇒ announce it so the failure is trackable.
    if (origin === "local") {
      this.send(WsChannels.COMMAND_ANNOUNCE, {
        commandId,
        cmd: "claude",
        args: [],
        prompt,
        origin: "local",
      } satisfies CommandAnnouncePayload);
    }
    this.send(WsChannels.COMMAND_OUTPUT, { commandId, seq: 0, chunk: message });
    this.send(WsChannels.COMMAND_OUTPUT, { commandId, seq: 1, chunk: "", done: true, exitCode: 1 });
    this.bus.push({
      source: origin,
      kind: "exit",
      text: "✗ prompt rejected — over the project per-prompt token limit",
      level: "error",
    });
  }

  /**
   * Reject a prompt an outbound reviewer blocked (ADR-0082) without spawning: surface the
   * verdict + close the command on the server. `reasons` contains only violation categories
   * (never secret values); a "unavailable" reason maps to no-outbound-available.
   */
  private rejectByReview(commandId: string, origin: CommandOrigin, prompt: string, reasons: string[]): void {
    const unavailable = reasons.includes("unavailable");
    const code = unavailable ? "OUTBOUND_REVIEW_UNAVAILABLE" : "OUTBOUND_REVIEW_REJECTED";
    const detail = reasons.filter((r) => r !== "unavailable").join(", ");
    const message = unavailable
      ? `[${code}] No outbound reviewer is available — input blocked.`
      : `[${code}] Outbound review rejected the input${detail ? ` (${detail})` : ""}.`;
    logger.warn("command.ai.outbound-review", { commandId, origin, reasons });
    this.bus.push({ source: origin, kind: "log", text: message, level: "error" });
    if (origin === "local") {
      this.send(WsChannels.COMMAND_ANNOUNCE, {
        commandId,
        cmd: "claude",
        args: [],
        prompt,
        origin: "local",
      } satisfies CommandAnnouncePayload);
    }
    this.send(WsChannels.COMMAND_OUTPUT, { commandId, seq: 0, chunk: message });
    this.send(WsChannels.COMMAND_OUTPUT, { commandId, seq: 1, chunk: "", done: true, exitCode: 1 });
    this.bus.push({
      source: origin,
      kind: "exit",
      text: "✗ input blocked by outbound review",
      level: "error",
    });
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
        this.bus.log(`Created physic project folder: ${folder}`);
      }
    } catch (err) {
      this.bus.log(`Could not create physic folder: ${err}`, "warn");
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
    this.send(WsChannels.MACHINE_STATUS, {
      status: "online",
      projects: [],
      version: CLI_VERSION,
      physicPath,
      physicPathExists: physicPath ? existsSync(physicPath) : undefined,
      // Real coarse state (ADR-0152): !paused and a recent tick (was hard-coded false).
      autonomousRunning: physicPath ? isAutonomousRunning(physicPath) : false,
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
    this.bus.log(
      `Link is no longer valid (${reason}) — deleted .cre. Run \`4pm link\` to pair again.`,
      "error",
    );
  }
}
