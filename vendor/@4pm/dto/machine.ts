/**
 * DTO for the machine link + worker + physic project domain
 * (21-api/machine-0001…0013).
 */
import type { McpServerDefinition } from "./mcp";
import type { ApprovalPublicKey } from "./autonomous-approval";
import type { NetworkPolicy, NetworkPolicyRule } from "./network";
import { z } from "zod";
import type {
  MachineLinkScope,
  PhysicProjectStatus,
  WorkerStatus,
} from "@4pm/constants";
import { hexTokenSchema } from "@4pm/validation";
import { baseRequestSchema } from "./base";
import type { CommandOrigin } from "./command";
import type {
  GitAuthMethod,
  ProjectMemoryMode,
  ProjectTokenSettings,
  WorkerNetworkProbe,
} from "./project";

/**
 * Shared AI memory pushed to the cli on `ws_token` for the project a link serves: the
 * stored rolling `text` (seeds the cli cache on connect/reconnect) plus the project's override
 * settings the cli resolves against its own machine-user memory config. `null` for orchestrator/idle
 * links or when the project has no stored memory yet.
 * @adr 0245
 */
export interface ProjectAiMemoryPush {
  /** The stored compacted memory text for this (project × link); empty when none yet. */
  text: string;
  /** Project override of memory enablement (on/off/inherit the machine-user setting). */
  mode: ProjectMemoryMode;
  /** Project override of the memory char budget; 0 = inherit the machine-user budget. */
  budgetChars: number;
}

/** Body POST /machine-links/pair. @api machine-0001 */
export const pairRequestSchema = z.object({
  hashcode1: hexTokenSchema,
  userId: z.string().guid().optional(),
});
export type PairRequest = z.infer<typeof pairRequestSchema>;

/** 200 data of pair. */
export interface PairResponse {
  hashcode2: string;
  machineLinkId: string;
}

/** Body POST /machine-links/confirm (machine-0002 — CLI side).
 *  fingerprint/hostname: the cli collects these so the server can match/create a worker
 *  (reported at pair time and on every connect). */
export const confirmRequestSchema = z.object({
  hashcode2: hexTokenSchema,
  fingerprint: z.string().max(200).optional(),
  hostname: z.string().max(200).optional(),
});
export type ConfirmRequest = z.infer<typeof confirmRequestSchema>;

/** 200 data of confirm — the CLI stores `.cre`.
 *  userId/username identify the paired MACHINE user so the cli can name the default
 * profile by userId.
 * @adr 0047
 */
export interface ConfirmResponse {
  hashcode3: string;
  userId: string;
  username: string;
  /** Link scope (project | orchestrator); the cli stores it in `.cre`. @adr 0010 */
  scope: string;
  /** Logical project the MACHINE user serves (physic folder name), or null — the cli
   *  scaffolds `<profileDir>/<projectName>` on link (ADR-0064; MEMO). */
  projectName?: string | null;
}

/** Body POST /machine-links/token (machine-0003 — CLI side, daily). */
export const wsTokenRequestSchema = z.object({
  hashcode3: hexTokenSchema,
});
export type WsTokenRequest = z.infer<typeof wsTokenRequestSchema>;

/**
 * Body POST /machine-links/pair-token (ADR-0192 §6 — headless pairing): a booting cli exchanges a
 * provisioning token for a fresh hashcode3 (reply = `ConfirmResponse`), no interactive hashcode.
 */
export const pairTokenRequestSchema = z.object({
  token: z.string().min(16).max(200),
  fingerprint: z.string().max(200).optional(),
  hostname: z.string().max(200).optional(),
});
export type PairTokenRequest = z.infer<typeof pairTokenRequestSchema>;

/** Body POST /machine-links/provisioning-token — issue a headless-pairing token. @adr 0192 §6 */
export const issueProvisioningTokenRequestSchema = z.object({
  machineLinkId: z.string().guid(),
  /** TTL seconds (0/absent ⇒ a default short TTL applied server-side). */
  ttlSec: z.number().int().min(0).max(2_592_000).optional(),
});
export type IssueProvisioningTokenRequest = z.infer<typeof issueProvisioningTokenRequestSchema>;

/**
 * Body POST /machines/:id/provision — how to (re)provision the
 * serving worker's repos. `sync` (default): clone any missing repo, else fetch + check out the
 * configured branch + fast-forward pull an existing one (never clobbers local work). `force`:
 * delete each repo folder and re-clone it fresh (destructive — discards local changes).
 * @api machine-0065 @adr 0292
 */
export const provisionRequestSchema = z.object({
  mode: z.enum(["sync", "force"]).optional().default("sync"),
});
export type ProvisionRequest = z.infer<typeof provisionRequestSchema>;

/**
 * Body POST /machines/provision-for-user — (re)provision the repos of `projectId` on the
 * worker of `userId` (a routing entry). The server resolves that user's serving link for the project
 * and applies the same `mode` (sync/force) as `provision`.
 * @adr 0292
 */
export const provisionForUserRequestSchema = z.object({
  userId: z.string().guid(),
  projectId: z.string().guid(),
  mode: z.enum(["sync", "force"]).optional().default("sync"),
});
export type ProvisionForUserRequest = z.infer<typeof provisionForUserRequestSchema>;

/** Data POST /machine-links/provisioning-token — the plaintext token (shown once) + expiry. */
export interface IssueProvisioningTokenResponse {
  token: string;
  expiresAt: string | null;
}

