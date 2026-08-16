/**
 * DTOs for the project domain (21-api/project-0001…0015 including CRUD +
 * attach/detach + memo; create-from-spec/add/spec-assist included).
 */
import { z } from "zod";
import { UsageMetric, type ProjectStatus } from "@4pm/constants";
import { ipAllowlistSchema } from "@4pm/validation";
import { baseRequestSchema, deletedFilterSchema, pinnedFilterSchema } from "./base";
import type { UserResponse } from "./user";
import { TEMPLATE_KINDS, type ProjectTemplateSelection, type TemplateKind } from "./template";

/** Lightweight project-manager (PM) summary shown in list/detail rows. */
export interface ProjectManagerSummary {
  id: string;
  username: string;
}

/** Project returned by the API. */
export interface ProjectResponse {
  id: string;
  orgId: string;
  name: string;
  description: string;
  /** Avatar URL `/projects/:id/avatar` (ADR-0043), or null when none. */
  avatarUrl: string | null;
  status: ProjectStatus;
  /** Mid-tier IP allowlist (Org > project > user — ADR-0050); empty = no restriction. */
  ipAllowlist: string[];
  /** Messenger conversation retention in days (0 = keep forever) — ADR-0078. */
  messengerRetentionDays: number;
  /** Typed token settings (ADR-0081) — read via `readProjectSettings`. */
  settings: ProjectSettings;
  /** Whether the current user has pinned this project (ADR-0027). */
  pinned: boolean;
  /** The project manager (project_managers) — one PM per project (null if none). */
  pm: ProjectManagerSummary | null;
  /** Number of teams attached to the project (project_teams). */
  teamCount: number;
  /** Number of directly-assigned users (project_users) — total, incl. MACHINE. */
  userCount: number;
  /** How many of `userCount` are MACHINE (worker) accounts (ADR-0041). Human
   *  members = userCount - machineCount. */
  machineCount: number;
  createdAt: string;
  updatedAt: string;
}

/** A member of a team as seen inside a project (ADR-0096) — with per-project pause state. */
export interface ProjectTeamMember {
  id: string;
  username: string;
  email: string;
  /** Contact phone, or null when the account has none. */
  phone: string | null;
  /** Avatar-serving URL (`/users/:id/avatar`) or null when the user has no avatar. */
  avatarUrl: string | null;
  /** Paused for THIS project only via a `project_member_overrides` row (ADR-0096). */
  paused: boolean;
}

/** Summary of a team attached to a project (project-0003) + its members & pause state (ADR-0096). */
export interface ProjectTeamSummary {
  id: string;
  name: string;
  /** The team's own avatar-serving URL (`/teams/:id/avatar`) or null when none. */
  avatarUrl: string | null;
  /** The team's participation in THIS project is paused (`project_teams.status`, ADR-0096). */
  paused: boolean;
  /** The team's members (humans + machines), with each member's per-project pause state. */
  members: ProjectTeamMember[];
}

/** The cli assigned to a project (physic project) — for the dashboard files tab. */
export interface ProjectCliInfo {
  machineLinkId: string;
  /** Scaffolded project root on the worker (null while pending). */
  path: string | null;
  /** The paired MACHINE user id (link target for its Settings tab) — null if unknown. */
  userId: string | null;
  /** The serving MACHINE user is a rented (4PM pool) worker (ADR-0132/0173). */
  isRented: boolean;
  /** Latest worker network probe (ADR-0221) — the project page warns when the worker's network is
   *  left open. Null when the cli hasn't reported one yet (old clients / not connected). */
  network: WorkerNetworkProbe | null;
}

/** Data GET /projects/:id/members — effective members (direct + via teams), humans only (ADR-0078). */
export interface ProjectMembersResponse {
  users: UserResponse[];
}

/** Data GET /projects/:id — project + teams + directly-assigned users + PMs (+ cli). */
export interface ProjectDetailResponse extends ProjectResponse {
  teams: ProjectTeamSummary[];
  users: UserResponse[];
  /** The project manager (project_managers) — one PM per project (null if none). */
  pm: UserResponse | null;
  /** The worker cli serving this project (null if none assigned). */
  cli: ProjectCliInfo | null;
  /** Direct members (`project_users`) whose membership is paused (ADR-0093). */
  pausedMemberIds: string[];
  /** Attached teams whose participation in this project is paused (`project_teams.status`, ADR-0096). */
  pausedTeamIds: string[];
}

