/**
 * WS message envelope (cli-ws 0002): every bidirectional message carries a wsToken
 * (per-message auth) + an AES-256-GCM encrypted payload (with its own nonce).
 */
import type { WsChannelName } from "../channels";
import type { RunQueueInfo } from "./run-slot";

/** Standard envelope for every message after the handshake. */
export interface WsEnvelope {
  /** message id — correlation for the reply. */
  id: string;
  /** id of the request message when this is a reply. */
  replyTo: string | null;
  channel: WsChannelName;
  /** Per-message authentication. @arch 0004 */
  wsToken: string;
  /** AES-256-GCM encrypted content (base64). */
  payload: string;
  /** A per-message nonce (base64). */
  nonce: string;
}

/** Session-opening handshake message (CLI → server, payload not yet encrypted). */
export interface WsHello {
  type: "hello";
  wsToken: string;
  /** Public key ECDH ephemeral (base64, x25519 raw). */
  pubkey: string;
  /** cli version (semver) — the server rejects it if < minSupported. @adr 0015 */
  cliVersion?: string;
  /** Physical-machine fingerprint — the server matches/creates a worker. */
  fingerprint?: string;
  /** Hostname — the default worker name on creation. */
  hostname?: string;
}

/** Reply handshake (server → CLI). */
export interface WsHelloAck {
  type: "hello_ack";
  pubkey: string;
  /** Name of the worker (physical machine) this cli is grouped under, if any —
   *  shown in the cli TUI header. */
  workerName?: string;
  /** Name of the logical project this (project-scope) cli serves, if any — shown in
   *  the cli TUI header scope line. */
  projectName?: string;
}

/** Control error message (server → CLI): WS_TOKEN_INVALID / LINK_REVOKED… */
export interface WsError {
  type: "error";
  errorCode: string;
  message: string;
}

/** Union of control messages (not channel envelopes). */
export type WsControlMessage = WsHello | WsHelloAck | WsError;

// ---------- Per-channel payload (after decryption) ----------

/** machine.status (cli → server) — includes the physic project state
 *  (path being served, does the folder exist?, autonomous?). */
export interface MachineStatusPayload {
  status: string;
  projects?: string[];
  version: string;
  /** The physic project folder the cli is serving (null = not attached). */
  physicPath?: string | null;
  /** Does the physic project folder still exist on the machine? */
  physicPathExists?: boolean;
  /** Is autonomous mode running? */
  autonomousRunning?: boolean;
  /** The machine-user's own AI-run wall-clock limit in seconds (`ProfileConfig.aiRunTimeoutSec`;
   *  `0` = unlimited) — persisted on `MachineLink` so a dispatch can resolve the **effective**
   * timeout (project override else this) and derive the SSE reply windows.
   * @adr 0256
   */
  aiRunTimeoutSec?: number;
  /** Number of configured AI credentials (the failover profile count) — the floor factor for the
   * derived re-attach cap (`effective × profileCount × 1.2`).
   * @adr 0256
   */
  aiProfileCount?: number;
  /** Labels of the configured, usable AI credentials (all providers) — the signed-in account email
   *  when readable, else the credential label / folder name. Persisted on `MachineLink.aiAccounts` so
   * platform admins can see which AI account a rented machine uses.
   * @adr 0354
   */
  aiAccounts?: string[];
  /** True when the cli runs an update-locked image (`:full-locked`): it never updates
   *  itself; persisted on `MachineLink.cliUpdateLocked` (the web Locked badge + the server's update gate).
   * @adr 0432 @adr 0434
   */
  cliUpdateLocked?: boolean;
}

/** Where a command originated: server-dispatched (web) or cli-local (TUI). @adr 0057 */
export type CommandOrigin = "server" | "local";

/**
 * One Console prompt image attachment referenced by a dispatch. `placeholder` is the
 * `[Image#N]` token in the prompt the cli rewrites to the materialized file path; `id` addresses the
 * uploaded blob (`FetchCommandImage`); `mime` picks the on-disk extension. Web/REST carry the same
 * shape (`@4pm/dto`).
 * @adr 0257
 */
export interface CommandImageRef {
  id: string;
  placeholder: string;
  name: string;
  mime: string;
}

/**
 * image.fetch request (cli → server) — ask for one prompt image blob. `commandId` scopes
 * the fetch to the in-flight dispatch (the server resolves the storing org from that command record,
 * which also covers rented machines whose link org differs from the renter's).
 * @adr 0257
 */
export interface ImageFetchRequest {
  commandId: string;
  imageId: string;
}

/**
 * image.fetch reply (server → cli) — the image bytes as base64 + its content type, or
 * `error` when the id is unknown / swept by retention / blocked. `dataBase64` is absent on error.
 * @adr 0257
 */
export interface ImageFetchReply {
  mime?: string;
  dataBase64?: string;
  error?: string;
}

/**
 * Per-run AI execution overrides carried on a dispatch — structurally mirrors `@4pm/dto`
 * `AiRunConfig` (kept local so `@4pm/ws` stays dep-free). Chosen in the web "AI settings" modal and
 * layered over the cli profile by the worker; every field optional (unset ⇒ the profile default).
 * @adr 0261
 */
export interface AiRunConfig {
  model?: string;
  thinking?: "off" | "low" | "medium" | "high";
  temperature?: number;
}

/** command.dispatch (server → cli). */
export interface CommandDispatchPayload {
  commandId: string;
  projectId?: string;
  path?: string;
  cmd: string;
  args: string[];
  env?: Record<string, string>;
  /**
   * Console prompt image attachments — only on a full agent AI run (`ai:true`,
   * `aiOneShot` unset). The cli fetches each blob (`FetchCommandImage`), materializes it inside the
   * served project folder, and rewrites its `[Image#N]` placeholder to the on-disk path before
   * spawning. Absent/empty ⇒ no images.
   * @adr 0257
   */
  images?: CommandImageRef[];
  /**
   * AI prompt mode: when true, `cmd` holds the **raw prompt** (not an
   * executable) and the cli runs it through the same AI-CLI profile-failover path as a
   * locally-typed prompt — instead of spawning `cmd` verbatim. `args` is ignored.
   * @adr 0057
   */
  ai?: boolean;
  /**
   * One-shot AI run: a text-in → text-out prompt (spec review/compose/suggest/
   * generators) the cli must run WITHOUT its agentic tool loop — `--max-turns 1` + disallowed
   * agentic tools — so it can't wander the repo / edit files / loop forever. Only meaningful
   * with `ai:true`; absent ⇒ a full agent run (Console tab, Git merge).
   * @adr 0249
   */
  aiOneShot?: boolean;
  /**
   * Read-only agent AI run: a task that must **read + inspect the repo but write
   * nothing** (project-template "Analyze impact"). The cli keeps the read/search tools (`Read`/
   * `Glob`/`Grep`/`Bash`) and runs multi-turn under `--permission-mode plan` (codex `--sandbox
   * read-only`) with only the write/orchestration tools disallowed. Only meaningful with `ai:true`;
   * **mutually exclusive with `aiOneShot`**; absent ⇒ one-shot (if set) or a full agent run.
   * @adr 0265
   */
  aiReadOnly?: boolean;
  /**
   * Write-capable agent AI run: a full agent that must run file + git/`gh`/`glab` writes
   * **headless without approval prompts** (project-template "Update" → branch + PR). The cli runs
   * claude under `--permission-mode bypassPermissions` (codex full-auto) so it never stalls on an
   * interactive approval. Still folder-scoped. Only meaningful with `ai:true`; **mutually
   * exclusive with `aiOneShot`/`aiReadOnly`**; absent ⇒ the normal full-agent permission behavior.
   * @adr 0271 @adr 0181
   */
  aiBypass?: boolean;
  /**
   * Per-run AI execution overrides: model/thinking/temperature chosen in the web
   * "AI settings" modal (per-user localStorage), layered over the cli profile default by the
   * worker (`buildRunArgs`). Only present on an `ai:true` dispatch; absent ⇒ the profile default.
   * @adr 0261
   */
  aiConfig?: AiRunConfig;
}

