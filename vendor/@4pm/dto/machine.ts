/**
 * DTO for the machine link + worker + physic project domain
 * (21-api/machine-0001…0013).
 */
import { z } from "zod";
import type {
  MachineLinkScope,
  PhysicProjectStatus,
  WorkerStatus,
} from "@4pm/constants";
import { hexTokenSchema } from "@4pm/validation";
import { baseRequestSchema } from "./base";
import type { CommandOrigin } from "./command";
import type { GitAuthMethod, ProjectSandboxSettings, ProjectTokenSettings } from "./project";

/** Body POST /machine-links/pair (machine-0001). */
export const pairRequestSchema = z.object({
  hashcode1: hexTokenSchema,
  userId: z.string().uuid().optional(),
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
 *  profile by userId (ADR-0047). */
export interface ConfirmResponse {
  hashcode3: string;
  userId: string;
  username: string;
  /** Link scope (project | orchestrator — ADR-0010); the cli stores it in `.cre`. */
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

/** Body POST /machine-links/provisioning-token (ADR-0192 §6) — issue a headless-pairing token. */
export const issueProvisioningTokenRequestSchema = z.object({
  machineLinkId: z.string().uuid(),
  /** TTL seconds (0/absent ⇒ a default short TTL applied server-side). */
  ttlSec: z.number().int().min(0).max(2_592_000).optional(),
});
export type IssueProvisioningTokenRequest = z.infer<typeof issueProvisioningTokenRequestSchema>;

/** Data POST /machine-links/provisioning-token — the plaintext token (shown once) + expiry. */
export interface IssueProvisioningTokenResponse {
  token: string;
  expiresAt: string | null;
}

/** 200 data of token. */
export interface WsTokenResponse {
  wsToken: string;
  wsTokenExpiresAt: string;
  /** Link scope (project | orchestrator — ADR-0010); the cli heals its `.cre` from this. */
  scope: string;
  /**
   * Org-configured cap (seconds) on the cli's reconnect backoff (ADR-0056). The cli
   * uses this over its local env var; absent ⇒ the cli falls back to env/default.
   */
  reconnectMaxBackoffSec: number;
  /** Org toggle for the daily scheduled cli auto-update (ADR-0074). */
  autoUpdateDaily: boolean;
  /** Hour of day (0–23) the daily update runs, in the org `timezone` below (ADR-0074). */
  autoUpdateHour: number;
  /** Org timezone (IANA) the cli uses to resolve `autoUpdateHour` to local time (ADR-0074). */
  timezone: string;
  /**
   * cli data-retention window (days) for this machine user (ADR-0115) — the cli prunes its
   * logs / command-history / command-output older than this. `0` = keep the cli defaults.
   * Capped server-side at the plan's `retentionDays`.
   */
  cliRetentionDays: number;
  /**
   * Runtime token knobs of the project this link serves (ADR-0081), pushed so the cli can
   * rotate its Claude profile on session pressure and cap per-prompt tokens. `null` for
   * orchestrator links or a project cli not yet attached to a physic project. Budgets
   * (project/cli token limits) are NOT here — the cli learns them via `quota.check`.
   */
  projectTokens: ProjectTokenSettings | null;
  /**
   * Folder-scope hardening of the project this link serves (ADR project aiScope). When
   * true the cli prepends a guard to every AI prompt telling the agent to only use content
   * inside the served project folder. `false` for orchestrator/idle links or when the
   * project has it off.
   */
  aiRestrictToFolder: boolean;
  /**
   * Sandbox egress policy of the project this link serves (ADR-0192 §3). When `network:'allowlist'`
   * the containerized worker's egress is bounded to `allowedDomains`; the cli materializes it for
   * the container's egress enforcement. `null` for orchestrator/idle links or when `network:'open'`.
   */
  aiSandbox: ProjectSandboxSettings | null;
  /**
   * Git-auth method of the project this link serves (ADR-0192 §4) — tells the worker how to
   * authenticate git (`self`/`deploy-key` need no token config; `gitlab-group-token`/`github-app`
   * configure an injected/minted token for HTTPS). `null` for orchestrator/idle links or `self`.
   */
  gitAuth: GitAuthMethod | null;
  /**
   * Outbound-review policy of the project this link serves (ADR-0082). Tells the cli to
   * require an outbound review before spawning AI (`enabled`), which engines to run, and
   * whether THIS link is itself an outbound reviewer (`isOutbound`). `null` when the
   * project has no review policy or the link serves no project.
   */
  outboundReview: OutboundReviewCliPolicy | null;
  /**
   * This link's machine-user username (ADR-0097) — the cli's git commit author for the
   * served project. Push uses the account the worker is already logged in with (gh/glab).
   */
  machineUsername: string;
  /**
   * WebSocket base URL the cli should connect to (ADR-0131 phase 3 cutover). When present,
   * the cli opens `<wsUrl>/ws` on `@4pm/cli-server` instead of the server gateway and heals
   * it into `.cre`. Absent ⇒ the cli keeps using its `serverUrl` (old behaviour / server
   * gateway), so both gateways run in parallel during the migration.
   */
  wsUrl?: string;
}

/** Outbound-review policy delivered to a cli via ws_token (ADR-0082). */
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
  /** Link scope (project | orchestrator — ADR-0010). */
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
  createdAt: string;
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

/** A cli node in the worker tree (machine-0009). */
export interface WorkerMachineLinkNode {
  id: string;
  userId: string;
  username: string;
  /** Link scope (project | orchestrator — ADR-0010). Orchestrator clis don't serve a
   *  physic project, so the web hides the attach-folder UI for them. */
  scope: string;
  connected: boolean;
  /** null if the cli has no physic project attached. */
  physicProject: PhysicProjectResponse | null;
}

/** Worker (physical machine) + the cli → physic project tree (machine-0009). */
export interface WorkerResponse {
  id: string;
  name: string;
  fingerprint: string;
  status: WorkerStatus;
  lastSeenAt: string | null;
  machineLinks: WorkerMachineLinkNode[];
}

/** One Claude subscription usage window (utilization % + reset — ADR-0072). */
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

/** Live operational status of a machine-link (ADR-0072). */
export interface MachineUsageStatus {
  connected: boolean;
  scope: string;
  /** Currently processing a prompt. */
  busy: boolean;
  /** The physic project it serves (label "current"), or null when idle. */
  serving: { projectId: string; name: string } | null;
}

/** Per-project usage of one machine-link (history — ADR-0072). */
export interface MachineProjectUsage {
  projectId: string;
  name: string;
  tokens: number;
  commands: number;
  /** True for the project it is currently serving (shown on top). */
  current: boolean;
}

/** GET /machines/:id/logs — tail of the cli's own JSONL logs (ADR-0072). */
export interface LogReadResponse {
  lines: string[];
}

/** One command-history row for a MACHINE user (ADR-0072) / project (command-0005, ADR-0107). */
export interface CommandHistoryItem {
  id: string;
  commandId: string;
  /** `web` (dispatched) | `local` (typed in the cli TUI) — ADR-0107. */
  origin: CommandOrigin;
  /** The cli (machine-link) that ran the command. */
  machineLinkId: string;
  cmd: string;
  args: string[];
  status: string;
  exitCode: number | null;
  tokens: number | null;
  /** The ai_tokens split for this run (ADR-0145); all `null` for non-AI / pre-migration rows. */
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  projectId: string | null;
  startedAt: string;
  finishedAt: string | null;
}

/** GET /machine-links/:id/usage — status + subscription + per-project usage (ADR-0072). */
export interface MachineUsageResponse {
  linkId: string;
  userId: string;
  username: string;
  status: MachineUsageStatus;
  subscription: MachineUsageSubscription | null;
  projects: MachineProjectUsage[];
}

/** Query GET /workers (machine-0009). */
export const listWorkersQuerySchema = baseRequestSchema.extend({
  status: z.enum(["online", "offline"]).optional(),
});
export type ListWorkersQuery = z.infer<typeof listWorkersQuerySchema>;

/** Body PATCH /workers/:id (machine-0010). */
export const updateWorkerRequestSchema = z.object({
  name: z.string().min(1).max(100).optional(),
});
export type UpdateWorkerRequest = z.infer<typeof updateWorkerRequestSchema>;

/** Body PUT /machine-links/:id/physic-project (machine-0011 — upsert 1:1). */
export const putPhysicProjectRequestSchema = z.object({
  projectId: z.string().uuid(),
  /** null/empty ⇒ pending — the folder is finalized in wizard step 2. */
  path: z.string().min(1).max(500).nullable().optional(),
  name: z.string().max(100).optional(),
});
export type PutPhysicProjectRequest = z.infer<
  typeof putPhysicProjectRequestSchema
>;

/** Body PATCH /machine-links/:id/physic-project (machine-0012). */
export const patchPhysicProjectRequestSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  projectId: z.string().uuid().optional(),
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

/** One entry in a worker directory listing (machine-0007). */
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

/** Data GET /machines/:id/config — the paired profile's config.json as text (machine-0025, ADR-0141). */
export interface ConfigReadResponse {
  /** config.json content as pretty-printed text (empty-defaults when the file is absent). */
  config: string;
}

/** Data PUT /machines/:id/config — result of replacing the profile's config.json (machine-0026). */
export interface ConfigWriteResponse {
  /** True when written; false with `error` when the submitted text is invalid JSON / bad shape. */
  ok: boolean;
  error?: string;
}

/** Status of one worker tool on the machine (Tools tab, machine-0050, ADR-0206). */
export interface WorkerToolStatus {
  /** Catalog id or npm package name. */
  id: string;
  label: string;
  category: "runtime" | "ai-cli" | "vcs";
  installed: boolean;
  version: string | null;
  /** False for a detect-only prerequisite (no install/uninstall button). */
  installable: boolean;
}

/** Data GET /machines/:id/tools — the default catalog + extra global packages (machine-0050). */
export interface WorkerToolsResponse {
  catalog: WorkerToolStatus[];
  extras: WorkerToolStatus[];
}

/** Body POST /machines/:id/tools/install — install a tool (machine-0051, ADR-0206). */
export const workerToolInstallSchema = z.object({
  /** Catalog id or npm package name (validated npm-name shape on the cli). */
  name: z.string().trim().min(1).max(214),
  /** Package manager to run the global install with. */
  manager: z.enum(["npm", "pnpm"]),
});
export type WorkerToolInstallRequest = z.infer<typeof workerToolInstallSchema>;

/** Data POST install / DELETE uninstall — the streamed op id to subscribe to (machine-0051/0052). */
export interface WorkerToolOpResponse {
  /** Correlates the SSE progress stream (machine-0053). */
  opId: string;
}

/** One SSE frame of a worker-tools install/uninstall op (machine-0053, ADR-0206). */
export type WorkerToolProgressEvent =
  | { type: "line"; line: string }
  | { type: "done"; ok: boolean; exitCode: number; error?: string };

/**
 * Buffered result of a worker-tools op (admin-0061/0062, ADR-0206) — the admin S2S chain runs the
 * op server-side and returns the collected output at once (no SSE proxy through admin-bff).
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

/** Max bytes accepted by a fs.write (machine-0027) — mirrors the cli-side cap. */
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

/** Data PUT /machines/:id/file — result of the worker write (machine-0027). */
export interface FsWriteResponse {
  /** The resolved (clamped) path written. */
  path: string;
  /** Bytes written. */
  bytes: number;
}

/**
 * Body PUT /machines/:id/autonomous — a discriminated write to the autonomous engine
 * (machine-0029, ADR-0152). The **author** (`by`) is filled by the server from the
 * authenticated user (trace, not client-supplied) before forwarding to the cli.
 */
export const autonomousWriteRequestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("settings"), settings: z.string().max(64 * 1024) }),
  z.object({ kind: z.literal("approvals"), taskId: z.string().min(1).max(64), approved: z.boolean() }),
  z.object({ kind: z.literal("userTodo"), content: z.string().min(1).max(16 * 1024) }),
  z.object({ kind: z.literal("cron"), action: z.enum(["install", "uninstall"]) }),
]);
export type AutonomousWriteBody = z.infer<typeof autonomousWriteRequestSchema>;