/** Query of GET /projects — BaseRequest (search by name; sort name/createdAt) + pinned. */
export const listProjectsQuerySchema = baseRequestSchema.extend({
  pinned: pinnedFilterSchema,
  /** ADMIN-only Trash: list soft-deleted projects (ADR-0109). */
  deleted: deletedFilterSchema,
});
export type ListProjectsQuery = z.infer<typeof listProjectsQuerySchema>;

/** Query GET /projects/recent (project-0017) — limit only. */
export const recentProjectsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(20).default(5),
});
export type RecentProjectsQuery = z.infer<typeof recentProjectsQuerySchema>;

/** Body POST /projects — step 1 of project creation (project-0002):
 *  machineUserId = an idle MACHINE user (cli paired, not yet serving a project)
 *  ⇒ create a draft project + physic_projects (path=null, pending). */
export const createProjectRequestSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(2000).optional(),
  machineUserId: z.string().uuid().optional(),
});
export type CreateProjectRequest = z.infer<typeof createProjectRequestSchema>;

/**
 * Body POST /projects/:id/copy (project-0053) — duplicate a project as a spec-only DRAFT
 * (ADR-0148). Only `name` is supplied; the copy inherits the source spec (no physic project
 * / cli / scaffold job), so the user re-runs the Content wizard to actually create it.
 */
export const copyProjectRequestSchema = z.object({
  name: z.string().min(1).max(100),
});
export type CopyProjectRequest = z.infer<typeof copyProjectRequestSchema>;

/**
 * Runtime token knobs per project (ADR-0081), stored under `settings.tokens` — 2 cli
 * knobs (NOT period budgets; budgets live in the `quotas` table). Pushed to the project
 * cli via the daily `ws_token` (machine-0003). Out-of-bound values clamp back to default.
 */
export interface ProjectTokenSettings {
  /** Session (5h) utilization % that makes the cli rotate its Claude profile; 0 = off. */
  sessionSwitchPct: number;
  /** Estimated-token ceiling for a single prompt; 0 = no limit. */
  perPromptTokenLimit: number;
}

/**
 * Project usage-alert rule (ADR-0220) — fires when the project's AI usage crosses a threshold,
 * delivering to a designated email and/or an in-app notification to a chosen project user.
 * `budgetPercent`: fire at `threshold`% (1–100) of the project's token/command budget in the
 * current period. `absolute`: fire when month-to-date tokens/commands reach `threshold`. At
 * least one of `email` / `notifyUserId` should be set. Stored under `projects.settings.alerts`.
 */
export const PROJECT_ALERT_KINDS = ["budgetPercent", "absolute"] as const;
export type ProjectAlertKind = (typeof PROJECT_ALERT_KINDS)[number];

export const projectAlertRuleSchema = z.object({
  id: z.string().min(1).max(64),
  kind: z.enum(PROJECT_ALERT_KINDS),
  metric: z.enum([UsageMetric.AI_TOKENS, UsageMetric.COMMANDS]),
  threshold: z.number().int().min(1),
  email: z.union([z.string().email(), z.literal("")]).optional(),
  notifyUserId: z.union([z.string().uuid(), z.literal("")]).optional(),
  enabled: z.boolean().default(true),
});
export type ProjectAlertRule = z.infer<typeof projectAlertRuleSchema>;

/** The `alerts` block of `projects.settings` (ADR-0220). */
export const projectAlertsSchema = z.object({
  rules: z.array(projectAlertRuleSchema).max(20).default([]),
});
export type ProjectAlerts = z.infer<typeof projectAlertsSchema>;

/** Read the project usage-alert rules out of a loosely-typed `projects.settings` JSON (ADR-0220). */
export function readProjectAlertRules(
  settings: Record<string, unknown> | null | undefined,
): ProjectAlertRule[] {
  const parsed = projectAlertsSchema.safeParse((settings ?? {})["alerts"] ?? { rules: [] });
  return parsed.success ? parsed.data.rules : [];
}

