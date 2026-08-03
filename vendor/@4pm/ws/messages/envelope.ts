/**
 * WS message envelope (cli-ws 0002): every bidirectional message carries a wsToken
 * (per-message auth) + an AES-256-GCM encrypted payload (with its own nonce).
 */
import type { WsChannelName } from "../channels";

/** Standard envelope for every message after the handshake. */
export interface WsEnvelope {
  /** message id — correlation for the reply. */
  id: string;
  /** id of the request message when this is a reply. */
  replyTo: string | null;
  channel: WsChannelName;
  /** Per-message authentication (arch 0004). */
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
  /** cli version (semver) — the server rejects it if < minSupported (ADR-0015). */
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
}

/** Where a command originated: server-dispatched (web) or cli-local (TUI — ADR-0057). */
export type CommandOrigin = "server" | "local";

/** command.dispatch (server → cli). */
export interface CommandDispatchPayload {
  commandId: string;
  projectId?: string;
  path?: string;
  cmd: string;
  args: string[];
  env?: Record<string, string>;
  /**
   * AI prompt mode (ADR-0057): when true, `cmd` holds the **raw prompt** (not an
   * executable) and the cli runs it through the same AI-CLI profile-failover path as a
   * locally-typed prompt — instead of spawning `cmd` verbatim. `args` is ignored.
   */
  ai?: boolean;
}

/**
 * command.announce (cli → server) — a command initiated locally in the cli TUI
 * (ADR-0057) so the server can create a tracking record + persist history before the
 * command.output chunks arrive. Server-dispatched commands do not need this (the
 * server already has a record).
 */
export interface CommandAnnouncePayload {
  commandId: string;
  projectId?: string;
  cmd: string;
  args: string[];
  /**
   * The operator's raw prompt text (AI runs) so the web console echoes it like the cli TUI
   * (`❯ <prompt>`, ADR-0108) rather than the CLI binary name. Optional — falls back to `cmd`.
   */
  prompt?: string;
  /** Always "local" — server-dispatched commands are not announced. */
  origin: CommandOrigin;
}

/**
 * console.watch (server → cli — ADR-0150): whether a web Console viewer is attached to this
 * link. `on:true` on the first viewer ⇒ the cli starts emitting `console.sync` + pushes a fresh
 * snapshot; `on:false` on the last viewer leaving ⇒ the cli stops. The `console.sync` payload
 * itself is the `ConsoleSyncEvent` shared response type in `@4pm/dto` (also an SSE contract).
 */
export interface ConsoleWatchPayload {
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
   * whose replay buffer was already evicted (ADR-0165): the real output is gone, so a late SSE
   * subscriber must treat this as "reply unavailable" (surface a re-run notice) rather than
   * parsing the empty chunk as the actual reply.
   */
  unavailable?: boolean;
  /**
   * Status/meta line (e.g. "→ trying claude profile … (1/3)"), not part of the command's
   * real output: streamed to the web console for visibility but excluded from the persisted
   * transcript, and rendered directly (bypassing the json/code result-collapse detector) so
   * it can't poison mode detection of the AI result that follows (ADR-0108).
   */
  log?: boolean;
}

/** config.read request/reply (machine-0025, ADR-0141) — the paired profile's config.json. */
export interface ConfigReadRequest {
  /** No parameters — the cli reads its own paired profile's config.json. */
  _?: never;
}
export interface ConfigReadReply {
  /** The config.json file content as text (pretty-printed; empty-defaults when absent). */
  config: string;
}

/** config.write request/reply (machine-0026, ADR-0141) — replace the profile's config.json. */
export interface ConfigWriteRequest {
  /** The new config.json content (raw text; validated + parsed on the cli). */
  config: string;
}
export interface ConfigWriteReply {
  /** True when written; false with `error` when the text is invalid JSON / bad shape. */
  ok: boolean;
  error?: string;
}

/** fs.list request/reply (machine-0007). */
export interface FsListRequest {
  path: string;
}
export interface FsListReply {
  path: string;
  entries: { name: string; type: "dir" | "file" }[];
}

/**
 * fs.write request/reply (machine-0027, ADR-0151) — write a file on the worker, clamped to
 * the physic-project root. The single Git-tab write not carried by a git command over
 * dispatch; used by manual merge-conflict resolution (`project.git_write`).
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

/**
 * Autonomous mode (ADR-0152) — the dashboard controls the worker's headless autonomous engine
 * (`.claude/.autonomous.settings.json` + `auto-cycle`), reached over these channels via the cli.
 */