/** Query GET /machines/:id/autonomous/logs — one day's tick log (machine-0030, ADR-0152). */
export const autonomousLogsQuerySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});
export type AutonomousLogsQuery = z.infer<typeof autonomousLogsQuerySchema>;

/** A subagent/skill name — safe file/dir stem (no traversal). */
const agentNameSchema = z.string().min(1).max(64).regex(/^[\w.-]+$/);

/** Query GET /machines/:id/agents/item — read one subagent/skill (machine-0032, ADR-0153). */
export const agentReadQuerySchema = z.object({
  kind: z.enum(["subagent", "skill"]),
  name: agentNameSchema,
});
export type AgentReadQuery = z.infer<typeof agentReadQuerySchema>;

/** Body POST /machines/:id/rag/install — install a worker-tuned RAG model (machine-0038, ADR-0156). */
export const ragInstallRequestSchema = z.object({
  model: z.string().min(1).max(200),
});
export type RagInstallBody = z.infer<typeof ragInstallRequestSchema>;

/** Query GET /machines/:id/rag/query — semantic search over the index (machine-0040, ADR-0157). */
export const ragQueryQuerySchema = z.object({
  q: z.string().min(1).max(2000),
  k: z.coerce.number().int().min(1).max(20).optional(),
});
export type RagQueryQuery = z.infer<typeof ragQueryQuerySchema>;