/**
 * Outbound-review policy per project (ADR-0082), stored under `settings.outboundReview`.
 * When `enabled`, every AI input a machine cli runs must be approved by an outbound cli
 * (a project machine-user in `outboundLinkIds`) before it may spawn — `ruleCheck`/`aiReview`
 * are independently toggled engines. `allowedRepos` bounds where commits may go (empty ⇒
 * derived from `project.git`).
 */
export interface OutboundReviewSettings {
  enabled: boolean;
  ruleCheck: boolean;
  aiReview: boolean;
  /** Machine-link ids (project machine-users) that act as reviewers (round-robin pool). */
  outboundLinkIds: string[];
  /** Repos commits are allowed to target (host/owner/name); empty = derive from git. */
  allowedRepos: string[];
  /**
   * Per-project rule-scan regex the reviewer cli uses (ADR-0087, full override). Each entry
   * is a regex literal `/body/flags` (or a bare source). Absent in storage ⇒ resolved to
   * `DEFAULT_OUTBOUND_RULES`; an explicit empty list ⇒ that category is disabled.
   */
  rules: OutboundReviewRules;
}

/** The editable rule-scan pattern lists (ADR-0087) — `secret`/`environment` only. */
export interface OutboundReviewRules {
  secret: string[];
  environment: string[];
}

/**
 * Built-in rule-scan patterns (ADR-0087) — the fallback shown in the UI and used by the
 * reviewer cli when a project has not overridden a category. Stored as regex literals so
 * they round-trip through the editor and preserve per-pattern flags.
 */
export const DEFAULT_OUTBOUND_RULES: OutboundReviewRules = {
  secret: [
    String.raw`/\b(api[_-]?key|secret|password|passwd|access[_-]?token|bearer)\b\s*[:=]\s*\S+/i`,
    String.raw`/AKIA[0-9A-Z]{16}/`,
    String.raw`/\b(gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9]{20,})\b/`,
    String.raw`/-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/`,
    String.raw`/\b[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)\s*=\s*\S{6,}/`,
  ],
  environment: [
    String.raw`/\b(?:ssh|scp|rsync)\s+[\w.-]+@/i`,
    String.raw`/\bsudo\b/i`,
    String.raw`/\bkubectl\b/i`,
    String.raw`/\bdocker\s+(?:push|-H|--host)\b/i`,
    String.raw`/\b(?:aws|gcloud|az)\s+\w+/i`,
    String.raw`/\bcurl\b[^\n]*\bhttps?:\/\/(?!localhost|127\.0\.0\.1)/i`,
  ],
};

/**
 * Compile one rule entry (ADR-0087) into a RegExp. Accepts a `/body/flags` literal (keeps
 * the flags) or a bare source (no flags). Throws `SyntaxError` on an invalid pattern — the
 * save-gate catches this to reject; the reviewer cli catches it to skip the entry.
 */
export function compileRulePattern(entry: string): RegExp {
  const literal = /^\/(.+)\/([gimsuy]*)$/s.exec(entry.trim());
  if (literal) return new RegExp(literal[1] ?? "", literal[2] ?? "");
  return new RegExp(entry.trim());
}

/**
 * AI-scope policy per project, stored under `settings.aiScope`. When `restrictToFolder`
 * is on, the project cli prepends a guard to every AI prompt telling the agent to only
 * read/use/modify content inside the served worker project folder — a prompt-level
 * hardening on top of the cli already spawning with `cwd = <project folder>`. Pushed to
 * the cli via the daily `ws_token` (machine-0003), same path as the token knobs.
 */
/**
 * Worker network probe result (ADR-0221). 4PM cannot enforce the worker's network from inside the
 * cli, so instead of a server-set policy the cli **actively probes** the worker's network posture
 * (both directions) and whether it runs containerized; the web shows non-blocking warnings when the
 * network is left open. Carried on the `machine.usage` snapshot; observe-only (never blocks a
 * dispatch). `outbound` = can the worker reach the open internet (egress); `inbound` = is the worker
 * exposed to incoming connections on a public interface.
 */
export interface WorkerNetworkProbe {
  /** `open` = the worker reached the open internet (not sandboxed); `restricted` = it could not. */
  outbound: "open" | "restricted";
  /** `exposed` = the worker listens on a public interface (reachable from outside); `isolated` = not. */
  inbound: "exposed" | "isolated";
  /** True when the worker detects it runs inside a container (`/.dockerenv` / cgroup hint). */
  containerized: boolean;
  /** ISO timestamp of this probe. */
  checkedAt: string;
}