/**
 * command.announce (cli → server) — a command initiated locally in the cli TUI
 * so the server can create a tracking record + persist history before the
 * command.output chunks arrive. Server-dispatched commands do not need this (the
 * server already has a record).
 * @adr 0057
 */
export interface CommandAnnouncePayload {
  commandId: string;
  projectId?: string;
  cmd: string;
  args: string[];
  /**
   * The operator's raw prompt text (AI runs) so the web console echoes it like the cli TUI
   * (`❯ <prompt>`) rather than the CLI binary name. Optional — falls back to `cmd`.
   * @adr 0108
   */
  prompt?: string;
  /** Always "local" — server-dispatched commands are not announced. */
  origin: CommandOrigin;
}

/**
 * console.watch (server → cli): whether a web Console viewer is attached to this
 * link. `on:true` on the first viewer ⇒ the cli starts emitting `console.sync` + pushes a fresh
 * snapshot; `on:false` on the last viewer leaving ⇒ the cli stops. The `console.sync` payload
 * itself is the `ConsoleSyncEvent` shared response type in `@4pm/dto` (also an SSE contract).
 * @adr 0150
 */
export interface ConsoleWatchPayload {
  on: boolean;
}

/**
 * metrics.watch (server → cli): a renewable lease telling the cli a web viewer has the
 * Machines→Workers tab open. `on:true` (re-asserted ~every 15s while a viewer is present) ⇒ the cli
 * samples + emits `machine.metrics` (~every 5s); no renewal within the lease window ⇒ it stops. The
 * `machine.metrics` payload is the `MachineMetricsPayload` type in `@4pm/dto` (also used server-side).
 * @adr 0214
 */
export interface MetricsWatchPayload {
  on: boolean;
}

/** command.output (cli → server — batch, cli-ws 0003). */
export interface CommandOutputPayload {
  commandId: string;
  seq: number;
  chunk: string;
  truncated?: boolean;
  done?: boolean;
  exitCode?: number;
  /**
   * Set on a **synthesized** terminal `done` the server emits for a command that finished but
   * whose replay buffer was already evicted: the real output is gone, so a late SSE
   * subscriber must treat this as "reply unavailable" (surface a re-run notice) rather than
   * parsing the empty chunk as the actual reply.
   * @adr 0165
   */
  unavailable?: boolean;
  /**
   * Status/meta line (e.g. "→ trying claude profile … (1/3)"), not part of the command's
   * real output: streamed to the web console for visibility but excluded from the persisted
   * transcript, and rendered directly (bypassing the json/code result-collapse detector) so
   * it can't poison mode detection of the AI result that follows.
   * @adr 0108
   */
  log?: boolean;
  /**
   * Discard everything streamed for this command so far (ADR-0322 area): a profile-failover retry
   * starts a fresh attempt, so the RESULT stream + persisted transcript must drop the previous
   * (failed/partial) attempt and keep only the attempt that ultimately succeeds. Without it a
   * compose whose first profile times out mid-spec then succeeds on the next would concatenate two
   * partial specs into one buffer, which the client then fails to parse as JSON. Carries no chunk;
   * the live console view is unaffected (it has its own `console.sync` transcript).
   */
  reset?: boolean;
  /**
   * Run-slot queue status: `{position, limit, running}` while this AI run waits for an org
   * run slot (sent on each position change), `null` once the slot is granted. A status frame — never part
   * of the command's result; the server flips the command status `queued` ⇄ `running`.
   * @adr 0362
   */
  queue?: RunQueueInfo | null;
  /**
   * Set on the terminal `done` of a run stopped via `command.cancel` — exit code
   * {@link COMMAND_CANCELLED_EXIT_CODE}. The client applies nothing for a cancelled run.
   * @adr 0362
   */
  cancelled?: boolean;
}

/** Status of one worker tool on the machine (worker tools). @adr 0206 */
export interface ToolStatus {
  /** Catalog id or npm package name. */
  id: string;
  /** Human label (catalog entry's label; the package name for an extra global). */
  label: string;
  /** Category badge (`runtime`/`ai-cli`/`vcs`; `runtime` for an extra global). */
  category: "runtime" | "ai-cli" | "vcs";
  /** Whether the tool resolves on the worker's PATH. */
  installed: boolean;
  /** The detected `--version` output (first line), or null when not installed. */
  version: string | null;
  /** False for a detect-only prerequisite (no install/uninstall button). */
  installable: boolean;
  /** True when the tool offers update-to-latest (npm-distributed catalog tool or extra). @adr 0252 */
  updatable: boolean;
  /** True when this tool is flagged for per-tool auto-update in `config.json`. @adr 0253 */
  autoUpdate: boolean;
}

/** tools.list request/reply — probe the catalog + extra globals. @api machine-0050 @adr 0206 */
export interface ToolsListRequest {
  _?: never;
}
export interface ToolsListReply {
  /** One row per `WORKER_TOOL_CATALOG` entry. */
  catalog: ToolStatus[];
  /** Extra globally installed npm packages found on the worker (operator-added). */
  extras: ToolStatus[];
}

/**
 * tools.install / tools.uninstall / tools.update request (machine-0051/0052/0055) —
 * start a streamed op. The op is derived from the WS channel; this payload is shared by all three.
 * @adr 0206 @adr 0252
 */
export interface ToolsMutateRequest {
  /** Correlates the streamed `tools.progress`/`tools.done` frames back to this op. */
  opId: string;
  /** Catalog id or npm package name. */
  name: string;
  /** Package manager to run the global install/uninstall/update with. */
  manager: "npm" | "pnpm";
}
/** Immediate ack: whether the cli accepted the op (else `error`, e.g. bad name / prerequisite). */
export interface ToolsMutateReply {
  started: boolean;
  error?: string;
}

/** cli → server push: one stdout/stderr line of a running install/uninstall. @adr 0206 */
export interface ToolsProgressPayload {
  opId: string;
  line: string;
}
/** cli → server push: the terminal frame of an install/uninstall op. @adr 0206 */
export interface ToolsDonePayload {
  opId: string;
  /** True when the manager exited 0. */
  ok: boolean;
  exitCode: number;
  error?: string;
}

/**
 * tools.autoUpdate request/reply — toggle per-tool auto-update. The cli
 * merges/removes `name` in `config.json` `autoUpdateTools` and replies `ok`; the ADR-0074 idle daily
 * tick later runs `@latest` for each flagged tool.
 * @api machine-0056 @adr 0253
 */
export interface ToolsAutoUpdateRequest {
  /** Catalog id or npm package name. */
  name: string;
  /** true = flag for auto-update; false = clear the flag. */
  enabled: boolean;
}
export interface ToolsAutoUpdateReply {
  /** True when the flag was persisted; false with `error` when the name is a prerequisite / invalid. */
  ok: boolean;
  error?: string;
}

/**
 * tools.report payload (cli → server one-way) — the worker's detected tool snapshot,
 * persisted to `MachineLink.toolSnapshot`. Same shape as `ToolsListReply`; sent on the ADR-0074 daily
 * idle tick, after each install/uninstall/update op, and on boot AFTER restore-on-boot completes (the
 * load-bearing ordering: a post-recreate image baseline must never overwrite the snapshot pre-restore).
 * @adr 0254
 */
/** Why a tool stayed missing/mismatched after a restore reconcile — mirrors `@4pm/dto`. @adr 0258 */
export interface ToolRestoreFailureItem {
  name: string;
  version: string;
  reason: "timeout" | "network" | "not-found" | "engine" | "other";
  retryable: boolean;
}