/** 200 data of token. */
export interface WsTokenResponse {
  wsToken: string;
  wsTokenExpiresAt: string;
  /** Link scope (project | orchestrator); the cli heals its `.cre` from this. @adr 0010 */
  scope: string;
  /**
   * Org-configured cap (seconds) on the cli's reconnect backoff. The cli
   * uses this over its local env var; absent ⇒ the cli falls back to env/default.
   * @adr 0056
   */
  reconnectMaxBackoffSec: number;
  /** Org toggle for the daily scheduled cli auto-update. @adr 0074 */
  autoUpdateDaily: boolean;
  /** Hour of day (0–23) the daily update runs, in the org `timezone` below. @adr 0074 */
  autoUpdateHour: number;
  /** Org timezone (IANA) the cli uses to resolve `autoUpdateHour` to local time. @adr 0074 */
  timezone: string;
  /**
   * cli data-retention window (days) for this machine user — the cli prunes its
   * logs / command-history / command-output older than this. `0` = keep the cli defaults.
   * Capped server-side at the plan's `retentionDays`.
   * @adr 0115
   */
  cliRetentionDays: number;
  /**
   * Runtime token knobs of the project this link serves, pushed so the cli can
   * rotate its Claude profile on session pressure and cap per-prompt tokens. `null` for
   * orchestrator links or a project cli not yet attached to a physic project. Budgets
   * (project/cli token limits) are NOT here — the cli learns them via `quota.check`.
   * @adr 0081
   */
  projectTokens: ProjectTokenSettings | null;
  /**
   * Shared AI memory of the project this link serves: the stored rolling text (seeds the
   * cli cache) + the project's override settings. `null` for orchestrator/idle links.
   * @adr 0245
   */
  aiMemory: ProjectAiMemoryPush | null;
  /**
   * Folder-scope hardening of the project this link serves (ADR project aiScope). When
   * true the cli prepends a guard to every AI prompt telling the agent to only use content
   * inside the served project folder. `false` for orchestrator/idle links or when the
   * project has it off.
   */
  aiRestrictToFolder: boolean;
  /**
   * Git-auth method of the project this link serves — tells the worker how to
   * authenticate git (`self`/`deploy-key` need no token config; the GitLab methods /`github-app`
   * configure an injected/minted token for HTTPS). `null` for orchestrator/idle links or `self`.
   * @adr 0192 §4 @adr 0382 @adr 0435 @adr 0356
   */
  gitAuth: GitAuthMethod | null;
  /**
   * GitHub host of the project's App credential when `gitAuth` is `github-app` — the cli
   * scopes its credential helper + `gh` shim to it and pulls tokens over `git.token`. Absent otherwise
   * (and from an older server).
   * @adr 0356
   */
  gitAuthHost?: string | null;
  /**
   * Approved MCP servers of the project this link serves — the cli writes them to its
   * generated `--mcp-config` and runs every claude spawn with `--strict-mcp-config`. Empty for
   * orchestrator/idle links; absent from an older server (⇒ no MCP server runs).
   * @adr 0427
   */
  mcpServers?: { name: string; definition: McpServerDefinition }[];
  /**
   * The server's approval-signing public keys — the cli persists them and from then on counts an
   * autonomous approval only when its signature verifies. Absent (older server / no signing key) ⇒ the
   * cli keeps its last stored keys, or the unsigned legacy behaviour when it never had any.
   * @adr 0438
   */
  approvalKeys?: ApprovalPublicKey[];
  /**
   * The project the link serves — bound into every approval signature, so an entry signed for one
   * project never verifies in another. `null` for an orchestrator / idle link; absent from an older server.
   * @adr 0438
   */
  approvalProjectId?: string | null;
  /**
   * Network egress policy for the cli's proxy: the served project's policy (org deny merged into `deny`)
   * + the org denylist alone for project-less runs. Absent from an older server ⇒ the cli keeps Audit with
   * no rules. `null` mode fields never occur — an idle link gets the org part with mode `audit`.
   * @adr 0439
   */
  network?: NetworkPolicy & { orgDeny: NetworkPolicyRule[]; projectId: string | null };
  /**
   * Mask the worker's AI account labels — `true` when the link's user is a platform-pool
   * (rented) machine user. The cli then shows every renter-visible credential label as `AI account #N`
   * instead of the account email. Absent (older server) ⇒ treated as `false`.
   * @adr 0395
   */
  maskAiAccounts?: boolean;
  /**
   * Outbound-review policy of the project this link serves. Tells the cli to
   * require an outbound review before spawning AI (`enabled`), which engines to run, and
   * whether THIS link is itself an outbound reviewer (`isOutbound`). `null` when the
   * project has no review policy or the link serves no project.
   * @adr 0082
   */
  outboundReview: OutboundReviewCliPolicy | null;
  /**
   * This link's machine-user username — the cli's git commit author for the
   * served project. Push uses the account the worker is already logged in with (gh/glab).
   * @adr 0097
   */
  machineUsername: string;
  /**
   * Worker tool restore manifest — the tools + exact versions this machine user should
   * have, plus its per-tool auto-update flags. On boot the cli reconciles its installed tools to
   * `manifest` (installing a missing/mismatched version) so a container recreation restores the
   * toolchain. When a copy-apply is queued (`pendingToolManifest`) that manifest **wins** here
   * (pending takes precedence over the self-restore snapshot); otherwise it is the link's own last
   * reported snapshot. `null` when the server holds no snapshot and nothing is queued.
   * @adr 0254
   */
  toolRestore: WorkerToolRestorePush | null;
  /**
   * WebSocket base URL the cli should connect to (ADR-0131 phase 3 cutover). When present,
   * the cli opens `<wsUrl>/ws` on `@4pm/cli-server` instead of the server gateway and heals
   * it into `.cre`. Absent ⇒ the cli keeps using its `serverUrl` (old behaviour / server
   * gateway), so both gateways run in parallel during the migration.
   */
  wsUrl?: string;
  /**
   * Declared repos of the project this link serves — the CLI clones any of these whose
   * `.git` is missing from the physic folder on connect (idempotent; a present repo is skipped), so
   * a reconnect always sets up what's missing regardless of the server-side physic status. Empty for
   * orchestrator/idle links or a project with no declared repos.
   * @adr 0289
   */
  repos: WsTokenRepo[];
  /**
   * Admin-edited overrides for cli-built prompts, keyed by the `@4pm/constants` prompt
   * key → per-locale content map ({ en, vi, ja, zh } → string). Only keys the platform admin has
   * actually edited are sent (the cli falls back to its built-in default otherwise); absent/empty on
   * an older server. Platform-wide, so every link carries the same map.
   * @adr 0381
   */
  promptOverrides?: Record<string, Record<string, string>>;
}

/** One declared repo pushed to the cli via ws_token for clone-on-connect. @adr 0289 */
export interface WsTokenRepo {
  /** The primary repo clones into the folder root; a sub-repo into its `subdir`. */
  primary: boolean;
  /** Clone URL (https/ssh); absent ⇒ nothing to clone (an init-only repo). */
  url?: string;
  /** Sub-repo subfolder under the physic root (empty/undefined for the primary). */
  subdir?: string;
  /** Primary branch to clone / check out; empty/undefined ⇒ the repo's default branch. @adr 0292 */
  branch?: string;
}

/** Outbound-review policy delivered to a cli via ws_token. @adr 0082 */
export interface OutboundReviewCliPolicy {
  enabled: boolean;
  ruleCheck: boolean;
  aiReview: boolean;
  /** True when this machine-link is one of the project's outbound reviewers. */
  isOutbound: boolean;
  /** Repos commits may target (host/owner/name); empty = derive from git. */
  allowedRepos: string[];
}

/** 200 data of whoami (machine-0020 — CLI side): the paired account + its memberships. */
export interface WhoamiResponse {
  username: string;
  /** Link scope (project | orchestrator). @adr 0010 */
  scope: string;
  roles: string[];
  teams: { id: string; name: string }[];
  projects: { id: string; name: string }[];
}

/** Machine link returned by the API (never includes the hashes). */
export interface MachineLinkResponse {
  id: string;
  userId: string;
  username: string;
  scope: MachineLinkScope;
  status: string;
  hashcode3ExpiresAt: string | null;
  lastConnectedAt: string | null;
  /** Is the WS open with the server? */
  connected: boolean;
  /** The physical machine the cli runs on — null for orchestrator/not yet connected. */
  workerId: string | null;
  /** Running cli version the worker last reported; null when unknown. @adr 0015 */
  cliVersion?: string | null;
  /** True when the running cli's effective status is `warning` (older than the latest release, or an
   * admin warning).
   * @adr 0015 @adr 0363
   */
  cliOutdated?: boolean;
  /** True when the running cli's effective status is `unsupported` (below the minimum, an admin
   * override or a passed cut-off date): refused the next time it connects.
   * @adr 0363
   */
  cliUnsupported?: boolean;
  /** ISO cut-off date of a `warning` version; null/omitted when none. @adr 0363 */
  cliUnsupportedFrom?: string | null;
  /** The admin's note for the running version; null/omitted when none. @adr 0363 */
  cliVersionNote?: string | null;
  /** True when the worker runs an update-locked image — a cli update is refused. @adr 0432 @adr 0434 */
  cliUpdateLocked?: boolean;
  /** Latest worker network probe — the machine-user page shows outbound/inbound posture
   *  and warns when it's open. Null when the cli hasn't reported one yet (old clients / offline).
   * @adr 0221
   */
  network?: WorkerNetworkProbe | null;
  /** Tools whose last run failed — surfaced to the tenant web (Machines / Members) so a
   *  user sees the cli's last tool/connect error, like the admin pools. Empty/omitted = all healthy.
   * @adr 0223
   */
  failingTools?: WorkerFailingTool[];
  /** Last failed cli self-update — surfaced only while the cli is still outdated, so the
   *  web "Update" modal shows why an update didn't land. Null/omitted = no recent failure.
   * @adr 0305
   */
  cliUpdateError?: WorkerCliUpdateError | null;
  /** AI accounts the cli last reported (`machine.status`) — the org's own links only; a rented
   * (pool) link always returns `[]` (its 4PM accounts are admin-only).
   * @adr 0354 @adr 0402
   */
  aiAccounts?: string[];
  createdAt: string;
}

/**
 * Per-tool last-run health — stored under `MachineLink.usageSnapshot.toolHealth`,
 * keyed by the external tool name (claude/codex/gh/glab/git). Written by the `tool.health`
 * write-back and preserved across `machine.usage` snapshot overwrites.
 * @adr 0223
 */
export interface WorkerToolHealthEntry {
  ok: boolean;
  message: string | null;
  at: string;
}
export type WorkerToolHealth = Record<string, WorkerToolHealthEntry>;

/** A tool whose last run failed — projected for the admin pool lists. @adr 0223 */
export interface WorkerFailingTool {
  tool: string;
  message: string;
  at: string;
}