/**
 * Read the worker network probe (ADR-0221) out of a loosely-typed `machine.usage` snapshot JSON —
 * the cli carries it under `snapshot.network`. Returns null when absent/malformed (old clients).
 */
export function readWorkerNetwork(snapshot: unknown): WorkerNetworkProbe | null {
  const n = (snapshot as { network?: unknown } | null)?.network as
    | Partial<WorkerNetworkProbe>
    | undefined;
  if (!n || (n.outbound !== "open" && n.outbound !== "restricted")) return null;
  return {
    outbound: n.outbound,
    inbound: n.inbound === "exposed" ? "exposed" : "isolated",
    containerized: n.containerized === true,
    checkedAt: typeof n.checkedAt === "string" ? n.checkedAt : "",
  };
}

export interface ProjectAiScopeSettings {
  /** Restrict the AI agent to the served project folder (default false). */
  restrictToFolder: boolean;
}

/**
 * Per-project git-auth method for the worker (ADR-0192 §4). `self` = the worker uses its own
 * gh/glab credentials (self-host default); `deploy-key` = a worker-generated ssh deploy key
 * (ADR-0173); `gitlab-group-token` / `github-app` = a token the worker configures for HTTPS git
 * (the token itself is injected out-of-band as a secret / minted server-side — never in settings).
 */
export const GIT_AUTH_METHODS = ["self", "deploy-key", "gitlab-group-token", "github-app"] as const;
export type GitAuthMethod = (typeof GIT_AUTH_METHODS)[number];

/** Per-project git-auth policy (ADR-0192 §4) — method only; credentials live out of settings. */
export interface ProjectGitAuthSettings {
  method: GitAuthMethod;
}

/**
 * Marketplace package policy per project (ADR-0185/0186), stored under `settings.packages`.
 * When `autoUpdate` is on, the server's daily tick re-installs each installed package's newer
 * approved version onto the project cli (drift-guarded); default off (manual updates only).
 */
export interface ProjectPackagesSettings {
  autoUpdate: boolean;
}

/** Typed view of `Project.settings` (ADR-0081/0082/0113). */
export interface ProjectSettings {
  tokens: ProjectTokenSettings;
  outboundReview: OutboundReviewSettings;
  /** Selected template file per kind (ADR-0113) — kind → org template file id. */
  templates: ProjectTemplateSelection;
  /** AI-scope policy (folder-restriction prompt guard). */
  aiScope: ProjectAiScopeSettings;
  /** Marketplace package auto-update policy (ADR-0185). */
  packages: ProjectPackagesSettings;
  /** Git-auth method for the worker (ADR-0192 §4). */
  gitAuth: ProjectGitAuthSettings;
  /** Project usage-alert rules (ADR-0220) — empty when none configured. */
  alerts: ProjectAlertRule[];
}

/** Defaults applied when a project settings key is absent (ADR-0081/0082/0113). */
export const DEFAULT_PROJECT_SETTINGS: ProjectSettings = {
  tokens: { sessionSwitchPct: 0, perPromptTokenLimit: 0 },
  templates: {},
  aiScope: { restrictToFolder: false },
  packages: { autoUpdate: false },
  gitAuth: { method: "self" },
  alerts: [],
  outboundReview: {
    enabled: false,
    ruleCheck: false,
    aiReview: false,
    outboundLinkIds: [],
    allowedRepos: [],
    rules: DEFAULT_OUTBOUND_RULES,
  },
};

/** Max entries for the outbound-review string lists (ADR-0082) — guards oversized settings. */
export const OUTBOUND_REVIEW_MAX_LIST = 50;

/**
 * Bounds for the token knobs (ADR-0081): each accepts 0 (off) or a value within
 * `[min, max]`; anything else clamps back to the default (0).
 */
export const PROJECT_TOKEN_BOUNDS = {
  sessionSwitchPct: { min: 70, max: 90 },
  perPromptTokenLimit: { min: 1_000, max: 2_000_000 },
} as const;

