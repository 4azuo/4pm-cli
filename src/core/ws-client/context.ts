/**
 * The narrow host interface the WsClient exposes to its extracted channel handlers and the
 * command-dispatch module. `WsClient` builds a single `WsHandlerCtx` object (live
 * getters/setters over its private state + bound methods) and passes it to the pure handler
 * functions in this folder — so those functions never touch the class internals directly,
 * keeping the coupling explicit and the class fields private.
 * @adr 0057
 */
import type { SessionBus } from "../session/session-bus";
import type {
  ImageFetchReply,
  MachineUsagePayload,
  ToolRestoreFailureItem,
  ToolsReportPayload,
  UsageReportPayload,
  WsChannelName,
} from "@4pm/ws";

/** Everything the extracted handlers / command-dispatch need from the running WsClient. */
export interface WsHandlerCtx {
  /** Presentation bridge: lifecycle logs, command I/O, local input. */
  readonly bus: SessionBus;
  /** The paired profile directory (`context.profileDir`). */
  readonly profileDir: string;
  /** The paired server URL (`context.credential.serverUrl`). */
  readonly serverUrl: string;
  /** Process start (ms) — uptime for a web-dispatched `/status`. */
  readonly startedAtMs: number;
  /** This machine-user's username — the git commit author for the served project. @adr 0097 */
  readonly machineUsername: string;
  /** Org timezone (IANA) from the last ws_token — stamps the AI-run start marker. @adr 0132 @adr 0249 */
  readonly orgTimezone: string;
  /** Last Claude subscription usage snapshot — drives session-pressure rotation. @adr 0072 */
  readonly usageSnapshot: MachineUsagePayload | null;
  /** Whether inputs must pass outbound review before spawning AI. @adr 0082 */
  readonly outboundReviewEnabled: boolean;
  /** Whether the AI is restricted to the served worker folder (project aiScope). */
  readonly restrictToFolder: boolean;
  /** True once the session key + status are ready (safe to run a prompt). */
  readonly isReady: boolean;
  /** True once the session stopped for good (logout / replaced / version). */
  readonly isStopped: boolean;
  /** Last `session_id` per credential key for a same-profile `--resume`; mutated in place. @adr 0245 */
  readonly sessionIdByKey: Map<string, string>;
  /** When each remembered session last finished a run + its context size (bounded resume). @adr 0339 */
  readonly sessionMetaByKey: Map<string, { at: number; contextTokens: number }>;

  /** The physic project folder root this cli serves (null = idle) — fs.list browse root. */
  physicRoot: string | null;
  /** Rolling compacted shared-AI-memory text for the served project. @adr 0245 */
  aiMemory: string;

  /** Update the folder-scope flag live (a PROJECT_TOKENS push). @adr 0256 */
  setRestrictToFolder(value: boolean): void;
  /** Whether a commandId was already accepted (WS at-least-once dedup). */
  hasHandledCommand(commandId: string): boolean;
  /** Mark a commandId accepted for dedup (bounded set). */
  markCommandHandled(commandId: string): void;

  /** Send one envelope (encrypted payload + per-message wsToken). @arch 0004 */
  send(channel: WsChannelName, data: unknown, replyTo?: string | null): void;
  /** Send a cli → server request and await the reply by envelope id (15s timeout). */
  request<T>(channel: WsChannelName, data: unknown): Promise<T>;
  /** Fetch a Console prompt image blob from the server to materialize on the worker. @adr 0257 */
  imageFetch(commandId: string, imageId: string): Promise<ImageFetchReply>;
  /** usage.report batched to the server; tags each event with the AI profile. @adr 0020 */
  reportUsage(events: UsageReportPayload["events"], profile?: string | null): void;
  /** Detect the worker's tools and report the snapshot to the server. @adr 0254 */
  reportWorkerTools(
    trigger?: NonNullable<ToolsReportPayload["trigger"]>,
    restoreFailed?: ToolRestoreFailureItem[],
  ): Promise<void>;
  /** Upload the newest cli log file + total footprint to the server. @adr 0122 */
  uploadLog(): void;
  /** Poll the Claude subscription usage API and push a `machine.usage` snapshot. @adr 0072 */
  pollUsage(): Promise<void>;
  /** Force an immediate reconnect (wake the backoff / drop the socket). */
  reconnectNow(): void;
  /** Resolve true once connected, or false after `timeoutMs` — gates a local prompt. @adr 0064 */
  awaitConnected(timeoutMs: number): Promise<boolean>;
  /** Start/stop mirroring the transcript to the server (console.watch lease). @adr 0150 */
  setConsoleWatching(on: boolean): void;
  /** Start/stop sampling worker resources (metrics.watch lease). @adr 0214 */
  setMetricsWatching(on: boolean): void;
  /** Create the physic folder at an absolute path if missing (best-effort). */
  ensurePhysicFolderPath(folder: string): void;
  /** Absolute path of the physic project folder (`<profile>/<name>`); null for empty. @adr 0064 */
  physicFolderPath(projectName: string): string | null;
  /** Clone any declared repo of the served project missing from the physic root. @adr 0289 */
  cloneServingRepos(): Promise<void>;
  /** Self-update the cli to latest now (idle-aware + re-exec), from a server push. @adr 0289 */
  updateCliNow(): void;
}