export interface ToolsReportPayload {
  catalog: ToolStatus[];
  extras: ToolStatus[];
  /**
   * Tools that failed the last restore reconcile — transient, empty when the reported set
   * satisfies the manifest. Persisted to `toolSnapshot.restoreFailed`; drives the server re-drive.
   * @adr 0258
   */
  restoreFailed?: ToolRestoreFailureItem[];
  /**
   * What triggered this report: `op` after an install/uninstall/update, `boot` after
   * restore-on-boot, `daily` on the idle maintenance tick, `manual` after a machine-0058 restore. The
   * server re-drives a still-failing restore ONLY on `daily` (spaced, stateless). Absent ⇒ treat as `op`.
   * @adr 0258
   */
  trigger?: "op" | "boot" | "daily" | "manual";
}

/** One tool to reconcile to an exact version — mirrors `@4pm/dto` `ToolManifestEntry`. @adr 0254 */
export interface ToolManifestItem {
  name: string;
  version: string;
  manager: "npm" | "pnpm";
}

/**
 * tools.restore request/reply (server → cli) — push a manifest to reconcile NOW (a copy-apply
 * to an online target). The cli installs each missing/mismatched `name@version`, reports its new
 * snapshot, and replies whether it applied (so the server can clear the pending manifest).
 * @adr 0254
 */
export interface ToolsRestoreRequest {
  manifest: ToolManifestItem[];
  /**
   * What issued this restore: `boot` = the connect-hook self/pending push or the daily
   * re-drive; `manual` = a machine-0058 operator retry. The cli echoes it as the `trigger` of the
   * follow-up `tools.report` so that restore-completion report is never itself treated as `daily`
   * (which would loop the server re-drive). Absent ⇒ `boot`.
   * @adr 0258
   */
  trigger?: "boot" | "manual";
  /**
   * Present for a **manual** streamed restore: the cli acks immediately, then
   * streams `tools.progress`/`tools.done` frames keyed by this `opId` (relayed over the machine-0053
   * SSE, exactly like install/update). Absent ⇒ the connect-hook/copy/re-drive path, where the reply is
   * the terminal reconcile result (used to clear the pending copy pointer).
   * @api machine-0058 @adr 0258
   */
  opId?: string;
}
export interface ToolsRestoreReply {
  /** True when the reconcile ran (per-tool failures are non-fatal); false with `error` otherwise. */
  ok: boolean;
  error?: string;
}

/** config.read request/reply — the paired profile's config.json. @api machine-0025 @adr 0141 */
export interface ConfigReadRequest {
  /** No parameters — the cli reads its own paired profile's config.json. */
  _?: never;
}
export interface ConfigReadReply {
  /** The config.json file content as text (pretty-printed; empty-defaults when absent). */
  config: string;
}

/** config.write request/reply — replace the profile's config.json. @api machine-0026 @adr 0141 */
export interface ConfigWriteRequest {
  /** The new config.json content (raw text; validated + parsed on the cli). */
  config: string;
}
export interface ConfigWriteReply {
  /** True when written; false with `error` when the text is invalid JSON / bad shape. */
  ok: boolean;
  error?: string;
}

/** fs.list request/reply. @api machine-0007 */
export interface FsListRequest {
  path: string;
}
export interface FsListReply {
  path: string;
  entries: { name: string; type: "dir" | "file" }[];
}

/**
 * fs.write request/reply — write a file on the worker, clamped to
 * the physic-project root. The single Git-tab write not carried by a git command over
 * dispatch; used by manual merge-conflict resolution (`project.git_write`).
 * @api machine-0027 @adr 0151
 */
export interface FsWriteRequest {
  /** File path relative to the physic-project root; anything escaping the root is clamped. */
  path: string;
  /** Full new UTF-8 content (replaces the file wholesale). */
  content: string;
}
export interface FsWriteReply {
  /** True when written; false with `error` on a bad path / write failure. */
  ok: boolean;
  /** The resolved (clamped) path actually written. */
  path: string;
  /** Bytes written (0 when `ok` is false). */
  bytes: number;
  error?: string;
}

/** The fs-mutation operations. @api machine-0059 @adr 0260 */
export type FsMutateOp = "mkdir" | "create" | "move" | "delete";

/**
 * fs.mutate request/reply — create/rename/move/delete a file or folder in
 * the project tree, each op clamped to the physic-project root (`project.files_write`). `rename` is a
 * `move` within the same folder. Paths are relative to the root; anything escaping it is refused.
 * @api machine-0059 @adr 0260
 */
export interface FsMutateRequest {
  op: FsMutateOp;
  /** Target path for `mkdir` / `create` / `delete`. */
  path?: string;
  /** Optional seed content for `create` (empty file when absent). */
  content?: string;
  /** Source path for `move` (also used as the rename source). */
  from?: string;
  /** Destination path for `move` (the new path, or a folder to move into). */
  to?: string;
}
export interface FsMutateReply {
  /** True when applied; false with `error` on a bad path / name / fs failure. */
  ok: boolean;
  /** The resolved (clamped) path acted on. */
  path: string;
  error?: string;
}

/**
 * fs.upload request/reply — write an uploaded/pasted file's bytes into the
 * project tree, clamped to the physic-project root (`project.files_write`). The bytes ride as base64
 * (binary the text-only fs.write can't carry); a path escaping the root is refused outright.
 * @api machine-0061 @adr 0278
 */
export interface FsUploadRequest {
  /** Destination path relative to the physic-project root; anything escaping the root is refused. */
  path: string;
  /** File bytes, base64-encoded. */
  contentBase64: string;
  /** Optional MIME type from the browser (informational; not trusted for the write). */
  contentType?: string;
}
export interface FsUploadReply {
  /** True when written; false with `error` on a bad path / oversize / write failure. */
  ok: boolean;
  /** The resolved (clamped) path actually written. */
  path: string;
  /** Bytes written (0 when `ok` is false). */
  bytes: number;
  error?: string;
}

/**
 * fs.download request/reply — read a file's raw bytes for the browser to
 * save. `contentBase64` carries the bytes; a file over the transfer cap (or unreadable) replies with
 * `error` and no payload (never a silent truncation, unlike fs.read).
 * @api machine-0062 @adr 0278
 */
export interface FsDownloadRequest {
  /** File path relative to the physic-project root; anything escaping the root is refused. */
  path: string;
}
export interface FsDownloadReply {
  /** File bytes, base64-encoded (absent on error). */
  contentBase64?: string;
  /** Best-effort MIME type guessed from the extension. */
  contentType?: string;
  /** The file's basename (for the browser's save dialog). */
  name?: string;
  /** Raw byte size. */
  size?: number;
  /** Set when the file is unreadable / over the transfer cap / path escapes the root. */
  error?: string;
}

/**
 * Autonomous mode — the dashboard controls the worker's headless autonomous engine
 * (`.claude/.autonomous.settings.json` + `auto-cycle`), reached over these channels via the cli.
 * @adr 0152
 */

/** Computed run-state of the autonomous engine on the worker (from settings + histories). */
export interface AutonomousStatus {
  /**
   * The tick scheduler is armed for the served project. Always `true` from a cli with the in-process
   * scheduler; `false` only from an older cli whose OS crontab line is absent. Kept for wire
   * compat — "armed" is `installed &&!paused`.
   * @adr 0392 @adr 0317
   */
  installed: boolean;
  /** `paused:true` in settings — the engine's on/off switch. */
  paused: boolean;
  /** Effective cron schedule from settings. */
  cronSchedule: string;
  /** ISO time of the last recorded tick, or null. */
  lastTickAt: string | null;
  /** Last tick outcome: `success` | `failure` | `skip`, or null. */
  lastResult: string | null;
  /** Consecutive failure count (auto-pauses at the settings threshold). */
  consecutiveFails: number;
  /** Ticks that actually invoked Claude today (local day). */
  todayTicks: number;
  /**
   * The last tick stopped because the base branch is protected — `"<branch> (<repo>)"`, else null.
   * @adr 0371
   */
  baseProtected?: string | null;
}