/** Read a knob: 0 ("off") or within bounds, else the default (0). */
function readTokenKnob(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  if (value === 0) return 0;
  const v = Math.floor(value);
  return v >= min && v <= max ? v : 0;
}

/**
 * Read the typed project settings from the loosely-typed JSON store, filling in
 * defaults + clamping out-of-range values (ADR-0081, mirrors `readOrgSettings`).
 */
export function readProjectSettings(
  settings: Record<string, unknown> | null | undefined,
): ProjectSettings {
  const tokens = (settings?.tokens ?? {}) as Partial<ProjectTokenSettings>;
  const review = (settings?.outboundReview ?? {}) as Partial<OutboundReviewSettings>;
  const B = PROJECT_TOKEN_BOUNDS;
  const d = DEFAULT_PROJECT_SETTINGS.outboundReview;
  const strList = (v: unknown): string[] =>
    Array.isArray(v)
      ? v.filter((s): s is string => typeof s === "string").slice(0, OUTBOUND_REVIEW_MAX_LIST)
      : [];
  // Rule patterns (ADR-0087): a present list overrides the category (empty ⇒ disabled),
  // an absent list falls back to the built-in default. Drop entries that do not compile.
  const ruleList = (v: unknown, fallback: string[]): string[] => {
    if (!Array.isArray(v)) return fallback;
    return v
      .filter((s): s is string => typeof s === "string")
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((s) => {
        try {
          compileRulePattern(s);
          return true;
        } catch {
          return false;
        }
      })
      .slice(0, OUTBOUND_REVIEW_MAX_LIST);
  };
  const rules = (review.rules ?? {}) as Partial<OutboundReviewRules>;
  const aiScope = (settings?.aiScope ?? {}) as Partial<ProjectAiScopeSettings>;
  const packages = (settings?.packages ?? {}) as Partial<ProjectPackagesSettings>;
  const gitAuth = (settings?.gitAuth ?? {}) as Partial<ProjectGitAuthSettings>;
  // Template selection (ADR-0113): keep only known kinds pointing at a string file id.
  const rawTemplates = (settings?.templates ?? {}) as Record<string, unknown>;
  const templates: ProjectTemplateSelection = {};
  for (const kind of TEMPLATE_KINDS) {
    const v = rawTemplates[kind];
    if (typeof v === "string" && v) templates[kind] = v;
  }
  return {
    templates,
    alerts: readProjectAlertRules(settings),
    aiScope: {
      restrictToFolder:
        typeof aiScope.restrictToFolder === "boolean"
          ? aiScope.restrictToFolder
          : DEFAULT_PROJECT_SETTINGS.aiScope.restrictToFolder,
    },
    packages: {
      autoUpdate:
        typeof packages.autoUpdate === "boolean"
          ? packages.autoUpdate
          : DEFAULT_PROJECT_SETTINGS.packages.autoUpdate,
    },
    gitAuth: {
      method: GIT_AUTH_METHODS.includes(gitAuth.method as GitAuthMethod)
        ? (gitAuth.method as GitAuthMethod)
        : DEFAULT_PROJECT_SETTINGS.gitAuth.method,
    },
    tokens: {
      sessionSwitchPct: readTokenKnob(
        tokens.sessionSwitchPct,
        B.sessionSwitchPct.min,
        B.sessionSwitchPct.max,
      ),
      perPromptTokenLimit: readTokenKnob(
        tokens.perPromptTokenLimit,
        B.perPromptTokenLimit.min,
        B.perPromptTokenLimit.max,
      ),
    },
    outboundReview: {
      enabled: typeof review.enabled === "boolean" ? review.enabled : d.enabled,
      ruleCheck: typeof review.ruleCheck === "boolean" ? review.ruleCheck : d.ruleCheck,
      aiReview: typeof review.aiReview === "boolean" ? review.aiReview : d.aiReview,
      outboundLinkIds: strList(review.outboundLinkIds),
      allowedRepos: strList(review.allowedRepos),
      rules: {
        secret: ruleList(rules.secret, DEFAULT_OUTBOUND_RULES.secret),
        environment: ruleList(rules.environment, DEFAULT_OUTBOUND_RULES.environment),
      },
    },
  };
}