/**
 * Project the failing tools (last run not ok) from a machine link's `usageSnapshot` JSON,
 * newest-first. Tolerant of null / old snapshots without a `toolHealth` key.
 * @adr 0223
 */
export function readFailingTools(usageSnapshot: unknown): WorkerFailingTool[] {
  const th = (usageSnapshot as { toolHealth?: WorkerToolHealth } | null | undefined)?.toolHealth;
  if (!th || typeof th !== "object") return [];
  return Object.entries(th)
    .filter(([, v]) => v && typeof v === "object" && v.ok === false)
    .map(([tool, v]) => ({ tool, message: v.message ?? "", at: v.at }))
    .sort((a, b) => (a.at < b.at ? 1 : -1));
}

/**
 * Last cli self-update failure — stored under `MachineLink.usageSnapshot.cliUpdate`,
 * written by the `cli.update-result` write-back and preserved across `machine.usage` snapshot
 * overwrites. Carries only a short reason (never stdout/secrets).
 * @adr 0305
 */
export interface WorkerCliUpdateEntry {
  ok: boolean;
  message: string | null;
  fromVersion: string;
  toVersion: string | null;
  at: string;
}

/** A failed cli self-update projected for the web — reason + when it happened. */
export interface WorkerCliUpdateError {
  message: string;
  at: string;
}

/** One worker a bulk cli update pushed `cli.update` to. @adr 0413 */
export interface CliUpdateAllTarget {
  /** Machine-link id (web) or pool user id (admin, admin-0140/0141). @api machine-0074 */
  id: string;
  /** Display name (username / alias). */
  label: string;
}

/** Why an online, outdated worker was not pushed by a bulk cli update. @adr 0413 */
export type CliUpdateAllSkipReason = "autonomous" | "failed" | "locked";

/** One online, outdated worker a bulk cli update skipped. @adr 0413 */
export interface CliUpdateAllSkip extends CliUpdateAllTarget {
  reason: CliUpdateAllSkipReason;
}

/**
 * Result of a bulk "Update all CLIs" (machine-0074, admin-0140/0141): the workers that were
 * online + behind the latest release and got `cli.update`, plus the ones skipped. Empty `queued` = no
 * online worker needs an update.
 * @adr 0413
 */
export interface CliUpdateAllResponse {
  queued: CliUpdateAllTarget[];
  skipped: CliUpdateAllSkip[];
}

/**
 * Project the last cli self-update FAILURE from a machine link's `usageSnapshot` JSON.
 * Returns null when there is none. Callers gate on `cliOutdated` so a stale failure disappears once
 * the worker eventually comes back on the latest version. Tolerant of null / old snapshots.
 * @adr 0305
 */
export function readCliUpdateError(usageSnapshot: unknown): WorkerCliUpdateError | null {
  const cu = (usageSnapshot as { cliUpdate?: WorkerCliUpdateEntry } | null | undefined)?.cliUpdate;
  if (!cu || typeof cu !== "object" || cu.ok !== false) return null;
  return { message: cu.message ?? "", at: cu.at };
}

/** Physic project — a project folder on the worker served by one cli. */
export interface PhysicProjectResponse {
  id: string;
  machineLinkId: string;
  projectId: string;
  projectName: string;
  /** null = pending (wizard step 2 has not finalized the folder). */
  path: string | null;
  name: string;
  isAutonomous: boolean;
  status: PhysicProjectStatus;
  lastSeenAt: string | null;
}

/** A cli node in the worker tree. @api machine-0009 */
export interface WorkerMachineLinkNode {
  id: string;
  userId: string;
  username: string;
  /** Link scope (project | orchestrator). Orchestrator clis don't serve a
   *  physic project, so the web hides the attach-folder UI for them.
   * @adr 0010
   */
  scope: string;
  connected: boolean;
  /** null if the cli has no physic project attached. */
  physicProject: PhysicProjectResponse | null;
  /**
   * Egress enforcement the cli reported (Networks): `container` = enforced, `none` = Audit only (with
   * `egressReason`), null = an older cli that does not report it.
   * @adr 0439
   */
  egress?: "container" | "none" | null;
  egressReason?: string | null;
}

/**
 * Live worker resource snapshot — collected by the cli (cgroup-accurate in a container,
 * `os.*` on bare-metal) and streamed over `machine.metrics`. **Never persisted** — buffered in Redis
 * with a short TTL; `null` on a worker when it isn't currently reporting (offline/unwatched/expired).
 * @adr 0214
 */
export interface WorkerResources {
  /** Current CPU utilization (0–100). */
  cpuPct: number;
  /** Logical CPU count available to the worker (cgroup quota or host cores). */
  cpuCount: number;
  memUsedMb: number;
  memTotalMb: number;
  diskUsedGb: number;
  diskTotalGb: number;
  /** `linux` | `darwin` | `win32`. */
  platform: string;
  /** `x64` | `arm64` | … */
  arch: string;
  /** Where the limits came from: `cgroup` (container-accurate) or `os` (bare-metal/VM fallback). */
  source: "cgroup" | "os";
  /** ISO timestamp the sample was taken on the worker. */
  at: string;

  // --- Extended cgroup v2 metrics (ADR-0218) ---
  // All optional: only present on the `cgroup` source when the controller/file is readable;
  // the `os` fallback and older clis omit them, and the UI hides what is absent.

  /** % of CPU periods throttled by the cgroup quota this interval (`cpu.stat` nr_throttled/nr_periods). */
  cpuThrottledPct?: number;
  /** CPU pressure stall — `cpu.pressure` `some avg10` (0–100). */
  cpuPressurePct?: number;
  /** Anonymous (application) memory in MB — `memory.stat` `anon`. */
  memAnonMb?: number;
  /** File/page-cache memory in MB — `memory.stat` `file`. */
  memCacheMb?: number;
  /** Swap in use (MB) — `memory.swap.current`. */
  swapUsedMb?: number;
  /** Swap limit (MB); `null` when unlimited (`memory.swap.max` = `max`). */
  swapTotalMb?: number | null;
  /** Memory pressure stall — `memory.pressure` `some avg10` (0–100). */
  memPressurePct?: number;
  /** Cumulative OOM-kill count in this cgroup — `memory.events` `oom_kill`. */
  oomKills?: number;
  /** Block-device read throughput this interval (MB/s) — `io.stat` rbytes delta. */
  diskReadMbps?: number;
  /** Block-device write throughput this interval (MB/s) — `io.stat` wbytes delta. */
  diskWriteMbps?: number;
  /** I/O pressure stall — `io.pressure` `some avg10` (0–100). */
  ioPressurePct?: number;
  /** Current process/thread count — `pids.current`. */
  pidsCurrent?: number;
  /** Process/thread limit; `null` when unlimited (`pids.max` = `max`). */
  pidsMax?: number | null;

  /**
   * Over-provision self-check advisories — warn-only, never blocks the worker. Stable codes
   * the UI maps to text: `cpu-unbounded` / `mem-unbounded` (no cgroup limit ⇒ can consume the whole host),
   * `cpu-overcommit` / `mem-overcommit` (limit exceeds host physical ⇒ OOM/throttle risk), `disk-full`
   * (volume near capacity). Omitted/empty when the config looks healthy; older clis omit it entirely.
   * @adr 0390
   */
  warnings?: string[];
}

/**
 * `machine.metrics` payload (cli → server) — one live resource sample keyed by the
 * worker fingerprint (a worker can host several clis; last-writer-wins per worker).
 * @adr 0214
 */
export interface MachineMetricsPayload {
  fingerprint: string;
  resources: WorkerResources;
}

/** One point of a worker's ~1-minute resource series. @api machine-0054 @adr 0214 */
export interface WorkerMetricsSample {
  cpuPct: number;
  memUsedMb: number;
  memTotalMb: number;
  diskUsedGb: number;
  diskTotalGb: number;
  at: string;
  // Trended cgroup v2 rate/pressure fields (ADR-0218) — optional, mirror `WorkerResources`.
  cpuThrottledPct?: number;
  cpuPressurePct?: number;
  memPressurePct?: number;
  ioPressurePct?: number;
  diskReadMbps?: number;
  diskWriteMbps?: number;
  swapUsedMb?: number;
}