/** Raw text of the 5 autonomous "books" (the web parses them). */
export interface AutonomousBooks {
  userTodo: string;
  aiTodo: string;
  aiProgress: string;
  aiDone: string;
  userQa: string;
}

/** autonomous.read reply — the whole autonomous surface in one read. */
export interface AutonomousReadRequest {
  _?: never;
}
export interface AutonomousReadReply {
  /** `.autonomous.settings.json` text (empty-defaults when absent). */
  settings: string;
  status: AutonomousStatus;
  books: AutonomousBooks;
  /** `.autonomous.approvals.json` text (`{}` when absent) — who/when approved, per row id. */
  approvals: string;
  /** `.autonomous.authors.json` text (`{}` when absent) — who/when wrote each row. @adr 0320 */
  authors: string;
  /** `.autonomous.attempts.json` text (`{}` when absent) — per-task attempts / split-pending. @adr 0371 */
  attempts?: string;
  /** Intake UI mockups — repo paths of the `.html` files under `mockupDir` on `<base>`. @adr 0418 */
  mockups?: string[];
}

/** autonomous.logs — tail one day's tick log. */
export interface AutonomousLogsRequest {
  /** `YYYY-MM-DD`; absent ⇒ today. */
  date?: string;
}
export interface AutonomousLogsReply {
  date: string;
  lines: string[];
}

/** autonomous.write — a discriminated write to the engine. @adr 0152 */
// Identity carried on every identity-writing autonomous write (ADR-0320): `by` is the **stable userId**
// (the separation-of-duties match key, immune to an email change) and `byLabel` is the human-readable
// display (email, else username). Both are server-filled — never the client body.
export type AutonomousWriteRequest =
  | { kind: "settings"; settings: string }
  // Approvals also carry `byIsAdmin` (server-filled from the approver's role) so the cli can enforce
  // separation of duties — a non-ADMIN can't approve a row they wrote (ADR-0320).
  | { kind: "approvals"; taskId: string; approved: boolean; by: string; byLabel?: string; byIsAdmin?: boolean }
  // Batched approvals (ADR-0311): commit many approve/unapprove ids in one approvals-file write.
  | { kind: "approvalsBatch"; approve: string[]; unapprove: string[]; by: string; byLabel?: string; byIsAdmin?: boolean }
  | { kind: "userTodo"; content: string; by: string; byLabel?: string }
  // Traced book save (ADR-0320): the cli diffs rows by id against the current book and stamps
  // `.autonomous.authors.json` (author = `by`/`byLabel`) for added/edited rows, so authorship can't be
  // forged in a client-written `.md` cell. `book` selects the book saved; `aiDone` (AI Verify verdicts on the
  // read-only AI Done — ADR-0400) is written without an authorship stamp.
  // `evidence` (ADR-0404): staged files moved into `.4pm/evidence/<BOOK>/…` and committed with the book.
  | {
      kind: "bookSave";
      book: "userTodo" | "userQa" | "aiTodo" | "aiDone";
      content: string;
      by: string;
      byLabel?: string;
      evidence?: { stageId: string; path: string }[];
    }
  // Stage one evidence file in the profile dir until a `bookSave` commits it (ADR-0404). Server-built
  // from the multipart upload (machine-0072).
  | { kind: "evidenceStage"; name: string; contentBase64: string; by: string; byLabel?: string };
// (The `cron` install/uninstall kind was retired by ADR-0392 — the daemon schedules ticks itself.)
export interface AutonomousWriteReply {
  ok: boolean;
  error?: string;
  /** A machine-readable failure code — e.g. `APPROVAL_SELF` when SoD blocked a self-approval. @adr 0320 */
  code?: string;
  /** The row id that failed (e.g. the self-approved id), for the UI to point at. @adr 0320 */
  failedId?: string;
  /** The refreshed status after the write (so the web updates the badge without a re-read). */
  status?: AutonomousStatus;
  /** Rows a `userTodo` / `bookSave` added (by id diff) — counted toward the monthly book cap. @adr 0365 */
  added?: number;
  /** The staged file's handle (`evidenceStage`). @adr 0404 */
  stageId?: string;
}

/** autonomous.evidence — read one committed book evidence file. @api machine-0073 @adr 0404 */
export interface AutonomousEvidenceRequest {
  /** `.4pm/evidence/<BOOK>/<ROW-ID>/<file>` — anything else is refused. */
  path: string;
  /** A task branch to fall back to when the file is not on `<base>` yet. */
  ref?: string;
}
/** Same shape as `FsDownloadReply`: base64 bytes, or `error`. */
export type AutonomousEvidenceReply = FsDownloadReply;

/**
 * Subagents & skills management — the dashboard manages subagent files under
 * `.claude/agents/` and skill folders under `.claude/skills/` on the worker via the cli.
 * @adr 0153
 */

/** One subagent/skill summary (name + parsed frontmatter description). */
export interface AgentSummary {
  name: string;
  description: string;
}

/** agents.list — all subagents + skills of the physic project. */
export interface AgentsListRequest {
  _?: never;
}
export interface AgentsListReply {
  subagents: AgentSummary[];
  skills: AgentSummary[];
}

/** agents.read — one subagent/skill's content (+ a subagent's short/long memory). */
export interface AgentReadRequest {
  kind: "subagent" | "skill";
  name: string;
}
export interface AgentReadReply {
  content: string;
  /** Present only for a subagent: its short/long memory text (empty when absent). */
  memory?: { short: string; long: string };
}

/** agents.write — create/edit or delete a subagent/skill. */
export interface AgentWriteRequest {
  kind: "subagent" | "skill";
  name: string;
  action: "write" | "delete";
  /** File content (required for `write`). */
  content?: string;
}
export interface AgentWriteReply {
  ok: boolean;
  error?: string;
}

/**
 * Security & placeholder management — the dashboard manages the security docs and sets
 * placeholder secrets on the worker. Secret VALUES are write-only: they are never returned.
 * @adr 0154
 */

/** One placeholder/secret key with whether a value is set (never the value itself). */
export interface SecretKeyStatus {
  name: string;
  set: boolean;
}

/** secrets.read — the security docs + placeholder keys (no values). */
export interface SecretsReadRequest {
  _?: never;
}
export interface SecretsReadReply {
  /** AI_SECURITY.md text. */
  security: string;
  /** AI_PLACEHOLDER.md text. */
  placeholder: string;
  /** Union of placeholder keys + secret keys, each with a set/unset flag (no values). */
  keys: SecretKeyStatus[];
}

/** secrets.write — a discriminated write (docs or a write-only secret value). */
export type SecretsWriteRequest =
  | { kind: "security"; content: string }
  | { kind: "placeholder"; content: string }
  | { kind: "secret"; key: string; value: string }
  | { kind: "secretDelete"; key: string };
export interface SecretsWriteReply {
  ok: boolean;
  error?: string;
}

/**
 * Agent tool-permission editor — the dashboard edits the Claude `permissions` block of
 * `.claude/settings.json` (shared, committed) or `.claude/settings.local.json` (per-cli local). The
 * cli is the single writer: it splices only the `permissions` block back, preserving all other
 * settings fields and re-injecting the ADR-0154 secrets `deny` on a shared write.
 * @adr 0183
 */

/** Which settings file the policy applies to. */
export type AgentToolsScope = "shared" | "local";

/**
 * Claude Code permission mode for `permissions.defaultMode`. Headless-only: 4PM always
 * emits `bypassPermissions`; the other members stay for tolerance when reading a hand-edited file.
 * @adr 0328
 */