/** Body PATCH /projects/:id (partial). */
export const updateProjectRequestSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(2000).optional(),
  // Mid-tier IP allowlist (ADR-0050) — PM(manage)/ADMIN only; must fall within org.
  ipAllowlist: ipAllowlistSchema.optional(),
  // Messenger retention in days (0 = keep forever) — manager only (ADR-0078).
  messengerRetentionDays: z.number().int().min(0).max(3650).optional(),
  // Project settings (ADR-0081) — key-level shallow-merge; `tokens` clamped on read.
  settings: z.record(z.unknown()).optional(),
  // Identity ↔ spec sync (ADR-0148): the Settings tab edits the spec basic group
  // (id = spec slug, name, desc). The server merges these into `spec` (READY) or
  // `specDraft` (DRAFT) so the Content → Spec tab / wizard stays consistent.
  specBasic: z
    .object({
      id: z.string().max(200),
      name: z.string().max(100),
      desc: z.string().max(2000),
    })
    .partial()
    .optional(),
});
export type UpdateProjectRequest = z.infer<typeof updateProjectRequestSchema>;

/** Memo length limit (project-0015 — MEMO_TOO_LONG). */
export const MEMO_MAX_LENGTH = 65_536;

/** Data GET/PUT /projects/:id/memo (per-user). */
export interface ProjectMemoResponse {
  content: string | null;
  updatedAt: string | null;
}

/** Body PUT /projects/:id/memo. */
export const putMemoRequestSchema = z.object({
  content: z.string().max(MEMO_MAX_LENGTH),
});
export type PutMemoRequest = z.infer<typeof putMemoRequestSchema>;

/** Max length of one memo checklist item. */
export const MEMO_ITEM_MAX_LENGTH = 2_000;