/** Data GET /workers/:id/metrics — the expanded worker's live series. @api machine-0054 @adr 0214 */
export interface WorkerMetricsSeriesResponse {
  workerId: string;
  samples: WorkerMetricsSample[];
  source: "cgroup" | "os";
  /**
   * Latest full resource snapshot — richer than a series point (carries vCPU count,
   * platform/arch and the extended cgroup v2 metrics), so a standalone viewer (the machine-user
   * Info tab / the project Dashboard) can render the container-info column without the workers
   * list row. `null` when the worker isn't currently reporting.
   */
  resources: WorkerResources | null;
}

/** Worker (physical machine) + the cli → physic project tree. @api machine-0009 */
export interface WorkerResponse {
  id: string;
  name: string;
  fingerprint: string;
  status: WorkerStatus;
  lastSeenAt: string | null;
  machineLinks: WorkerMachineLinkNode[];
  /** Live resource snapshot from the Redis buffer; null when not reporting. @adr 0214 */
  resources?: WorkerResources | null;
}

/** One Claude subscription usage window (utilization % + reset). @adr 0072 */
export interface MachineUsageWindow {
  utilizationPct: number;
  resetsAt: string | null;
}

/** Claude subscription usage snapshot for a machine-link (from machine.usage). */
export interface MachineUsageSubscription {
  plan: string;
  /** AI CLI in use (claude | codex). */
  aiCli?: string;
  /** Active profile label (config-dir basename). */
  profile?: string;
  session: MachineUsageWindow;
  weekly: MachineUsageWindow;
  extra?: { usedCredits: number; currency: string };
  checkedAt: string;
}

/** Live operational status of a machine-link. @adr 0072 */
export interface MachineUsageStatus {
  connected: boolean;
  scope: string;
  /** Currently processing a prompt. */
  busy: boolean;
  /** The physic project it serves (label "current"), or null when idle. */
  serving: { projectId: string; name: string } | null;
  /** Running cli version the worker last reported (machine.status); null if unknown. @adr 0015 */
  cliVersion?: string | null;
  /** True when the running cli's effective status is `warning` (older than the latest release, or an
   * admin warning).
   * @adr 0015 @adr 0363
   */
  cliOutdated?: boolean;
  /** True when the running cli's effective status is `unsupported` (below the minimum, an admin
   * override or a passed cut-off date): refused the next time it connects.
   * @adr 0363
   */
  cliUnsupported?: boolean;
  /** ISO cut-off date of a `warning` version; null/omitted when none. @adr 0363 */
  cliUnsupportedFrom?: string | null;
  /** The admin's note for the running version; null/omitted when none. @adr 0363 */
  cliVersionNote?: string | null;
  /** True when the worker runs an update-locked image — a cli update is refused. @adr 0432 @adr 0434 */
  cliUpdateLocked?: boolean;
  /** The latest cli release version (for the "please update" hint); null if not resolved. */
  latestCliVersion?: string | null;
  /** The minimum cli version the server still accepts (for the "unsupported" red hint); null if
   *  not resolved. */
  minSupportedCliVersion?: string | null;
  /** Last failed cli self-update — surfaced only while the cli is still outdated, so the
   *  web "Update" modal shows why an update didn't land instead of spinning forever.
   * @adr 0305
   */
  cliUpdateError?: WorkerCliUpdateError | null;
}

/** Per-project usage of one machine-link (history). @adr 0072 */
export interface MachineProjectUsage {
  projectId: string;
  name: string;
  tokens: number;
  commands: number;
  /** True for the project it is currently serving (shown on top). */
  current: boolean;
}

/** GET /machines/:id/logs — tail of the cli's own JSONL logs. @adr 0072 */
export interface LogReadResponse {
  lines: string[];
}

/** One command-history row for a MACHINE user / project. @api command-0005 @adr 0072 @adr 0107 */
export interface CommandHistoryItem {
  id: string;
  commandId: string;
  /** `web` (dispatched) | `local` (typed in the cli TUI) — ADR-0107. */
  origin: CommandOrigin;
  /** The cli (machine-link) that ran the command. */
  machineLinkId: string;
  /**
   * Display name of the machine-user (cli) that ran the command (command-0005 column) —
   * `aliasName || username`; a short `machineLinkId` prefix when the machine-user is unknown
   * (link deleted). Distinct from `initiatedByName` on the activity feed (who dispatched from the web).
   * @adr 0200 @adr 0249
   */
  machineUser: string;
  cmd: string;
  args: string[];
  status: string;
  exitCode: number | null;
  tokens: number | null;
  /** The ai_tokens split for this run; all `null` for non-AI / pre-migration rows. @adr 0145 */
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  projectId: string | null;
  startedAt: string;
  finishedAt: string | null;
}

/** GET /machine-links/:id/usage — status + subscription + per-project usage. @adr 0072 */
export interface MachineUsageResponse {
  linkId: string;
  userId: string;
  username: string;
  /** The worker (physical machine) hosting this cli — for the per-cli container-metrics panel; null when unpaired. */
  workerId: string | null;
  status: MachineUsageStatus;
  subscription: MachineUsageSubscription | null;
  projects: MachineProjectUsage[];
  /** Latest worker network probe — the machine-user Info tab shows outbound/inbound
   *  posture from it. Null when the cli hasn't reported one yet (old clients / offline).
   * @adr 0221
   */
  network?: WorkerNetworkProbe | null;
}

/**
 * Query GET /workers — `search` matches worker/cli/project; min*Pct filter live resources.
 * @api machine-0009 @adr 0214
 */
export const listWorkersQuerySchema = baseRequestSchema.extend({
  status: z.enum(["online", "offline"]).optional(),
  /** Only workers whose live CPU/memory/disk usage % ≥ the given threshold (0–100). */
  minCpuPct: z.coerce.number().min(0).max(100).optional(),
  minMemPct: z.coerce.number().min(0).max(100).optional(),
  minDiskPct: z.coerce.number().min(0).max(100).optional(),
  /** Hide workers with no cli attached (clis = 0). The web defaults this on; unchecking the
   *  "show empty CLIs" box drops it so empty workers are listed too. */
  hideEmptyClis: z.enum(["true", "false"]).transform((v) => v === "true").optional(),
});
export type ListWorkersQuery = z.infer<typeof listWorkersQuerySchema>;

/** Body PATCH /workers/:id. @api machine-0010 */
export const updateWorkerRequestSchema = z.object({
  name: z.string().min(1).max(100).optional(),
});
export type UpdateWorkerRequest = z.infer<typeof updateWorkerRequestSchema>;

/** Body PUT /machine-links/:id/physic-project (machine-0011 — upsert 1:1). */
export const putPhysicProjectRequestSchema = z.object({
  projectId: z.string().guid(),
  /** null/empty ⇒ pending — the folder is finalized in wizard step 2. */
  path: z.string().min(1).max(500).nullable().optional(),
  name: z.string().max(100).optional(),
});
export type PutPhysicProjectRequest = z.infer<
  typeof putPhysicProjectRequestSchema
>;

/** Body PATCH /machine-links/:id/physic-project. @api machine-0012 */
export const patchPhysicProjectRequestSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  projectId: z.string().guid().optional(),
  isAutonomous: z.boolean().optional(),
  disabled: z.boolean().optional(),
});
export type PatchPhysicProjectRequest = z.infer<
  typeof patchPhysicProjectRequestSchema
>;

/** Query GET /machine-links — BaseRequest + filter status. */
export const listMachineLinksQuerySchema = baseRequestSchema.extend({
  status: z.string().max(20).optional(),
});
export type ListMachineLinksQuery = z.infer<typeof listMachineLinksQuerySchema>;

/** Body PATCH /machine-links/:id — hashcode (3) TTL; null = never-expiring. */
export const updateMachineLinkRequestSchema = z.object({
  hashcode3ExpiresAt: z.string().datetime().nullable(),
});
export type UpdateMachineLinkRequest = z.infer<
  typeof updateMachineLinkRequestSchema
>;

/** One entry in a worker directory listing. @api machine-0007 */
export interface FsEntry {
  name: string;
  type: "dir" | "file";
}

/** Data GET /machines/:id/fs — a directory listing on the worker. */
export interface FsListResponse {
  /** Normalized absolute path on the worker. */
  path: string;
  entries: FsEntry[];
}