export type AgentToolsMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";

/** The `permissions` block of a Claude settings file. Headless-only: no `ask` list. @adr 0328 */
export interface AgentToolsPermissions {
  defaultMode: AgentToolsMode;
  allow: string[];
  deny: string[];
}

/** agentTools.read — the permissions block for one scope. */
export interface AgentToolsReadRequest {
  scope: AgentToolsScope;
}
export interface AgentToolsReadReply {
  permissions: AgentToolsPermissions;
}

/** agentTools.write — replace the permissions block for one scope. */
export interface AgentToolsWriteRequest {
  scope: AgentToolsScope;
  permissions: AgentToolsPermissions;
}
export interface AgentToolsWriteReply {
  ok: boolean;
  error?: string;
}

/**
 * One MCP server definition as it travels server ⇄ cli — a `.mcp.json` entry, mirroring
 * `@4pm/dto` `McpServerDefinition` without coupling protocol → dto (validated on each side).
 * @adr 0427
 */
export type McpServerDefinitionWire = Record<string, unknown>;

/** An approved MCP server pushed to the cli (`ws_token.mcpServers` / `project.tokens.mcpServers`). */
export interface McpServerPush {
  name: string;
  definition: McpServerDefinitionWire;
}

/** mcp.scan — parse `.mcp.json` at the served root + each declared repo folder. @adr 0427 */
export type McpScanRequest = Record<string, never>;
export interface McpScanReply {
  files: { path: string; servers: { name: string; definition: McpServerDefinitionWire; hash: string }[]; error?: string }[];
  error?: string;
}

/**
 * Skill/subagent marketplace — the cli packs a `.claude` artifact into a file set
 * (server zips + stores it), installs a downloaded package version into `.claude/agents|skills`
 * (recording `.4pm-packages.json` with a sha256 for drift), lists what is installed (with the
 * on-disk sha256 recomputed), and removes an installed package. The server owns the registry;
 * the cli is the single `.claude`-writer (path-clamped like ADR-0153).
 * @adr 0185
 */

/** One package payload file: path relative to the artifact root + base64 bytes. */
export interface PackagePayloadFile {
  path: string;
  contentBase64: string;
}

/** packages.pack — zip a project subagent/skill for publishing. */
export interface PackagesPackRequest {
  kind: "subagent" | "skill";
  /** The on-disk artifact name (subagent `<name>.md` / skill dir `<name>`). */
  name: string;
}
export interface PackagesPackReply {
  ok: boolean;
  /** The artifact's files (agent.md + memory, or SKILL.md + helpers), root-relative. */
  files: PackagePayloadFile[];
  error?: string;
}

/** packages.install — write a downloaded package version into `.claude/agents|skills`. */
export interface PackagesInstallRequest {
  kind: "subagent" | "skill";
  slug: string;
  version: string;
  packageId: string;
  files: PackagePayloadFile[];
}
export interface PackagesInstallReply {
  ok: boolean;
  /** sha256 of the artifact as written (recorded in `.4pm-packages.json`). */
  sha256?: string;
  error?: string;
}

/** One installed package as read from `.4pm-packages.json` + the recomputed on-disk sha256. */
export interface InstalledPackageState {
  slug: string;
  kind: "subagent" | "skill";
  version: string;
  packageId: string;
  installedAt: string;
  /** sha256 recorded at install time. */
  sha256: string;
  /** sha256 recomputed now over the on-disk artifact (differs ⇒ local edit / drift). */
  currentSha256: string;
}

/** packages.list — the installed-package manifest with on-disk hashes for the drift guard. */
export interface PackagesListRequest {
  _?: never;
}
export interface PackagesListReply {
  installed: InstalledPackageState[];
}

/** packages.remove — delete an installed package artifact + its manifest entry. */
export interface PackagesRemoveRequest {
  slug: string;
}
export interface PackagesRemoveReply {
  ok: boolean;
  error?: string;
}

/**
 * Docs & code dependency graph — the cli builds a graph of the physic project (docs or
 * code) that the web renders in WebGL. Deterministic + bounded; orphans are unlinked nodes.
 * @adr 0155
 */

/** One graph node — a document (docs mode) or a function (code mode). */
export interface GraphNode {
  /** Stable id: a doc relpath, or `file#function` for code. */
  id: string;
  label: string;
  /** `doc` | `fn`. */
  kind: string;
  /** The source file (relpath). */
  file: string;
}

/** One directed edge (from → to references / links). */
export interface GraphEdge {
  from: string;
  to: string;
}

/** graph.build — build the graph for one mode. */
export interface GraphBuildRequest {
  mode: "docs" | "code";
}
export interface GraphBuildReply {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Node ids with no links (unlinked) — the analysis surface. */
  orphans: string[];
}

/**
 * RAG capability + install — the dashboard checks whether a worker can run RAG and
 * installs a worker-tuned embedding model through the cli. Install runs in the background; the web
 * polls the status.
 * @adr 0156
 */

/** One install option (embedding model) tuned to the worker's specs. */
export interface RagOption {
  id: string;
  label: string;
  model: string;
  sizeMB: number;
  recommended: boolean;
  note?: string;
}

/** The worker's relevant hardware (best-effort). */
export interface RagMachine {
  ramGB: number;
  cpus: number;
  diskFreeGB: number;
  gpu: boolean;
}

/** rag.status — probe the worker's RAG capability + install state. */
export interface RagStatusRequest {
  _?: never;
}
export interface RagStatusReply {
  installed: boolean;
  installing: boolean;
  python: { found: boolean; version: string };
  deps: { pip: boolean; fastembed: boolean; sqliteVec: boolean };
  model: { present: boolean; name: string };
  machine: RagMachine;
  options: RagOption[];
  /** Tail of the background install log (progress while installing). */
  installLog: string[];
  /** The vector index state. @adr 0157 */
  index: RagIndex;
}

/** rag.install — start a background install of the chosen model. */
export interface RagInstallRequest {
  model: string;
}
export interface RagInstallReply {
  ok: boolean;
  started: boolean;
  error?: string;
}

/** The vector-index state. @adr 0157 */
export interface RagIndex {
  present: boolean;
  indexing: boolean;
  chunks: number;
  indexedAt: string;
}

/** rag.reindex — (re)build the docs vector index in the background. */
export interface RagReindexRequest {
  _?: never;
}
export interface RagReindexReply {
  ok: boolean;
  started: boolean;
  error?: string;
}

/** One semantic-search hit. */
export interface RagQueryResult {
  path: string;
  snippet: string;
  score: number;
}

/** rag.query — semantic search over the index. */
export interface RagQueryRequest {
  query: string;
  k?: number;
}
export interface RagQueryReply {
  results: RagQueryResult[];
  error?: string;
}

/** git.diff request/reply — old (HEAD) vs current content of a file (Monaco diff). */
export interface GitDiffRequest {
  path: string;
}
export interface GitDiffReply {
  path: string;
  /** File content at HEAD (empty if untracked/new). Text files only; empty when `isBinary`. */
  oldContent: string;
  /** Current working-tree content. Text files only; empty when `isBinary`. */
  newContent: string;
  /**
   * True when the file is binary (e.g. an image): the text fields are empty and the bytes ride in
   * the `*Base64` fields instead so the dashboard can render an image before/after.
   * @adr 0282
   */
  isBinary?: boolean;
  /** Best-effort MIME type (binary only), for the `data:` URL the dashboard builds. */
  contentType?: string;
  /** HEAD bytes, base64 (binary only; empty for an untracked/new or over-cap file). */
  oldContentBase64?: string;
  /** Working-tree bytes, base64 (binary only; empty for a deleted/unreadable or over-cap file). */
  newContentBase64?: string;
}