/** One item of a user's per-project memo checklist (project-0026…0029). */
export interface MemoItemResponse {
  id: string;
  content: string;
  done: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

/** Body POST /projects/:id/memo-items — add a checklist item. */
export const createMemoItemSchema = z.object({
  content: z.string().trim().min(1).max(MEMO_ITEM_MAX_LENGTH),
});
export type CreateMemoItemRequest = z.infer<typeof createMemoItemSchema>;

/** Body PATCH /projects/:id/memo-items/:itemId — edit text and/or toggle done. */
export const updateMemoItemSchema = z
  .object({
    content: z.string().trim().min(1).max(MEMO_ITEM_MAX_LENGTH).optional(),
    done: z.boolean().optional(),
  })
  .refine((v) => v.content !== undefined || v.done !== undefined, {
    message: "content or done required",
  });
export type UpdateMemoItemRequest = z.infer<typeof updateMemoItemSchema>;

/** Current PMSpec schema version (bump when the field catalog changes — spec-schema.md). */
export const SPEC_VERSION = 5;

/** Max serialized size (bytes) of a saved spec draft (project-0030 — SPEC_DRAFT_TOO_LARGE). */
export const SPEC_DRAFT_MAX_BYTES = 1_048_576;

/**
 * Max JSON request body (bytes) accepted by the HTTP gateway (BFF) and the server.
 * Kept strictly above SPEC_DRAFT_MAX_BYTES so a spec at the app limit still passes the
 * transport parser (a valid spec must not be rejected with a raw PayloadTooLargeError).
 * Bodies past this cap map to PAYLOAD_TOO_LARGE at the BFF.
 */
export const HTTP_JSON_BODY_LIMIT_BYTES = 2 * 1_048_576;

/** Data GET /projects/:id/spec-draft (project-0031, per-project DB draft — ADR-0077). */
export interface SpecDraftResponse {
  spec: Record<string, unknown> | null;
  specVersion: number | null;
  updatedAt: string | null;
}

/** Data PUT /projects/:id/spec-draft (project-0030) — after saving. */
export interface SpecDraftSavedResponse {
  updatedAt: string;
}

/** Body PUT /projects/:id/spec-draft — save (upsert) the in-progress wizard spec. */
export const putSpecDraftRequestSchema = z.object({
  spec: z.record(z.unknown()),
  specVersion: z.number().int().positive().optional(),
});
export type PutSpecDraftRequest = z.infer<typeof putSpecDraftRequestSchema>;

/** Data GET /projects/:id/spec (project-0032, ADR-0114) — the canonical `Project.spec`. */
export interface ProjectSpecResponse {
  spec: Record<string, unknown> | null;
  updatedAt: string | null;
}

/** Body PUT /projects/:id/spec (project-0033) — replace the canonical spec (READY project). */
export const putProjectSpecRequestSchema = z.object({
  spec: z.record(z.unknown()),
});
export type PutProjectSpecRequest = z.infer<typeof putProjectSpecRequestSchema>;

/** Max serialized size (bytes) of a generated artifact's markdown (ADR-0114). */
export const ARTIFACT_MAX_BYTES = 512 * 1024;

/** One AI-generated project artifact (ADR-0114). */
export interface ProjectArtifactResponse {
  id: string;
  kind: TemplateKind;
  content: string;
  createdBy: string | null;
  createdAt: string;
}

/** Query GET /projects/:id/artifacts (project-0034) — optional kind filter. */
export const listArtifactsQuerySchema = z.object({
  kind: z.enum(TEMPLATE_KINDS).optional(),
});
export type ListArtifactsQuery = z.infer<typeof listArtifactsQuerySchema>;

/** Body POST /projects/:id/artifacts (project-0035) — save a generated artifact. */
export const createArtifactRequestSchema = z.object({
  kind: z.enum(TEMPLATE_KINDS),
  content: z.string().min(1).max(ARTIFACT_MAX_BYTES),
});
export type CreateArtifactRequest = z.infer<typeof createArtifactRequestSchema>;

/**
 * A loose git-URL shape (ADR-0172): `https://…`, `git@host:…` or `ssh://…`. 4PM never
 * creates repos — the user always points at an existing repo they own; a private repo on
 * a rented worker is given as its **ssh** url (ADR-0173).
 */
export const GIT_URL_RE = /^(https?:\/\/|git@[^\s:]+:|ssh:\/\/).+/i;

/**
 * One declared git repo of a multi-repo project (ADR-0073, simplified by ADR-0172): a
 * project has ≥1 repo, exactly one `primary` (cloned at the target folder root); sub-repos
 * clone into a subfolder. 4PM only ever **clones** an existing repo — the provider and the
 * display name are derived from the `url` (see `repoProvider`/`repoName`), not stored.
 */
export const repoSpecSchema = z.object({
  /** Role label (e.g. "docs" / "web" / "server") — descriptive, not constrained. */
  role: z.string().max(60).optional().default(""),
  /** Free-form description of what this repo holds (optional). */
  desc: z.string().max(500).optional().default(""),
  /** Exactly one repo of the project is the primary. */
  primary: z.boolean().optional().default(false),
  /** Clone url — `https` or `ssh` (required; ADR-0172). */
  url: z.string().max(500).regex(GIT_URL_RE, "must be an https or ssh git url"),
  /** Sub-repo subfolder under the target root (empty ⇒ derived from role/name). */
  subdir: z.string().max(120).optional().default(""),
});
export type RepoSpec = z.infer<typeof repoSpecSchema>;

/**
 * Derive the display name of a repo from its clone url (ADR-0172): the last path segment
 * without the `.git` suffix — e.g. `git@github.com:4azuo/XeNoDuongPho.git` ⇒ `XeNoDuongPho`,
 * `https://github.com/4azuo/XeNoDuongPho.git` ⇒ `XeNoDuongPho`. Empty when it can't be read.
 */
export function repoName(url: string): string {
  const last = (url || "").trim().replace(/\/+$/, "").split(/[/:]/).pop() ?? "";
  return last.replace(/\.git$/i, "");
}

/**
 * Derive the provider of a repo from its clone url host (ADR-0172): a `gitlab` host ⇒
 * `glab`, otherwise `gh` (GitHub is the default for any other host). Used for the `gh`/`glab`
 * provider ops in the Git tab.
 */
export function repoProvider(url: string): "gh" | "glab" {
  const u = (url || "").toLowerCase();
  // Host sits after `://` (+ optional `user@`) or between `git@` and `:` for scp-style urls.
  const host = u.startsWith("git@")
    ? u.slice(4).split(":")[0]
    : u.replace(/^[a-z]+:\/\//, "").replace(/^[^@/]+@/, "").split(/[/:]/)[0];
  return (host ?? "").includes("gitlab") ? "glab" : "gh";
}

/**
 * One field of the self-describing spec envelope (SPEC_VERSION 5): the field's schema
 * (id/name/description/type/allowed options) plus its current value — entered or empty
 * (`value` is a string, or a string[] for multiselect fields). The wizard catalog on the
 * web builds these; here they are validated loosely (unknown field ids pass through).
 */
export const specFieldEnvelopeSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional().default(""),
  description: z.string().optional().default(""),
  type: z.string().optional().default("text"),
  options: z.array(z.string()).optional(),
  value: z.union([z.string(), z.array(z.string())]).optional().default(""),
});
export type SpecFieldEnvelope = z.infer<typeof specFieldEnvelopeSchema>;