/** Query GET /machines/:id/graph — build the docs/code dependency graph (machine-0036, ADR-0155). */
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

/** Body PUT /machines/:id/agents — create/edit or delete a subagent/skill (machine-0033, ADR-0153). */
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
/** The `permissions` block of a Claude settings file (ADR-0183). */
const agentToolsPermissionsSchema = z.object({
  defaultMode: z.enum(["default", "acceptEdits", "plan", "bypassPermissions"]),
  allow: z.array(toolRuleSchema).max(500),
  ask: z.array(toolRuleSchema).max(500),
  deny: z.array(toolRuleSchema).max(500),
});

/** Query GET /machines/:id/agent-tools — which settings file to read (machine-0044, ADR-0183). */
export const agentToolsReadQuerySchema = z.object({
  scope: z.enum(["shared", "local"]),
});
export type AgentToolsReadQuery = z.infer<typeof agentToolsReadQuerySchema>;

/** Body PUT /machines/:id/agent-tools — replace a permissions block (machine-0045, ADR-0183). */
export const agentToolsWriteRequestSchema = z.object({
  scope: z.enum(["shared", "local"]),
  permissions: agentToolsPermissionsSchema,
});
export type AgentToolsWriteBody = z.infer<typeof agentToolsWriteRequestSchema>;