/**
 * git history browse (read-through cli). Every request carries a `repo`
 * subdir (relative to the physic project root; "" = the root repo); the cli resolves it
 * inside its serving folder and blocks path traversal.
 * @adr 0089
 */
export interface GitReposRequest {
  /** Reserved for future filters; the cli auto-discovers repos under the physic root. */
  repo?: string;
}
export interface GitRepoRef {
  /** Relative subdir under the physic project root ("" = root/primary repo). */
  subdir: string;
  /** Display label (basename of subdir; "" ⇒ the project name). */
  name: string;
  /** `origin` remote URL, when set. */
  remote: string | null;
  /** Current checked-out branch (`git rev-parse --abbrev-ref HEAD`), when resolvable — null otherwise. */
  branch?: string | null;
}
export interface GitReposReply {
  repos: GitRepoRef[];
}

export interface GitLogRequest {
  repo: string;
  skip: number;
  limit: number;
}
export interface GitLogEntry {
  hash: string;
  shortHash: string;
  author: string;
  /** ISO date. */
  date: string;
  subject: string;
}
export interface GitLogReply {
  entries: GitLogEntry[];
  /** More (older) commits exist beyond this page. */
  hasMore: boolean;
}

export interface GitCommitRequest {
  repo: string;
  hash: string;
}
export interface GitCommitFile {
  path: string;
  /** git status letter (A|M|D|R…). */
  status: string;
  /** Original path when renamed. */
  oldPath?: string;
}
export interface GitCommitReply {
  hash: string;
  author: string;
  date: string;
  subject: string;
  files: GitCommitFile[];
}

/** git.commit-diff request — parent↔commit content of one file (reuses GitDiffReply). */
export interface GitCommitDiffRequest {
  repo: string;
  hash: string;
  path: string;
}

/** fs.read request/reply — read a text file on the worker (project dashboard). */
export interface FsReadRequest {
  path: string;
}
export interface FsReadReply {
  path: string;
  /** UTF-8 file content (empty when unreadable). */
  content: string;
  /** Content was capped at the size limit. */
  truncated: boolean;
}

/** quota.check request/reply (cli → server, before spawning an AI cli —
 *  ADR-0020). */
export interface QuotaCheckRequest {
  /** Requested metric (ai_tokens | commands | autonomous_minutes). */
  metric: string;
  /** Expected amount to use (defaults to 1). */
  amount?: number;
}
export interface QuotaCheckReply {
  allowed: boolean;
  /** Smallest remaining limit across the blocking dimensions (null = unlimited). */
  remaining: number | null;
  /** Reason when blocked (which dimension exceeded). */
  blockedBy?: string;
}

/** usage.report (cli → server — batch). @adr 0020 */
export interface UsageReportPayload {
  events: {
    metric: string;
    amount: number;
    /** ISO timestamp when it occurred. */
    occurredAt: string;
    /** The AI-CLI profile (account email / dir) this usage ran under — for the
     *  per-profile breakdown. Absent for non-AI events.
     * @adr 0072
     */
    profile?: string;
    /** Claude auth mode this run used: `subscription` (OAuth) vs `api-key`
     *  (ANTHROPIC_API_KEY, API-billed). Present on ai_tokens events so billing can split them.
     * @adr 0192 §5
     */
    authMode?: "subscription" | "api-key";
    /** The AI provider that produced an `ai_tokens` event — picks the server's
     *  quota-token weights. Absent (an older cli) ⇒ weighted as `claude`.
     * @adr 0340
     */
    provider?: "claude" | "codex" | "antigravity";
    /** The `ai_tokens` split: input + output + cache-read + cache-creation — four
     * DISJOINT components (codex's cached input is not repeated in `inputTokens`)
     *  summing to `amount` (the raw total). Present only for `ai_tokens` events.
     * @adr 0145 @adr 0340
     */
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
  }[];
}

/** One usage window (Claude subscription) — utilization % + reset time. */
export interface MachineUsageWindow {
  utilizationPct: number;
  resetsAt: string | null;
}

/**
 * machine.usage (cli → server). Claude subscription usage snapshot from the
 * Anthropic OAuth usage API. Carries only utilization/reset/plan — **never** the OAuth token.
 * @adr 0072
 */
export interface MachineUsagePayload {
  /** Subscription plan (e.g. "pro", "max") from the OAuth credentials. */
  plan: string;
  /** The AI CLI in use (claude | codex). */
  aiCli?: string;
  /** The active profile label: the signed-in account email (`oauthAccount.emailAddress`),
   *  falling back to the config-dir basename (e.g. ".claude-1"). */
  profile?: string;
  /** 5-hour rolling window (`five_hour`). */
  session: MachineUsageWindow;
  /** 7-day window (`seven_day`). */
  weekly: MachineUsageWindow;
  /** Extra on-demand credits used, when enabled. */
  extra?: { usedCredits: number; currency: string };
  /** ISO timestamp of this check. */
  checkedAt: string;
  /** Worker network probe — mirrors `@4pm/dto` `WorkerNetworkProbe`; observe-only, the web
   *  warns when the network is left open. Omitted by old clients. Persisted inside `usageSnapshot`.
   * @adr 0221
   */
  network?: {
    outbound: "open" | "restricted";
    inbound: "exposed" | "isolated";
    containerized: boolean;
    checkedAt: string;
  };
}

/**
 * tool.health report (cli → server): the last-run result of one external tool the
 * cli invokes directly (claude/codex/gh/glab/git). Sent immediately after each run (last-wins
 * per tool); the server merges it into `MachineLink.usageSnapshot.toolHealth`. Carries only a
 * short human reason on failure — never stdout/secrets.
 * @adr 0223
 */
export interface ToolHealthReport {
  /** Normalized tool binary name (`claude｜codex｜gh｜glab｜git｜…`). */
  tool: string;
  /** Did the last run succeed? */
  ok: boolean;
  /** Short human reason when `ok` is false (e.g. "Not logged in"); null on success. */
  message: string | null;
  /** ISO timestamp of the run. */
  at: string;
}

/**
 * cli.update-result report (cli → server): the outcome of a cli self-update attempt
 * (idle-aware update + re-exec). A SUCCESS re-execs the process, so it is signalled by the worker
 * reconnecting on the new version — this report carries a FAILURE (`ok:false`) so the server can
 * persist the reason on `MachineLink.usageSnapshot.cliUpdate` and the web "Update" modal shows it
 * instead of spinning forever. Carries only a short human reason — never stdout/secrets.
 * @adr 0305
 */
export interface CliUpdateResultReport {
  /** Did the self-update succeed? Practically always false on the wire (success re-execs). */
  ok: boolean;
  /** Short human reason when `ok` is false (e.g. the tar/download error); null on success. */
  message: string | null;
  /** Version the cli was running when it attempted the update. */
  fromVersion: string;
  /** Version it tried to update to (the resolved latest); null when unknown. */
  toVersion: string | null;
  /** ISO timestamp of the attempt. */
  at: string;
}

/** log.read request/reply (server → cli): tail the cli's own JSONL logs. @adr 0072 */
export interface LogReadRequest {
  /** Max lines from the newest log file (default 200). */
  limit?: number;
}
export interface LogReadReply {
  /** Raw JSONL lines (newest file, tail), oldest-first. */
  lines: string[];
}

/** command.output-read request/reply (server → cli): read a command's captured output. @adr 0115 */
export interface CommandOutputRequest {
  commandId: string;
}
export interface CommandOutputReply {
  /** Full captured output, or null when pruned / never captured on this cli. */
  output: string | null;
}

/**
 * machine.log (cli → server): a periodic upload of the cli's own JSONL log file so
 * it is stored + retained server-side and counted in the machine user's storage footprint.
 * Sends one (usually the current day's) file plus the authoritative total of all the cli's log
 * files on the worker, so the server can set the footprint exactly + delta the org counter.
 * @adr 0122
 */