/** Data GET /machines/:id/file — a text file's content on the worker (project dashboard). */
export interface FsReadResponse {
  path: string;
  /** UTF-8 content (empty when unreadable). */
  content: string;
  /** Content was capped at the size limit. */
  truncated: boolean;
}

/** Data GET /machines/:id/config — the paired profile's config.json as text. @api machine-0025 @adr 0141 */
export interface ConfigReadResponse {
  /** config.json content as pretty-printed text (empty-defaults when the file is absent). */
  config: string;
}

/** Data PUT /machines/:id/config — result of replacing the profile's config.json. @api machine-0026 */
export interface ConfigWriteResponse {
  /** True when written; false with `error` when the submitted text is invalid JSON / bad shape. */
  ok: boolean;
  error?: string;
}

/** Status of one worker tool on the machine (Tools tab). @api machine-0050 @adr 0206 */
export interface WorkerToolStatus {
  /** Catalog id or npm package name. */
  id: string;
  label: string;
  category: "runtime" | "ai-cli" | "vcs";
  installed: boolean;
  version: string | null;
  /** False for a detect-only prerequisite (no install/uninstall button). */
  installable: boolean;
  /** True when the tool offers update-to-latest (npm-distributed catalog tool or extra). @adr 0252 */
  updatable: boolean;
  /** True when this tool is flagged for per-tool auto-update in the worker `config.json`. @adr 0253 */
  autoUpdate: boolean;
}

/**
 * Data GET /machines/:id/tools — the default catalog + extra global packages. Since
 * ADR-0254 this is read from the DB `MachineLink.toolSnapshot` (not a live probe), so an offline
 * worker still returns its last-synced set; `checkedAt`/`online` drive the panel's staleness + Refresh.
 * @api machine-0050
 */
export interface WorkerToolsResponse {
  catalog: WorkerToolStatus[];
  extras: WorkerToolStatus[];
  /** When the worker last reported this snapshot; null when it never has. @adr 0254 */
  checkedAt: string | null;
  /** Whether the worker is currently online — Refresh (live re-detect + report) is enabled only then. */
  online: boolean;
  /**
   * Tools that failed the last restore reconcile — drives the "Restore tools" button's red
   * count + failed line. Empty/absent when the last restore fully satisfied the recorded snapshot.
   * @adr 0258
   */
  restoreFailed?: ToolRestoreFailure[];
}

/** One tool to reconcile to an exact version on boot / copy-apply. @adr 0254 */
export interface ToolManifestEntry {
  /** Catalog id or npm package name. */
  name: string;
  /** Exact version to (re)install — `npm i -g <name>@<version>`. */
  version: string;
  /** Manager used to (re)install it. */
  manager: "npm" | "pnpm";
}

/**
 * Why a tool failed to reconcile to its recorded version during a restore. `retryable`
 * marks a transient cause (timeout/network) the server may re-drive; a permanent one (`not-found`
 * /`engine`) is surfaced for a human and never auto-re-driven.
 * @adr 0258
 */
export type ToolRestoreFailReason = "timeout" | "network" | "not-found" | "engine" | "other";
export interface ToolRestoreFailure {
  /** Catalog id or npm package name that stayed missing/mismatched after the reconcile. */
  name: string;
  /** The exact version the restore tried to install. */
  version: string;
  /** Classified cause of the failure (drives the panel's red line + the server re-drive). */
  reason: ToolRestoreFailReason;
  /** True when the cause is transient (server may re-drive on the daily tick); false = permanent. */
  retryable: boolean;
}

/**
 * Persisted worker tool snapshot — the JSON stored in `MachineLink.toolSnapshot`: the last
 * detected set the worker reported. Drives the DB-backed Tools panel and is the restore-on-boot target.
 * @adr 0254
 */
export interface WorkerToolSnapshot {
  catalog: WorkerToolStatus[];
  extras: WorkerToolStatus[];
  /**
   * Tools that stayed missing/mismatched after the last restore reconcile — transient,
   * cleared to empty on a report where every manifest entry is satisfied. Drives the "Restore tools"
   * button's red count + line and the server's daily re-drive.
   * @adr 0258
   */
  restoreFailed?: ToolRestoreFailure[];
}

/**
 * Restore payload seeded to the cli on `ws_token`: the self-restore manifest derived from
 * the last reported snapshot (installed npm-distributed tools at their exact versions) + the per-tool
 * auto-update flags for the daily tick. `null` when the server has no snapshot for this link yet.
 * @adr 0254
 */
export interface WorkerToolRestorePush {
  manifest: ToolManifestEntry[];
  /** Catalog ids / extra names flagged for per-tool auto-update (ADR-0253, now DB-stored). */
  autoUpdate: string[];
}

/**
 * Body POST /machines/tools/copy — copy one machine user's tool set (at its versions) onto
 * others. Validated: a source link + ≥1 distinct target links (all in the caller's org).
 * @adr 0254
 */
export const workerToolCopySchema = z.object({
  /** Source machine-link id whose `toolSnapshot` supplies the manifest. */
  sourceLinkId: z.string().guid(),
  /** Target machine-link ids to queue the manifest for (pushed on their next connect). */
  targetLinkIds: z.array(z.string().guid()).min(1).max(200),
});
export type WorkerToolCopyRequest = z.infer<typeof workerToolCopySchema>;

/** Per-target outcome of a tools copy: the manifest is queued on the target, and the web
 * then drives a streamed restore for the online ones so progress streams per target.
 * @api machine-0053 @adr 0254
 */
export type WorkerToolCopyTargetStatus =
  /** Manifest queued + target online — the web drives a streamed restore now (progress streams). */
  | "online"
  /** Manifest queued but the target is offline — it applies on its next connect (no live stream). */
  | "queued"
  /** Target skipped (no host-tooling access, rented/pool, or the source itself). */
  | "skipped";

/** Data POST /machines/tools/copy — the per-target outcome so the web can render a progress board. */
export interface WorkerToolCopyResponse {
  results: { targetLinkId: string; status: WorkerToolCopyTargetStatus }[];
}

/** Body POST /admin/pool-users/tools/copy — copy one pool machine's tool set onto other
 * pool machines of the **same role** (rented↔rented / support↔support). Keyed by pool-user id.
 * @adr 0307
 */
export const adminPoolToolsCopySchema = z.object({
  sourceUserId: z.string().guid(),
  targetUserIds: z.array(z.string().guid()).min(1).max(200),
});
export type AdminPoolToolsCopyRequest = z.infer<typeof adminPoolToolsCopySchema>;

/** Data POST /admin/pool-users/tools/copy — per-target outcome (keyed by pool-user id), same statuses
 * as the org copy: `online` (admin then drives a buffered restore), `queued` (offline), `skipped`. */
export interface AdminPoolToolsCopyResponse {
  results: { targetUserId: string; status: WorkerToolCopyTargetStatus }[];
}

/** Body POST /machines/:id/tools/install — install a tool. @api machine-0051 @adr 0206 */
export const workerToolInstallSchema = z.object({
  /** Catalog id or npm package name (validated npm-name shape on the cli). */
  name: z.string().trim().min(1).max(214),
  /** Package manager to run the global install with. */
  manager: z.enum(["npm", "pnpm"]),
});
export type WorkerToolInstallRequest = z.infer<typeof workerToolInstallSchema>;

/** Body PUT /machines/:id/tools/auto-update — toggle per-tool auto-update. @api machine-0056 @adr 0253 */
export const workerToolAutoUpdateSchema = z.object({
  /** Catalog id or installed extra's npm package name. */
  name: z.string().trim().min(1).max(214),
  /** true = flag this tool for auto-update to @latest; false = clear it. */
  enabled: z.boolean(),
});
export type WorkerToolAutoUpdateRequest = z.infer<typeof workerToolAutoUpdateSchema>;

/** Data PUT /machines/:id/tools/auto-update — whether the flag was persisted. @api machine-0056 */
export interface WorkerToolAutoUpdateResponse {
  ok: boolean;
}

/** Data POST install / DELETE uninstall — the streamed op id to subscribe to (machine-0051/0052). */
export interface WorkerToolOpResponse {
  /** Correlates the SSE progress stream. @api machine-0053 */
  opId: string;
}