/** Data GET /machines/:id/diff — old (HEAD) vs current content of a file (Monaco diff). */
export interface GitDiffResponse {
  path: string;
  oldContent: string;
  newContent: string;
}

/** Data GET /machines/:id/git/repos — a git repo found under the physic project (machine-0021). */
export interface GitRepoRef {
  /** Relative subdir under the physic project root ("" = root/primary repo). */
  subdir: string;
  name: string;
  remote: string | null;
}

/** One commit in the history (machine-0022). */
export interface GitLogEntry {
  hash: string;
  shortHash: string;
  author: string;
  date: string;
  subject: string;
}

/** Data GET /machines/:id/git/log — a page of commit history (machine-0022). */
export interface GitLogResponse {
  entries: GitLogEntry[];
  hasMore: boolean;
}

/** A file changed in a commit (machine-0023). */
export interface GitCommitFile {
  path: string;
  status: string;
  oldPath?: string;
}

/** Data GET /machines/:id/git/commit — a commit + its changed files (machine-0023). */
export interface GitCommitResponse {
  hash: string;
  author: string;
  date: string;
  subject: string;
  files: GitCommitFile[];
}

/** Data GET /machines/:id/git-env — worker git + AI CLI environment (machine-0008). */
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
 * of a **rented** machine-user, generated on its worker (ADR-0173). The private key never
 * leaves the worker; only the public key + fingerprint are returned. `publicKey` is `null`
 * when none has been generated.
 */
export interface SshDeployKeyResponse {
  /** The OpenSSH public key present on the worker, or `null` when none exists. */
  publicKey: string | null;
  /** SHA256 fingerprint of the key, when present. */
  fingerprint: string | null;
}