export interface MachineLogPayload {
  /** Log file name, e.g. `cli-2026-07-21.jsonl`. */
  fileName: string;
  /** Full content of that log file (UTF-8). */
  content: string;
  /** Total bytes of ALL the cli's `logs/` files on the worker right now. */
  totalBytes: number;
}

/**
 * rental.flush request/reply (server → cli): before a rented machine in `releasing`
 * is scrubbed, ask the worker to flush the data the renter keeps (upload its pending log tail; any
 * per-command history was already pushed on finish). The `ok` ack lets the release sweep finalise
 * at once instead of waiting the full timeout. Request carries no fields.
 * @adr 0210
 */
export interface RentalFlushRequest {
  /** Reserved for future selective flush; empty for now. */
  reason?: "release";
}
export interface RentalFlushReply {
  /** True once the worker has flushed its pending data and is safe to scrub. */
  ok: boolean;
}

/** command.history (cli → server): one finished command's rich record. @adr 0072 */
export interface CommandHistoryPayload {
  commandId: string;
  cmd: string;
  args: string[];
  status: string;
  exitCode?: number | null;
  tokens?: number;
  /** The run's `ai_tokens` split — total is `tokens`. Absent when not an AI run. @adr 0145 */
  tokensBreakdown?: { input: number; output: number; cacheRead: number; cacheCreation: number };
  projectId?: string | null;
  startedAt: string;
  finishedAt?: string | null;
}

/** git.env request/reply. @api machine-0008 */
export interface GitEnvRequest {
  provider: string;
}
export interface GitEnvReply {
  installed: boolean;
  authenticated: boolean;
  account: string | null;
  claudeCli: boolean;
}

/**
 * git.ssh-key request/reply — manage the rented worker's ssh deploy key. The
 * keypair is generated **on the worker** (`generate`); only the public key + fingerprint
 * are ever returned. `get` reads the current public key; `delete` removes the keypair.
 * @adr 0173
 */
export interface GitSshKeyRequest {
  op: "generate" | "get" | "delete";
}
export interface GitSshKeyReply {
  /** OpenSSH public key present on the worker, or null when none exists. */
  publicKey: string | null;
  /** SHA256 fingerprint of the key, when present. */
  fingerprint: string | null;
}

/** project.create request — scaffold from the sample template. @api project-0010 */
export interface ProjectCreatePayload {
  projectId: string;
  /**
   * Project name = the physic folder name; the cli scaffolds into
   * `<profileDir>/<projectName>` (folder = name). No user-chosen path.
   * @adr 0064 @adr 0080
   */
  projectName: string;
  /** The PMSpec collected by the wizard (stored as jsonb server-side). */
  spec?: Record<string, unknown>;
  /**
   * The project's git-auth method at dispatch time — mirrors `ws_token.gitAuth` (`null` =
   * self-managed). The cli re-applies it before the scaffold's publish step when it differs from the
   * git-auth it currently runs with (e.g. the App was set up after the cli connected).
   * @adr 0368
   */
  gitAuth?: string | null;
  /** The GitHub App credential host for `gitAuth = github-app` (mirrors `ws_token.gitAuthHost`). */
  gitAuthHost?: string | null;
}

/**
 * The scaffold's commit → push → pull-request outcome (ADR-0331, recorded by ADR-0368). Every step is
 * best-effort; `step` + `error` name the first one that failed (`null` = fully published).
 */
export interface ScaffoldPublishResult {
  /** A scaffold commit exists (made now, or already present). */
  committed: boolean;
  /** The branch reached the remote. */
  pushed: boolean;
  /** The published branch (null when HEAD's branch is unknown). */
  branch: string | null;
  /** The opened (or already open) pull/merge request URL. */
  prUrl: string | null;
  /** The first step that failed, or null (`submodule` = a declared submodule could not be attached). */
  step: "submodule" | "commit" | "push" | "pr" | null;
  /** The failure reason (English, from git/gh/glab), or null. */
  error: string | null;
  /** Per-submodule attach outcome; absent from an older cli. @adr 0370 */
  submodules?: { dir: string; ok: boolean; error: string | null }[];
}

/**
 * repo.probe request — server → cli (reply): inspect a repo branch before creating.
 * @api project-0076 @adr 0370
 */
export interface RepoProbeRequest {
  url: string;
  branch: string;
  base?: { kind: "default" | "branch" | "empty"; branch?: string };
  /** Declared submodules to probe too. @adr 0371 */
  submodules?: { subdir: string; url: string; branch: string }[];
}

/** repo.probe reply — branch existence, remote branches and what the source ref already holds. */
export interface RepoProbeReply {
  branchExists: boolean;
  defaultBranch: string | null;
  branches: string[];
  source: {
    ref: string;
    hasScaffold: boolean;
    templateVersion: string | null;
    keep: string[];
    overwrite: string[];
    tracking: string[];
    /** The parsed `project.spec.json` at `ref`; null when absent or unreadable. @adr 0393 */
    spec?: Record<string, unknown> | null;
    /** `project.spec.json` exists but could not be read (bad JSON / too large) — ADR-0393. */
    specError?: string | null;
    /** `model` of `.claude/settings.json` at `ref`; null when absent. @adr 0394 */
    settingsModel?: string | null;
  } | null;
  /** Base branch protected on the host; null = unknown / missing. @adr 0371 */
  protected: boolean | null;
  submodules: { subdir: string; url: string; branch: string; exists: boolean; protected: boolean | null; error: string | null }[];
  error: string | null;
}

/** ai.models request — server → cli (reply): list the models the worker's AI CLI supports. @adr 0394 */
export interface AiModelsRequest {
  provider: "claude" | "codex" | "antigravity";
}

/** ai.models reply — the CLI's own model list (empty + `error` when it couldn't be read). */
export interface AiModelsReply {
  provider: "claude" | "codex" | "antigravity";
  models: { value: string; resolvedModel: string | null; displayName: string; description: string }[];
  /** The provider's CLI is not on the worker. Absent from an older cli. @adr 0396 */
  cliMissing?: boolean;
  /** The cli is installing the missing CLI in the background — ask again shortly. @adr 0396 */
  installing?: boolean;
  error: string | null;
}

/** project.publish request — server → cli (reply): retry the scaffold publish. @api project-0074 @adr 0368 */
export interface ProjectPublishRequest {
  projectId: string;
}

/** project.publish reply — the new publish outcome (or an error when the folder is missing). */
export interface ProjectPublishReply {
  publish: ScaffoldPublishResult | null;
  error?: string;
}

/** physic.sync — server → cli: rename/recreate the physic folder on project rename
 * (folder = project name).
 * @adr 0064
 */
export interface PhysicSyncPayload {
  /** Previous folder name to remove (null = only create the new one). */
  oldName: string | null;
  /** New folder name (= new project name) to create. */
  newName: string;
}

/** physic.delete — server → cli: the project was deleted ⇒ delete the physic folder
 * `<profile>/<name>`; the cli keeps its pairing and goes idle.
 * @adr 0068
 */
export interface PhysicDeletePayload {
  /** Physic folder name (= project name) to delete. */
  name: string;
}

/**
 * project.tokens — server → cli: a project's token settings were **saved**, so push the
 * fresh knobs to every connected serving cli. `ws_token` still **seeds** these on (re)connect; this
 * channel only carries **updates** so a change (e.g. `aiRunTimeoutSec`) applies on the next run
 * instead of only after a reconnect. The cli applies them through the **same** `writeProfileConfig`
 * knob-write it runs from `ws_token.projectTokens` (mirror the fields ADR-0081/0243/0244/0245 deliver).
 * @adr 0256
 */