/** One SSE frame of a worker-tools install/uninstall op. @api machine-0053 @adr 0206 */
export type WorkerToolProgressEvent =
  | { type: "line"; line: string }
  | { type: "done"; ok: boolean; exitCode: number; error?: string };

/**
 * Buffered result of a worker-tools op (admin-0061/0062) — the admin S2S chain runs the
 * op server-side and returns the collected output at once (no SSE proxy through admin-bff).
 * @adr 0206
 */
export interface WorkerToolOpResult {
  ok: boolean;
  exitCode: number;
  lines: string[];
  error?: string;
}

/** Body PUT /machines/:id/config — the new config.json as text (validated JSON on the cli). */
export const configWriteRequestSchema = z.object({
  config: z.string().max(256 * 1024),
});
export type ConfigWriteRequestBody = z.infer<typeof configWriteRequestSchema>;

/** Max bytes accepted by a fs.write — mirrors the cli-side cap. @api machine-0027 */
export const FILE_WRITE_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Body PUT /machines/:id/file — write a file on the worker, physic-root-clamped (machine-0027,
 * ADR-0151). Used by the Git tab's manual conflict resolution (`project.git_write`).
 */
export const fsWriteRequestSchema = z.object({
  /** Path relative to the physic-project root; a `..` escaping the root is rejected on the cli. */
  path: z.string().min(1).max(1024),
  /** Full new UTF-8 content (replaces the file wholesale). */
  content: z.string().max(FILE_WRITE_MAX_BYTES),
});
export type FsWriteRequestBody = z.infer<typeof fsWriteRequestSchema>;

/** Data PUT /machines/:id/file — result of the worker write. @api machine-0027 */
export interface FsWriteResponse {
  /** The resolved (clamped) path written. */
  path: string;
  /** Bytes written. */
  bytes: number;
}

/**
 * Body POST /machines/:id/fs/mutate — create/rename/move/delete a file or folder in the project
 * tree, each op physic-root-clamped (machine-0059, ADR-0260, `project.files_write`).
 */
export const fsMutateRequestSchema = z.object({
  op: z.enum(["mkdir", "create", "move", "delete"]),
  path: z.string().max(1024).optional(),
  content: z.string().max(FILE_WRITE_MAX_BYTES).optional(),
  from: z.string().max(1024).optional(),
  to: z.string().max(1024).optional(),
});
export type FsMutateRequestBody = z.infer<typeof fsMutateRequestSchema>;

/** Data POST /machines/:id/fs/mutate — result of the worker mutation. @api machine-0059 */
export interface FsMutateResponse {
  /** The resolved (clamped) path acted on. */
  path: string;
}

/**
 * Max raw bytes accepted for a single upload/download transfer (machine-0061/0062).
 * Enforced on both ends (server rejects an over-cap upload; the cli refuses an over-cap download)
 * and pre-checked in the browser. Bounds the WS-frame size + base64 memory blow-up on both hops.
 * @adr 0278
 */
export const FS_TRANSFER_MAX_BYTES = 10 * 1024 * 1024;

/** Max base64 characters for a transfer (raw cap × 4/3, rounded up + padding slack). */
const FS_TRANSFER_MAX_BASE64 = Math.ceil((FS_TRANSFER_MAX_BYTES * 4) / 3) + 16;

/**
 * Body POST /machines/:id/fs/upload — write an uploaded/pasted file into the project tree, physic-
 * root-clamped (machine-0061, ADR-0278, `project.files_write`). Bytes ride as base64 (binary the
 * text-only fs.write can't carry).
 */
export const fsUploadRequestSchema = z.object({
  /** Destination path relative to the physic-project root; a `..` escaping the root is rejected on the cli. */
  path: z.string().min(1).max(1024),
  /** File bytes, base64-encoded (capped to the transfer limit). */
  contentBase64: z.string().min(1).max(FS_TRANSFER_MAX_BASE64),
  /** Optional MIME type from the browser (informational). */
  contentType: z.string().max(255).optional(),
});
export type FsUploadRequestBody = z.infer<typeof fsUploadRequestSchema>;

/** Data POST /machines/:id/fs/upload — result of the worker upload. @api machine-0061 */
export interface FsUploadResponse {
  /** The resolved (clamped) path written. */
  path: string;
  /** Bytes written. */
  bytes: number;
}

/** Data GET /machines/:id/fs/download — a file's raw bytes for the browser to save. @api machine-0062 */
export interface FsDownloadResponse {
  /** File bytes, base64-encoded. */
  contentBase64: string;
  /** Best-effort MIME type guessed from the extension. */
  contentType: string;
  /** The file's basename (for the save dialog). */
  name: string;
  /** Raw byte size. */
  size: number;
}

/**
 * Body POST /machines/:id/tasks/approve — approve/unapprove one AI Todo task (machine-0060,
 * ADR-0259 #3). Writes `.autonomous.approvals.json` with the approver (server-filled trace); gated by
 * `project.task_approve`. Reuses the autonomous `approvals` write on the cli.
 */
export const taskApproveRequestSchema = z.object({
  taskId: z.string().min(1).max(64),
  approved: z.boolean(),
});
export type TaskApproveRequestBody = z.infer<typeof taskApproveRequestSchema>;

/**
 * One task in a batch approve: its id plus the catalog tags it carries (read by the web
 * from the `AI_TODO.md` `Tag` column). Tags are validated as free strings here and filtered to the
 * known `AiTaskTag` catalog server-side (an unknown/legacy token maps to no handler and is dropped).
 * @adr 0311
 */
export const taskApproveEntrySchema = z.object({
  taskId: z.string().min(1).max(64),
  tags: z.array(z.string().min(1).max(64)).max(16).default([]),
});
export type TaskApproveEntry = z.infer<typeof taskApproveEntrySchema>;


/** Data POST /machines/:id/tasks/approve-batch — the batch outcome. @api machine-0063 @adr 0311 */
export interface TaskApproveBatchResponse {
  /** True when every tag action ran and the approvals were committed. */
  ok: boolean;
  /** When `!ok` and a tag action failed: the offending task id (nothing was written). */
  failedTaskId?: string;
  /** When `!ok`: a short reason (English; the web maps its own message). */
  reason?: string;
}

// ── Book evidence (ADR-0404) ─────────────────────────────────────────────────────────────────────

/** Per-file cap of a book evidence file (plain git — keep the history lean). */
export const EVIDENCE_MAX_BYTES = 5 * 1024 * 1024;
/** Max new evidence files committed by one book save. */
export const EVIDENCE_MAX_PER_SAVE = 20;
/** Default repo-relative root of book evidence files (configurable per worker — `evidenceDir`). @adr 0418 */
export const EVIDENCE_ROOT = ".4pm/evidence";
/** Default repo-relative folder of intake UI mockups (`mockupDir`). @adr 0418 */
export const MOCKUP_ROOT = ".4pm/mockups";
/** The evidence folder of each book (by its `bookSave` key). */
export const EVIDENCE_BOOK_DIR = { userTodo: "USER_TODO", userQa: "USER_QA", aiTodo: "AI_TODO", aiDone: "AI_DONE" } as const;
export type EvidenceBookKey = keyof typeof EVIDENCE_BOOK_DIR;
/**
 * A safe repo-relative folder (`evidenceDir` / `mockupDir`): `[A-Za-z0-9._-]` segments separated by
 * `/`, no `.`/`..` segment, no leading/trailing `/`, not inside `.git`.
 * @adr 0418
 */
export function isSafeRepoDir(dir: string): boolean {
  if (!/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(dir) || dir.length > 200) return false;
  const segs = dir.split("/");
  return !segs.some((s) => s === "." || s === "..") && segs[0] !== ".git";
}
/** A safe repo-relative file path (machine-0073 query): a safe folder + a file name. */
export const SAFE_REPO_PATH_RE = /^(?!\.git\/)(?!.*(?:^|\/)\.{1,2}\/)[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+){0,15}$/;
/**
 * A valid evidence path under ANY root (ADR-0418 — links keep working after `evidenceDir` changes):
 * `<root>/<BOOK>/<ROW-ID>/<file>` (groups: root, book, row id, file).
 */