/** One declared subagent (item 10 / ADR-0080) — name + role/description. */
export const subagentSpecSchema = z.object({
  name: z.string().max(120).optional().default(""),
  description: z.string().max(2000).optional().default(""),
});
export type SubagentSpec = z.infer<typeof subagentSpecSchema>;

/**
 * PMSpec wizard payload (project-0010), SPEC_VERSION 5: the **self-describing envelope**
 * (see the web's `features/spec/envelope.ts`). Stored as jsonb. `fields` carries every
 * catalog field with its schema + value; the `id` and `name` fields must hold a non-empty
 * value. `repos` (ADR-0073) stay top-level and are validated when present: exactly one
 * primary. `meta` holds internal AI metadata for draft round-trips (stripped on create).
 */
export const projectSpecSchema = z
  .object({
    specVersion: z.number().int().positive(),
    fields: z.array(specFieldEnvelopeSchema),
    repos: z.array(repoSpecSchema).optional().default([]),
    subagents: z.array(subagentSpecSchema).optional().default([]),
    meta: z.record(z.unknown()).optional(),
  })
  .superRefine((v, ctx) => {
    // id + name must be present (non-empty string) among the fields.
    const byId = new Map(v.fields.map((f) => [f.id, f.value]));
    for (const key of ["id", "name"] as const) {
      const val = byId.get(key);
      if (typeof val !== "string" || val.trim() === "") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["fields"],
          message: `the "${key}" field is required`,
        });
      }
    }
    if (v.repos && v.repos.length > 0) {
      const primaries = v.repos.filter((r) => r.primary).length;
      if (primaries !== 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["repos"],
          message: "exactly one primary repo is required",
        });
      }
    }
  });
export type ProjectSpec = z.infer<typeof projectSpecSchema>;

/**
 * Body POST /projects/create — step 2: scaffold a draft from the spec (project-0010).
 * No `path` (ADR-0080): the cli scaffolds into `<profileDir>/<project-name>` and reports
 * the resolved path back.
 */
export const createFromSpecRequestSchema = z.object({
  projectId: z.string().uuid(),
  spec: projectSpecSchema,
});
export type CreateFromSpecRequest = z.infer<typeof createFromSpecRequestSchema>;

/**
 * Body POST /projects/add — step 2 (add mode): register an existing project by cloning
 * its repos (project-0011, ADR-0117). No spec/scaffold/AI-init; no manual `path`
 * (ADR-0080 — the cli derives `<profileDir>/<project-name>` and returns it). Reuses the
 * multi-repo Git declaration (ADR-0073, simplified by ADR-0172): ≥1 repo, exactly one
 * `primary`; every repo carries a clone `url` (https or ssh), enforced by `repoSpecSchema`.
 */
export const addRepoRequestSchema = z
  .object({
    projectId: z.string().uuid(),
    repos: z.array(repoSpecSchema).min(1),
  })
  .superRefine((v, ctx) => {
    const primaries = v.repos.filter((r) => r.primary).length;
    if (primaries !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["repos"],
        message: "Exactly one repo must be primary",
      });
    }
  });
export type AddRepoRequest = z.infer<typeof addRepoRequestSchema>;

/** Data 202 of POST /projects/create|add — the enqueued job + the draft project. */
export interface ProjectJobAcceptedResponse {
  jobId: string;
  project: ProjectResponse;
}

// AI spec-assist (suggest/review/compose) moved to the console dispatch path (ADR-0100):
// the web dispatches prompts via `command.dispatch({ ai:true })` and parses the streamed
// output client-side, so these request/response DTOs and their endpoints were removed.