export interface ProjectTokensPayload {
  /** Project AI-run wall-clock override (seconds); `0` = inherit the machine-user default. @adr 0243 */
  aiRunTimeoutSec: number;
  /** Project idle auto-clear override (minutes); `0` = inherit the machine-user default. @adr 0244 */
  autoClearIdleMinutes: number;
  /** Rotate the Claude profile at/over this 5h-session utilization %; `0` = off. @adr 0081 */
  sessionSwitchPct: number;
  /** Reject a prompt whose estimated tokens exceed this; `0` = off. @adr 0081 */
  perPromptTokenLimit: number;
  /** Shared-AI-memory override: `inherit` ⇒ use the machine-user config. @adr 0245 */
  memory?: { mode: "inherit" | "on" | "off"; budgetChars: number };
  /** Folder-scope hardening (project aiScope) — prepend a guard to every AI prompt (ADR-0082/aiScope). */
  restrictToFolder?: boolean;
  /**
   * Git-auth method — mirrors `ws_token.gitAuth` (`null` = self-managed / nothing special).
   * `undefined` (an older server) ⇒ the cli leaves its git-auth untouched.
   * @adr 0368
   */
  gitAuth?: string | null;
  /** GitHub App credential host (mirrors `ws_token.gitAuthHost`); null when not on the App. */
  gitAuthHost?: string | null;
  /**
   * Approved MCP servers — mirrors `ws_token.mcpServers`. `undefined` (an older server) ⇒
   * the cli keeps its current list.
   * @adr 0427
   */
  mcpServers?: McpServerPush[];
}

/**
 * One declared repo of a project.add request — mirrors `@4pm/dto` `RepoSpec`
 * without coupling protocol → dto. `op:"existing"` clones `url`; `op:"create"` inits a
 * fresh repo. The `primary` repo lands at the target root, sub-repos in `subdir`.
 * @adr 0073
 */
export interface ProjectAddRepo {
  role?: string;
  primary?: boolean;
  op?: "create" | "existing";
  provider?: "gh" | "glab";
  name?: string;
  visibility?: "private" | "public";
  /** Existing repo url to clone/link (op=existing). */
  url?: string;
  /** Sub-repo subfolder under the target root. */
  subdir?: string;
  /** Primary branch to clone / check out; empty/undefined ⇒ the repo's default branch. @adr 0292 */
  branch?: string;
  defaultBranch?: string;
  gitignore?: string;
  commitConvention?: string;
}

/**
 * project.add request — register an existing project by cloning/linking its repos.
 * No user-chosen path: the cli derives
 * `<profileDir>/<projectName>` and returns it; no scaffold/AI-init.
 * @api project-0011 @adr 0117 @adr 0080
 */
export interface ProjectAddPayload {
  projectId: string;
  /** Project name = the physic folder name (folder = name). @adr 0064 */
  projectName: string;
  /** Multi-repo declaration: ≥1 repo, exactly one primary. @adr 0073 */
  repos: ProjectAddRepo[];
  /**
   * On-demand repo (re)provisioning mode — used by the "update repos" action. `sync`
   * (default, and the clone-on-connect / retry behaviour): clone a missing repo, else fetch +
   * check out the configured branch + fast-forward pull an existing one. `force`: delete each
   * repo folder and re-clone it fresh (destructive).
   * @adr 0292
   */
  mode?: "sync" | "force";
  /**
   * Subdirs to **scaffold** after cloning — the add-one-repo-from-Git-subtab flow:
   * for each listed sibling folder the cli applies the `project-sample` template + writes the spec +
   * runs AI-init (needs `spec`). Empty/absent ⇒ clone only (Skip, or a plain re-provision).
   * @adr 0299 §4
   */
  scaffoldRepos?: string[];
  /**
   * The project spec. With `scaffoldRepos`: used to scaffold those folders. Without
   * (the Add-existing wizard): written back as the root's `project.spec.json`, then
   * committed + pushed to the declared branch. Absent ⇒ clone only (provision).
   * @adr 0299 §4 @adr 0393
   */
  spec?: Record<string, unknown>;
  /**
   * The project's git-auth at dispatch (as `ProjectCreatePayload.gitAuth`), applied before the clone —
   * the Add-existing push and a provision of a worker attached after it connected.
   * @adr 0393 @adr 0405
   */
  gitAuth?: string | null;
  /** The GitHub App credential host for `gitAuth = github-app` (mirrors `ws_token.gitAuthHost`). */
  gitAuthHost?: string | null;
}

/** The cli's reply for project.create / project.add (cli-ws 0002). */
export interface ProjectJobReply {
  ok: boolean;
  /** The scaffolded/prepared path on the worker. */
  path?: string;
  /** Error message when ok=false (English — log/fallback). */
  error?: string;
  /** The step that failed when ok=false — surfaced on the project as `failedStep`. @adr 0263 */
  step?: string;
  /**
   * project.create / spec-carrying project.add — the commit → push outcome, stored as `projects.scaffold_publish`.
   * @adr 0393 @adr 0368
   */
  publish?: ScaffoldPublishResult;
}

/** project.progress event — streamed to the browser during scaffold. @adr 0022 */
export interface ProjectProgressPayload {
  projectId: string;
  /** Short step id (e.g. copy · spec · git · done). */
  step: string;
  /** Human message for the step. */
  message: string;
  /** Terminal event. */
  done?: boolean;
}

// AI spec-assist (suggest/review/compose) no longer uses dedicated ai.* WS messages
// (ADR-0100): the web dispatches prompts via command.dispatch({ ai:true }) → the cli's
// profile-failover AI path, and parses the streamed output client-side.

/**
 * Outbound review. A machine cli asks the server to have an outbound cli vet an
 * AI input before spawning: `review.request` (machine→server) → `review.evaluate`
 * (server→outbound) → `review.result` (outbound→server, forwarded to the requester).
 * @adr 0082
 */
export interface ReviewRequestPayload {
  /** The command this review gates (correlates the verdict + the 2nd server gate). */
  commandId: string;
  /** The input to vet (verbatim prompt the machine cli is about to run). */
  prompt: string;
}
/** server → outbound cli: evaluate `prompt` against the project policy. */
export interface ReviewEvaluatePayload {
  commandId: string;
  prompt: string;
  /** Which engines to run + the scoping policy. @adr 0082 */
  ruleCheck: boolean;
  aiReview: boolean;
  /** Repos commits may target (host/owner/name); empty = no repo restriction. */
  allowedRepos: string[];
  /**
   * Rule-scan regex the reviewer applies, already resolved by the server
   * (project override or the built-in default). Each entry is a `/body/flags` literal or a
   * bare source. Absent (older server) ⇒ the reviewer falls back to its built-in defaults.
   * @adr 0087
   */
  secretPatterns?: string[];
  envPatterns?: string[];
  /** Path the input may edit within (e.g. profiles/<profile>/<project-name>). */
  projectPath?: string;
}
/** outbound cli → server (and forwarded to the requester): the verdict. */
export interface ReviewResultPayload {
  commandId: string;
  /** true = OK (safe to spawn); false = NG (blocked). */
  ok: boolean;
  /** Violation categories when NG (never carries secret values). */
  reasons: string[];
  /** Tokens the aiReview consumed (metered like a run). @adr 0072 */
  tokens?: number;
}

/** The autonomous conditions a manager must see. @adr 0371 §9 */
export type AutonomousAlertKind = "base-protected" | "claim-lost" | "task-failed-limit" | "task-split" | "task-question";

/** autonomous.alert — cli → server (one-way): notify the project's managers (deduplicated per day). */
export interface AutonomousAlertPayload {
  kind: AutonomousAlertKind;
  /** The task concerned (`TSK-…`), when any. */
  task?: string;
  /** The repo / branch concerned (base-protected). */
  repo?: string;
  branch?: string;
  /** English detail line (the notification renders its own localized title). */
  message: string;
}