export const EVIDENCE_PATH_RE =
  /^((?:[A-Za-z0-9._-]+\/){0,8}?[A-Za-z0-9._-]+)\/(USER_TODO|USER_QA|AI_TODO|AI_DONE)\/([A-Z]+-\d{4}-\d{4})\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/;

/**
 * Body POST /machines/:id/tasks/approve-batch — commit a Save's pending approvals atomically.
 * `approvals` are the tasks to approve (with their tags), `unapprovals` the
 * ids to drop. A tag action (e.g. `UpdateSpecFromDB`) targets the project root — the root IS the repo
 * (single-repo). The server runs every tag action first and, only on full success, writes
 * the approvals batch; any action failure ⇒ nothing is written (the user re-approves). Gated by
 * `project.task_approve`.
 * @api machine-0063 @adr 0311 @adr 0314
 */
export const taskApproveBatchRequestSchema = z.object({
  approvals: z.array(taskApproveEntrySchema).max(500).default([]),
  unapprovals: z.array(z.string().min(1).max(64)).max(500).default([]),
  /**
   * The `AI_TODO.md` being saved with these approvals — written in the SAME cli write, so each
   * approval is signed over the content the approver saved and the editor counts as a row's author
   * for separation of duties. Absent ⇒ approvals only, signed over the current `<base>` book.
   * @adr 0438
   */
  book: z
    .object({
      content: z.string().max(256 * 1024),
      evidence: z
        .array(z.object({ stageId: z.string().guid(), path: z.string().regex(EVIDENCE_PATH_RE) }))
        .max(EVIDENCE_MAX_PER_SAVE)
        .optional(),
    })
    .optional(),
});
export type TaskApproveBatchRequestBody = z.infer<typeof taskApproveBatchRequestSchema>;
/** A markdown link / image whose target is an evidence path under any root (groups: `!`, label, path). */
const EVIDENCE_LINK_RE =
  /(!?)\[([^\]\n]*)\]\(<?((?:[A-Za-z0-9._-]+\/){1,9}(?:USER_TODO|USER_QA|AI_TODO|AI_DONE)\/[A-Z]+-\d{4}-\d{4}\/[A-Za-z0-9][A-Za-z0-9._-]{0,127})>?\)/g;

/** True when `path` is an evidence path that is safe to read/write (any root, no `..` / `.git`). */
export function isEvidencePath(path: string): boolean {
  const m = EVIDENCE_PATH_RE.exec(path);
  return Boolean(m && isSafeRepoDir(m[1] ?? ""));
}

/** One evidence link found in a cell. */
export interface EvidenceLink {
  /** The whole markdown link text (to strip it). */
  markdown: string;
  label: string;
  path: string;
  /** Written as an image (`![…](…)`). */
  image: boolean;
}

/** Slug a file name for an evidence path (`[A-Za-z0-9._-]`, ≤ 100 chars, never empty). */
export function evidenceSlug(name: string): string {
  const s = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[đĐ]/g, (c) => (c === "đ" ? "d" : "D"))
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|-+$/g, "");
  return (s || "file").slice(-100);
}

/** The repo path of the `k`-th evidence file of a row under the evidence `root`. @adr 0418 */
export function evidencePath(root: string, book: EvidenceBookKey, rowId: string, k: number, name: string): string {
  return `${root}/${EVIDENCE_BOOK_DIR[book]}/${rowId}/${k}-${evidenceSlug(name)}`;
}

/** The markdown for an evidence file — an image link for images, a plain link otherwise. */
export function evidenceMarkdown(name: string, path: string, mime: string): string {
  const label = name.replace(/[[\]\n]/g, " ").trim() || "file";
  return `${mime.startsWith("image/") ? "!" : ""}[${label}](${path})`;
}

/** Every evidence link in `text`, in order. */
export function evidenceLinks(text: string): EvidenceLink[] {
  return [...text.matchAll(EVIDENCE_LINK_RE)].map((m) => ({
    markdown: m[0],
    image: m[1] === "!",
    label: m[2] ?? "",
    path: m[3] ?? "",
  }));
}

/** Next free 1-based file number for a row folder, from the `<k>-…` names already referenced in `text`. */
export function nextEvidenceNumber(text: string, folder: string): number {
  let max = 0;
  for (const l of evidenceLinks(text)) {
    if (!l.path.startsWith(`${folder}/`)) continue;
    const k = Number(/^(\d+)-/.exec(l.path.slice(folder.length + 1))?.[1] ?? 0);
    max = Math.max(max, k);
  }
  return max + 1;
}

/** Query GET /machines/:id/autonomous/evidence — read one committed evidence file. @api machine-0073 */
export const autonomousEvidenceQuerySchema = z.object({
  // Any safe repo path — the cli decides what may be read (an evidence path or a mockup — ADR-0418).
  path: z.string().max(400).regex(SAFE_REPO_PATH_RE),
  // A task branch to fall back to (an AI Done row whose PR is not merged yet).
  ref: z.string().regex(/^[A-Za-z0-9._/-]{1,200}$/).optional(),
});
export type AutonomousEvidenceQuery = z.infer<typeof autonomousEvidenceQuerySchema>;

/** Response of machine-0072 — the staged file's handle for the next `bookSave.evidence`. */
export interface AutonomousEvidenceStageResponse {
  stageId: string;
  name: string;
  size: number;
}

/**
 * Body PUT /machines/:id/autonomous — a discriminated write to the autonomous engine.
 * The **author** (`by`) is filled by the server from the
 * authenticated user (trace, not client-supplied) before forwarding to the cli.
 * @api machine-0029 @adr 0152
 */
export const autonomousWriteRequestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("settings"), settings: z.string().max(64 * 1024) }),
  z.object({ kind: z.literal("approvals"), taskId: z.string().min(1).max(64), approved: z.boolean() }),
  // Batched approvals (ADR-0311): commit many approve/unapprove ids in ONE approvals-file write, so a
  // Save's coupled batch lands atomically. Constructed by the server after its tag actions succeed.
  z.object({
    kind: z.literal("approvalsBatch"),
    approve: z.array(z.string().min(1).max(64)).max(500),
    unapprove: z.array(z.string().min(1).max(64)).max(500),
  }),
  z.object({ kind: z.literal("userTodo"), content: z.string().min(1).max(16 * 1024) }),
  // Traced book save (ADR-0320): the cli diffs rows by id + stamps `.autonomous.authors.json` so
  // authorship is server-filled, not a spoofable `.md` cell. `by`/author are added server-side.
  z.object({
    kind: z.literal("bookSave"),
    // `aiDone` = the AI Verify verdict column on the read-only AI Done (ADR-0400): no authorship, no cap.
    book: z.enum(["userTodo", "userQa", "aiTodo", "aiDone"]),
    content: z.string().max(256 * 1024),
    // Staged evidence files (machine-0072) to commit with the book (ADR-0404); each path must sit under
    // the saved book's own `.4pm/evidence/<BOOK>/` folder (the cli re-checks).
    evidence: z
      .array(z.object({ stageId: z.string().guid(), path: z.string().regex(EVIDENCE_PATH_RE) }))
      .max(EVIDENCE_MAX_PER_SAVE)
      .optional(),
    // Approvals committed with this save (ADR-0438): signed by the server over the saved content; the
    // cli applies them only after stamping this save's authorship (the editor is the author for SoD).
    approve: z.array(z.string().min(1).max(64)).max(500).optional(),
    unapprove: z.array(z.string().min(1).max(64)).max(500).optional(),
  }),
  // (The `cron` install/uninstall kind was retired by ADR-0392 — the cli daemon schedules ticks itself.)
]);
export type AutonomousWriteBody = z.infer<typeof autonomousWriteRequestSchema>;

/** Query GET /machines/:id/autonomous/logs — one day's tick log. @api machine-0030 @adr 0152 */
export const autonomousLogsQuerySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});
export type AutonomousLogsQuery = z.infer<typeof autonomousLogsQuerySchema>;

/** A subagent/skill name — safe file/dir stem (no traversal). */
const agentNameSchema = z.string().min(1).max(64).regex(/^[\w.-]+$/);

/** Query GET /machines/:id/agents/item — read one subagent/skill. @api machine-0032 @adr 0153 */
export const agentReadQuerySchema = z.object({
  kind: z.enum(["subagent", "skill"]),
  name: agentNameSchema,
});
export type AgentReadQuery = z.infer<typeof agentReadQuerySchema>;