/** Computed run-state of the autonomous engine on the worker (from crontab + settings + histories). */
export interface AutonomousStatus {
  /** The physic project's tick line is present in the OS crontab (hard on). */
  installed: boolean;
  /** `paused:true` in settings (soft brake). */
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
  /** `.autonomous.approvals.json` text (`{}` when absent). */
  approvals: string;
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

/** autonomous.write — a discriminated write to the engine (ADR-0152). */
export type AutonomousWriteRequest =
  | { kind: "settings"; settings: string }
  | { kind: "approvals"; taskId: string; approved: boolean; by: string }
  | { kind: "userTodo"; content: string; by: string }
  | { kind: "cron"; action: "install" | "uninstall" };
export interface AutonomousWriteReply {
  ok: boolean;
  error?: string;
  /** The refreshed status after the write (so the web updates the badge without a re-read). */
  status?: AutonomousStatus;
}

/**
 * Subagents & skills management (ADR-0153) — the dashboard manages subagent files under
 * `.claude/agents/` and skill folders under `.claude/skills/` on the worker via the cli.
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
 * Security & placeholder management (ADR-0154) — the dashboard manages the security docs and sets
 * placeholder secrets on the worker. Secret VALUES are write-only: they are never returned.
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
 * Agent tool-permission editor (ADR-0183) — the dashboard edits the Claude `permissions` block of
 * `.claude/settings.json` (shared, committed) or `.claude/settings.local.json` (per-cli local). The
 * cli is the single writer: it splices only the `permissions` block back, preserving all other
 * settings fields and re-injecting the ADR-0154 secrets `deny` on a shared write.
 */

/** Which settings file the policy applies to. */
export type AgentToolsScope = "shared" | "local";

/** Claude Code permission mode for `permissions.defaultMode`. */
export type AgentToolsMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";

/** The `permissions` block of a Claude settings file. */
export interface AgentToolsPermissions {
  defaultMode: AgentToolsMode;
  allow: string[];
  ask: string[];
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
 * Skill/subagent marketplace (ADR-0185) — the cli packs a `.claude` artifact into a file set
 * (server zips + stores it), installs a downloaded package version into `.claude/agents|skills`
 * (recording `.4pm-packages.json` with a sha256 for drift), lists what is installed (with the
 * on-disk sha256 recomputed), and removes an installed package. The server owns the registry;
 * the cli is the single `.claude`-writer (path-clamped like ADR-0153).
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
 * Docs & code dependency graph (ADR-0155) — the cli builds a graph of the physic project (docs or
 * code) that the web renders in WebGL. Deterministic + bounded; orphans are unlinked nodes.
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
 * RAG capability + install (ADR-0156) — the dashboard checks whether a worker can run RAG and
 * installs a worker-tuned embedding model through the cli. Install runs in the background; the web
 * polls the status.
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
  /** The vector index state (ADR-0157). */
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

/** The vector-index state (ADR-0157). */
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
  /** File content at HEAD (empty if untracked/new). */
  oldContent: string;
  /** Current working-tree content. */
  newContent: string;
}

/**
 * git history browse (read-through cli — ADR-0089). Every request carries a `repo`
 * subdir (relative to the physic project root; "" = the root repo); the cli resolves it
 * inside its serving folder and blocks path traversal.
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

/** usage.report (cli → server — batch, ADR-0020). */
export interface UsageReportPayload {
  events: {
    metric: string;
    amount: number;
    /** ISO timestamp when it occurred. */
    occurredAt: string;
    /** The AI-CLI profile (account email / dir) this usage ran under (ADR-0072) — for the
     *  per-profile breakdown. Absent for non-AI events. */
    profile?: string;
    /** Claude auth mode this run used (ADR-0192 §5): `subscription` (OAuth) vs `api-key`
     *  (ANTHROPIC_API_KEY, API-billed). Present on ai_tokens events so billing can split them. */
    authMode?: "subscription" | "api-key";
    /** The `ai_tokens` split (ADR-0145): input + output + cache-read + cache-creation summing
     *  to `amount`. Present only for `ai_tokens` events; absent for other metrics. */
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
 * machine.usage (cli → server — ADR-0072). Claude subscription usage snapshot from the
 * Anthropic OAuth usage API. Carries only utilization/reset/plan — **never** the OAuth token.
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
}

/** log.read request/reply (server → cli — ADR-0072): tail the cli's own JSONL logs. */
export interface LogReadRequest {
  /** Max lines from the newest log file (default 200). */
  limit?: number;
}
export interface LogReadReply {
  /** Raw JSONL lines (newest file, tail), oldest-first. */
  lines: string[];
}

/** command.output-read request/reply (server → cli — ADR-0115): read a command's captured output. */
export interface CommandOutputRequest {
  commandId: string;
}
export interface CommandOutputReply {
  /** Full captured output, or null when pruned / never captured on this cli. */
  output: string | null;
}

/**
 * machine.log (cli → server — ADR-0122): a periodic upload of the cli's own JSONL log file so
 * it is stored + retained server-side and counted in the machine user's storage footprint.
 * Sends one (usually the current day's) file plus the authoritative total of all the cli's log
 * files on the worker, so the server can set the footprint exactly + delta the org counter.
 */
export interface MachineLogPayload {
  /** Log file name, e.g. `cli-2026-07-21.jsonl`. */
  fileName: string;
  /** Full content of that log file (UTF-8). */
  content: string;
  /** Total bytes of ALL the cli's `logs/` files on the worker right now. */
  totalBytes: number;
}

/** command.history (cli → server — ADR-0072): one finished command's rich record. */
export interface CommandHistoryPayload {
  commandId: string;
  cmd: string;
  args: string[];
  status: string;
  exitCode?: number | null;
  tokens?: number;
  /** The run's `ai_tokens` split (ADR-0145) — total is `tokens`. Absent when not an AI run. */
  tokensBreakdown?: { input: number; output: number; cacheRead: number; cacheCreation: number };
  projectId?: string | null;
  startedAt: string;
  finishedAt?: string | null;
}

/** git.env request/reply (machine-0008). */
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
 * git.ssh-key request/reply (ADR-0173) — manage the rented worker's ssh deploy key. The
 * keypair is generated **on the worker** (`generate`); only the public key + fingerprint
 * are ever returned. `get` reads the current public key; `delete` removes the keypair.
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

/** project.create request — scaffold from the sample template (project-0010). */
export interface ProjectCreatePayload {
  projectId: string;
  /**
   * Project name = the physic folder name; the cli scaffolds into
   * `<profileDir>/<projectName>` (folder = name — ADR-0064/0080). No user-chosen path.
   */
  projectName: string;
  /** The PMSpec collected by the wizard (stored as jsonb server-side). */
  spec?: Record<string, unknown>;
}

/** physic.sync — server → cli: rename/recreate the physic folder on project rename
 *  (folder = project name — ADR-0064). */
export interface PhysicSyncPayload {
  /** Previous folder name to remove (null = only create the new one). */
  oldName: string | null;
  /** New folder name (= new project name) to create. */
  newName: string;
}

/** physic.delete — server → cli: the project was deleted ⇒ delete the physic folder
 *  `<profile>/<name>`; the cli keeps its pairing and goes idle (ADR-0068). */
export interface PhysicDeletePayload {
  /** Physic folder name (= project name) to delete. */
  name: string;
}

/**
 * One declared repo of a project.add request — mirrors `@4pm/dto` `RepoSpec` (ADR-0073)
 * without coupling protocol → dto. `op:"existing"` clones `url`; `op:"create"` inits a
 * fresh repo. The `primary` repo lands at the target root, sub-repos in `subdir`.
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
  defaultBranch?: string;
  gitignore?: string;
  commitConvention?: string;
}

/**
 * project.add request — register an existing project by cloning/linking its repos
 * (project-0011, ADR-0117). No user-chosen path (ADR-0080): the cli derives
 * `<profileDir>/<projectName>` and returns it; no scaffold/AI-init.
 */
export interface ProjectAddPayload {
  projectId: string;
  /** Project name = the physic folder name (folder = name — ADR-0064/0080). */
  projectName: string;
  /** Multi-repo declaration (ADR-0073): ≥1 repo, exactly one primary. */
  repos: ProjectAddRepo[];
}

/** The cli's reply for project.create / project.add (cli-ws 0002). */
export interface ProjectJobReply {
  ok: boolean;
  /** The scaffolded/prepared path on the worker. */
  path?: string;
  /** Error message when ok=false (English — log/fallback). */
  error?: string;
}

/** project.progress event — streamed to the browser during scaffold (ADR-0022). */
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
 * Outbound review (ADR-0082). A machine cli asks the server to have an outbound cli vet an
 * AI input before spawning: `review.request` (machine→server) → `review.evaluate`
 * (server→outbound) → `review.result` (outbound→server, forwarded to the requester).
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
  /** Which engines to run + the scoping policy (ADR-0082). */
  ruleCheck: boolean;
  aiReview: boolean;
  /** Repos commits may target (host/owner/name); empty = no repo restriction. */
  allowedRepos: string[];
  /**
   * Rule-scan regex the reviewer applies (ADR-0087), already resolved by the server
   * (project override or the built-in default). Each entry is a `/body/flags` literal or a
   * bare source. Absent (older server) ⇒ the reviewer falls back to its built-in defaults.
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
  /** Tokens the aiReview consumed (metered like a run — ADR-0072). */
  tokens?: number;
}