/** Body POST /machines/:id/rag/install — install a worker-tuned RAG model. @api machine-0038 @adr 0156 */
export const ragInstallRequestSchema = z.object({
  model: z.string().min(1).max(200),
});
export type RagInstallBody = z.infer<typeof ragInstallRequestSchema>;

/** Query GET /machines/:id/rag/query — semantic search over the index. @api machine-0040 @adr 0157 */
export const ragQueryQuerySchema = z.object({
  q: z.string().min(1).max(2000),
  k: z.coerce.number().int().min(1).max(20).optional(),
});
export type RagQueryQuery = z.infer<typeof ragQueryQuerySchema>;

/** Query GET /machines/:id/graph — build the docs/code dependency graph. @api machine-0036 @adr 0155 */
export const graphBuildQuerySchema = z.object({
  mode: z.enum(["docs", "code"]),
});
export type GraphBuildQuery = z.infer<typeof graphBuildQuerySchema>;

/** A placeholder/secret key — safe key stem. */
const secretKeySchema = z.string().min(1).max(128).regex(/^[\w.-]+$/);

/**
 * Body PUT /machines/:id/secrets — manage security docs + write-only secrets (machine-0035,
 * ADR-0154). A secret `value` is write-only: it is never returned by any read.
 */
export const secretsWriteRequestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("security"), content: z.string().max(128 * 1024) }),
  z.object({ kind: z.literal("placeholder"), content: z.string().max(128 * 1024) }),
  z.object({ kind: z.literal("secret"), key: secretKeySchema, value: z.string().max(8192) }),
  z.object({ kind: z.literal("secretDelete"), key: secretKeySchema }),
]);
export type SecretsWriteBody = z.infer<typeof secretsWriteRequestSchema>;

/** Body PUT /machines/:id/agents — create/edit or delete a subagent/skill. @api machine-0033 @adr 0153 */
export const agentWriteRequestSchema = z
  .object({
    kind: z.enum(["subagent", "skill"]),
    name: agentNameSchema,
    action: z.enum(["write", "delete"]),
    content: z.string().max(128 * 1024).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.action === "write" && (v.content === undefined || v.content.length === 0)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["content"], message: "content is required for write" });
    }
  });
export type AgentWriteBody = z.infer<typeof agentWriteRequestSchema>;

/** A single Claude tool-permission rule (e.g. `Bash(git status)`, `Read(./src/**)`). */
const toolRuleSchema = z.string().min(1).max(500);
/**
 * The `permissions` block of a Claude settings file. Headless-only: `ask` is
 * gone and `defaultMode` is effectively always `bypassPermissions` — the enum stays tolerant of an
 * older client's value (the cli coerces to `bypassPermissions` on write); a stray `ask` key is
 * stripped by the non-strict object.
 * @adr 0183 @adr 0328
 */
const agentToolsPermissionsSchema = z.object({
  defaultMode: z.enum(["default", "acceptEdits", "plan", "bypassPermissions"]),
  allow: z.array(toolRuleSchema).max(500),
  deny: z.array(toolRuleSchema).max(500),
});

/** Query GET /machines/:id/agent-tools — which settings file to read. @api machine-0044 @adr 0183 */
export const agentToolsReadQuerySchema = z.object({
  scope: z.enum(["shared", "local"]),
});
export type AgentToolsReadQuery = z.infer<typeof agentToolsReadQuerySchema>;

/** Body PUT /machines/:id/agent-tools — replace a permissions block. @api machine-0045 @adr 0183 */
export const agentToolsWriteRequestSchema = z.object({
  scope: z.enum(["shared", "local"]),
  permissions: agentToolsPermissionsSchema,
});
export type AgentToolsWriteBody = z.infer<typeof agentToolsWriteRequestSchema>;

/**
 * Data GET /machines/:id/diff — old (HEAD) vs current content of a file. Text files ride in
 * `oldContent`/`newContent` (Monaco diff); binary files (images) set `isBinary` and ride as base64
 * so the dashboard can render an image before/after. Mirrors the cli `GitDiffReply`.
 * @adr 0282
 */
export interface GitDiffResponse {
  path: string;
  oldContent: string;
  newContent: string;
  /** True when the file is binary: the text fields are empty and the bytes ride in `*Base64`. */
  isBinary?: boolean;
  /** Best-effort MIME type (binary only), for the `data:` URL the dashboard builds. */
  contentType?: string;
  /** HEAD bytes, base64 (binary only; empty for an untracked/new or over-cap file). */
  oldContentBase64?: string;
  /** Working-tree bytes, base64 (binary only; empty for a deleted/unreadable or over-cap file). */
  newContentBase64?: string;
}

/** Data GET /machines/:id/git/repos — a git repo found under the physic project. @api machine-0021 */
export interface GitRepoRef {
  /** Relative subdir under the physic project root ("" = root/primary repo). */
  subdir: string;
  name: string;
  remote: string | null;
  /** Current checked-out branch, when resolvable — null otherwise. */
  branch?: string | null;
}

/** One commit in the history. @api machine-0022 */
export interface GitLogEntry {
  hash: string;
  shortHash: string;
  author: string;
  date: string;
  subject: string;
}

/** Data GET /machines/:id/git/log — a page of commit history. @api machine-0022 */
export interface GitLogResponse {
  entries: GitLogEntry[];
  hasMore: boolean;
}

/** A file changed in a commit. @api machine-0023 */
export interface GitCommitFile {
  path: string;
  status: string;
  oldPath?: string;
}

/** Data GET /machines/:id/git/commit — a commit + its changed files. @api machine-0023 */
export interface GitCommitResponse {
  hash: string;
  author: string;
  date: string;
  subject: string;
  files: GitCommitFile[];
}

/** Data GET /machines/:id/git-env — worker git + AI CLI environment. @api machine-0008 */
export interface GitEnvResponse {
  /** The `gh`/`glab` CLI is present on the worker. */
  installed: boolean;
  /** Logged into the provider. */
  authenticated: boolean;
  /** The logged-in account, when known. */
  account: string | null;
  /** The Claude CLI is present (prerequisite for AI init). */
  claudeCli: boolean;
}

/**
 * Data GET/POST/DELETE /machines/:id/ssh-key (machine-0041/0042/0043) — the ssh deploy key
 * of a **rented** machine-user, generated on its worker. The private key never
 * leaves the worker; only the public key + fingerprint are returned. `publicKey` is `null`
 * when none has been generated.
 * @adr 0173
 */
export interface SshDeployKeyResponse {
  /** The OpenSSH public key present on the worker, or `null` when none exists. */
  publicKey: string | null;
  /** SHA256 fingerprint of the key, when present. */
  fingerprint: string | null;
}

/** The AI providers a model list can be asked for — mirrors the cli's `AiProvider`. @adr 0394 */
export const AI_MODEL_PROVIDERS = ["claude", "codex", "antigravity"] as const;
export type AiModelProvider = (typeof AI_MODEL_PROVIDERS)[number];

/**
 * Query of the ai-models endpoints — provider, default claude.
 * @api template-0013 @api machine-0071 @api project-0082
 */
export const aiModelsQuerySchema = z.object({
  provider: z.enum(AI_MODEL_PROVIDERS).optional().default("claude"),
});
export type AiModelsQuery = z.infer<typeof aiModelsQuerySchema>;

/** One model the worker's AI CLI supports — `value` is what goes into `--model` / settings. @adr 0394 */
export interface AiModelOption {
  /** Alias or id the CLI accepts (`default`, `opus`, `claude-opus-5`…). */
  value: string;
  /** The concrete model the alias resolves to, when the CLI reports it. */
  resolvedModel: string | null;
  /** Human label (`Opus 5.5`). */
  displayName: string;
  /** One-line description from the CLI. */
  description: string;
}

/** Data of the ai-models endpoints — the CLI's own list, `error` when it couldn't be read. @adr 0394 */
export interface AiModelsResponse {
  provider: AiModelProvider;
  models: AiModelOption[];
  /** The provider's CLI is not installed on the worker. @adr 0396 */
  cliMissing: boolean;
  /** The worker is installing that CLI now — poll again. @adr 0396 */
  installing: boolean;
  error: string | null;
}
