/**
 * DTO for the organization domain (21-api/org-0001…0002).
 */
import {
  DEFAULT_STORAGE_AUTO_CLEAR,
  readStorageAlerts,
  readStorageAutoClear,
  type StorageAlertRule,
  type StorageAutoClearSettings,
  type StorageKindBytes,
} from "./storage";
import { z } from "zod";
import { PaymentProvider } from "@4pm/constants";
import { DEFAULT_NETWORK_LOG_RETENTION_DAYS, readOrgNetworkSettings, type OrgNetworkSettings } from "./network";

/**
 * Pending paid-plan checkout recorded at register, stored under
 * `settings.billing.pending`. After verify + first login the web opens the hosted checkout;
 * the subscription consumer clears it once the sub is active.
 * @adr 0104
 */
export interface BillingPendingCheckout {
  planCode: string;
  provider?: PaymentProvider;
}

/**
 * Read the pending checkout intent from the org settings JSON, or null when absent/invalid.
 */
export function readPendingCheckout(
  settings: Record<string, unknown> | null | undefined,
): BillingPendingCheckout | null {
  const billing = settings?.billing as { pending?: unknown } | undefined;
  const pending = billing?.pending as Partial<BillingPendingCheckout> | undefined;
  if (!pending || typeof pending.planCode !== "string" || pending.planCode.length === 0) {
    return null;
  }
  const provider =
    pending.provider === PaymentProvider.STRIPE || pending.provider === PaymentProvider.PAYPAL
      ? pending.provider
      : undefined;
  return { planCode: pending.planCode, provider };
}

/** Security-related org policy, stored under `settings.security`. @adr 0039 */
export interface OrgSecuritySettings {
  /** Allow ADMIN to create sub-accounts without an email address. */
  allowSubAccountWithoutEmail: boolean;
  /**
   * Org-wide IP/CIDR allowlist — the outer boundary above each user's allowlist
   * (org > user inheritance). Empty = no org-level restriction.
   * @adr 0044
   */
  ipAllowlist: string[];
}

/** General/regional org policy, stored under `settings.general`. @adr 0039 */
export interface OrgGeneralSettings {
  /** IANA timezone name (e.g. "UTC", "Asia/Ho_Chi_Minh") — the org's default. */
  timezone: string;
  /**
   * Default rows per page for the org's paginated list views. Drives the `size`
   * query the web sends; clamped to {@link PAGE_SIZE_BOUNDS}.
   * @adr 0198
   */
  pageSize: number;
  /**
   * Idle privacy-lock timeout in minutes for the whole org. After this much
   * inactivity the web covers the app with a backdrop until the user re-enters their password.
   * `0` disables it; other values clamp to {@link IDLE_LOCK_BOUNDS}.
   * @adr 0202
   */
  idleLockMinutes: number;
  /**
   * How many worker-config template versions to keep. When a new version is saved,
   * versions older than the most recent N are pruned (a retention cap). Clamped to
   * {@link WORKER_CONFIG_VERSIONS_BOUNDS}.
   * @adr 0234
   */
  workerConfigVersionsKept: number;
  /** Max checklists per org. Clamped to {@link CHECKLIST_MAX_BOUNDS}. @adr 0332 */
  checklistMax: number;
  /** How many checklist item-versions to keep. Clamped to {@link WORKER_CONFIG_VERSIONS_BOUNDS}. @adr 0332 */
  checklistVersionsKept: number;
  /** Max worker-config templates per org. Clamped to {@link CHECKLIST_MAX_BOUNDS}. @adr 0332 */
  workerConfigTemplatesMax: number;
}

/** Bounds (rows) for the list page size — values outside clamp to the default. @adr 0198 */
export const PAGE_SIZE_BOUNDS = { min: 5, max: 100 } as const;

/** Default rows per page when unset. @adr 0198 */
export const DEFAULT_PAGE_SIZE = 10;

/** Bounds (minutes) for the idle privacy-lock; `0` (off) is allowed separately. @adr 0202 */
export const IDLE_LOCK_BOUNDS = { min: 1, max: 480 } as const;

/** Default idle privacy-lock timeout in minutes when unset. @adr 0202 */
export const DEFAULT_IDLE_LOCK_MINUTES = 30;

/** Bounds for how many worker-config template versions are kept. @adr 0234 */
export const WORKER_CONFIG_VERSIONS_BOUNDS = { min: 1, max: 100 } as const;

/** Default number of worker-config template versions kept when unset. @adr 0234 */
export const DEFAULT_WORKER_CONFIG_VERSIONS_KEPT = 10;

/** An org's resource caps — **admin-only** settings (only the platform admin edits them). @adr 0332 */
export interface OrgResourceCaps {
  checklistMax: number;
  checklistVersionsKept: number;
  workerConfigTemplatesMax: number;
  workerConfigVersionsKept: number;
}

/** Bounds for the per-org resource caps (checklists / worker-config templates) — ADR-0332. */
export const CHECKLIST_MAX_BOUNDS = { min: 1, max: 1000 } as const;
/** Default caps: 100 checklists / 100 worker-config templates, 10 versions kept each. @adr 0332 */
export const DEFAULT_CHECKLIST_MAX = 100;
export const DEFAULT_CHECKLIST_VERSIONS_KEPT = 10;
export const DEFAULT_WORKER_CONFIG_TEMPLATES_MAX = 100;

/**
 * Per-org command-history policy, stored under `settings.commandHistory`.
 * `store=false` skips writing history files but still records recent activity
 * (`user_recent_projects`). `retentionDays=0` keeps forever.
 * @adr 0045 @adr 0029
 */
export interface OrgCommandHistorySettings {
  store: boolean;
  retentionDays: number;
}

/**
 * Per-org token lifetimes, stored under `settings.tokens`. Web uses
 * access + refresh JWT; cli maps `ws_token` → access and `hashcode3` → refresh
 * (the cli has no JWT). All values in **seconds**; `cli.hashcode3TtlSec = 0` means
 * "never expires". Empty/out-of-bound values fall back to the defaults below.
 * @adr 0056
 */
export interface OrgTokenSettings {
  web: { accessTtlSec: number; refreshTtlSec: number };
  cli: { wsTokenTtlSec: number; hashcode3TtlSec: number };
}

/** Bounds (seconds) for token TTLs — values outside clamp to default. @adr 0056 */
export const TOKEN_TTL_BOUNDS = {
  accessTtlSec: { min: 300, max: 86_400 },
  refreshTtlSec: { min: 3_600, max: 7_776_000 },
  wsTokenTtlSec: { min: 300, max: 604_800 },
  // hashcode3 also accepts the special value 0 ("never expires").
  hashcode3TtlSec: { min: 86_400, max: 31_536_000 },
} as const;

/**
 * Per-org cli runtime policy, stored under `settings.cli`. Delivered to
 * the worker via the daily `ws_token` response. `reconnectMaxBackoffSec` caps the
 * exponential reconnect backoff when the server is unreachable — the cli retries
 * forever without unpairing, so this bounds the gap between attempts. All in seconds.
 * @adr 0056
 */
export interface OrgCliSettings {
  reconnectMaxBackoffSec: number;
  /** Enable the daily scheduled cli auto-update. @adr 0074 */
  autoUpdateDaily: boolean;
  /** Hour of day (0–23, in the org timezone) the daily update runs. @adr 0074 */
  autoUpdateHour: number;
}

/**
 * Bounds for cli policy — the 1-min ceiling on the reconnect backoff (seconds) and the
 * 0–23 range for the daily auto-update hour.
 * @adr 0074
 */
export const CLI_SETTINGS_BOUNDS = {
  reconnectMaxBackoffSec: { min: 5, max: 60 },
  autoUpdateHour: { min: 0, max: 23 },
} as const;

/**
 * Per-org community retention, stored under `settings.communityRetention`. Days;
 * `0` = keep forever. Each is capped at the plan's `retentionDays` on save.
 * Projected to @4pm/community (OrgRef) to drive its sweep: `forumPosts` (4rum),
 * `messages` (community messages), `attachments` (images & files — one knob).
 * @adr 0112 @adr 0105
 */
export interface OrgCommunityRetentionSettings {
  forumPosts: number;
  messages: number;
  attachments: number;
}

/**
 * Per-org community edit/delete windows, stored under `settings.communityEdit`. Minutes an
 * author may edit / delete their own 4rum post or Messenger message; `0` = unlimited. Projected to
 * @4pm/community (OrgRef), which enforces them. Moderators may always delete.
 * @adr 0341
 */
export interface OrgCommunityEditSettings {
  editWindowMinutes: number;
  deleteWindowMinutes: number;
}

/** Bounds of the community edit/delete windows in minutes (0 = unlimited; max 30 days). */
export const COMMUNITY_EDIT_WINDOW_MAX_MINUTES = 43_200;

/** Typed view of `Organization.settings`. @adr 0039 @adr 0045 @adr 0056 */
export interface OrgSettings {
  security: OrgSecuritySettings;
  general: OrgGeneralSettings;
  commandHistory: OrgCommandHistorySettings;
  communityRetention: OrgCommunityRetentionSettings;
  communityEdit: OrgCommunityEditSettings;
  tokens: OrgTokenSettings;
  cli: OrgCliSettings;
  /** Storage alert rules. @adr 0365 */
  storageAlerts: StorageAlertRule[];
  /** Auto clear config. @adr 0365 */
  storageAutoClear: StorageAutoClearSettings;
  /**
   * The worker pool designated to run **project-less org AI tasks** (ADR-0376 — e.g. AI
   * checklist authoring), stored under `settings.aiPoolId`. `null` = none configured. A pool set here
   * **cannot be attached to a project** (and a project-attached pool cannot be chosen here) — the
   * server enforces the mutual exclusivity on both the Settings save and the project pool-attach.
   * @adr 0284
   */
  aiPoolId: string | null;
  /** Org network egress rules: the denylist every project inherits + the network-log retention. @adr 0439 */
  network: OrgNetworkSettings;
}

/** Defaults applied when a settings key is absent. */
export const DEFAULT_ORG_SETTINGS: OrgSettings = {
  security: { allowSubAccountWithoutEmail: false, ipAllowlist: [] },
  general: {
    timezone: "UTC",
    pageSize: DEFAULT_PAGE_SIZE,
    idleLockMinutes: DEFAULT_IDLE_LOCK_MINUTES,
    workerConfigVersionsKept: DEFAULT_WORKER_CONFIG_VERSIONS_KEPT,
    checklistMax: DEFAULT_CHECKLIST_MAX,
    checklistVersionsKept: DEFAULT_CHECKLIST_VERSIONS_KEPT,
    workerConfigTemplatesMax: DEFAULT_WORKER_CONFIG_TEMPLATES_MAX,
  },
  commandHistory: { store: false, retentionDays: 7 },
  communityRetention: { forumPosts: 0, messages: 0, attachments: 0 },
  communityEdit: { editWindowMinutes: 60, deleteWindowMinutes: 60 },
  tokens: {
    web: { accessTtlSec: 3_600, refreshTtlSec: 604_800 },
    cli: { wsTokenTtlSec: 86_400, hashcode3TtlSec: 0 },
  },
  cli: { reconnectMaxBackoffSec: 60, autoUpdateDaily: false, autoUpdateHour: 0 },
  storageAlerts: [],
  storageAutoClear: DEFAULT_STORAGE_AUTO_CLEAR,
  aiPoolId: null,
  network: { deny: [], logRetentionDays: DEFAULT_NETWORK_LOG_RETENTION_DAYS },
};

/** Read a numeric TTL, clamping out-of-range values back to `def`. @adr 0056 */
function readTtl(value: unknown, def: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max
    ? Math.floor(value)
    : def;
}

/** Read a community edit/delete window (minutes): 0 (unlimited) … max, else `def`. @adr 0341 */
function readEditWindow(value: unknown, def: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= COMMUNITY_EDIT_WINDOW_MAX_MINUTES
    ? Math.floor(value)
    : def;
}

/** Read the hashcode3 default TTL: 0 ("never") or within bounds, else `def`. */
function readHashcode3Ttl(value: unknown, def: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return def;
  if (value === 0) return 0;
  const b = TOKEN_TTL_BOUNDS.hashcode3TtlSec;
  return value >= b.min && value <= b.max ? Math.floor(value) : def;
}

/**
 * Read the typed org settings from the loosely-typed JSON store, filling in
 * defaults for any missing keys.
 * @adr 0039
 */
export function readOrgSettings(settings: Record<string, unknown> | null | undefined): OrgSettings {
  const security = (settings?.security ?? {}) as Partial<OrgSecuritySettings>;
  const general = (settings?.general ?? {}) as Partial<OrgGeneralSettings>;
  const cmd = (settings?.commandHistory ?? {}) as Partial<OrgCommandHistorySettings>;
  const cr = (settings?.communityRetention ?? {}) as Partial<OrgCommunityRetentionSettings>;
  const ce = (settings?.communityEdit ?? {}) as Partial<OrgCommunityEditSettings>;
  const tokens = (settings?.tokens ?? {}) as {
    web?: Partial<OrgTokenSettings["web"]>;
    cli?: Partial<OrgTokenSettings["cli"]>;
  };
  const cli = (settings?.cli ?? {}) as Partial<OrgCliSettings>;
  const d = DEFAULT_ORG_SETTINGS;
  const B = TOKEN_TTL_BOUNDS;
  const CB = CLI_SETTINGS_BOUNDS;
  return {
    security: {
      allowSubAccountWithoutEmail:
        security.allowSubAccountWithoutEmail ?? d.security.allowSubAccountWithoutEmail,
      ipAllowlist: Array.isArray(security.ipAllowlist)
        ? security.ipAllowlist
        : d.security.ipAllowlist,
    },
    general: {
      timezone:
        typeof general.timezone === "string" && general.timezone
          ? general.timezone
          : d.general.timezone,
      pageSize: readTtl(
        general.pageSize,
        d.general.pageSize,
        PAGE_SIZE_BOUNDS.min,
        PAGE_SIZE_BOUNDS.max,
      ),
      // 0 = off (allowed); any other value clamps to the idle-lock bounds (ADR-0202).
      idleLockMinutes:
        general.idleLockMinutes === 0
          ? 0
          : readTtl(
              general.idleLockMinutes,
              d.general.idleLockMinutes,
              IDLE_LOCK_BOUNDS.min,
              IDLE_LOCK_BOUNDS.max,
            ),
      workerConfigVersionsKept: readTtl(
        general.workerConfigVersionsKept,
        d.general.workerConfigVersionsKept,
        WORKER_CONFIG_VERSIONS_BOUNDS.min,
        WORKER_CONFIG_VERSIONS_BOUNDS.max,
      ),
      checklistMax: readTtl(general.checklistMax, d.general.checklistMax, CHECKLIST_MAX_BOUNDS.min, CHECKLIST_MAX_BOUNDS.max),
      checklistVersionsKept: readTtl(
        general.checklistVersionsKept,
        d.general.checklistVersionsKept,
        WORKER_CONFIG_VERSIONS_BOUNDS.min,
        WORKER_CONFIG_VERSIONS_BOUNDS.max,
      ),
      workerConfigTemplatesMax: readTtl(
        general.workerConfigTemplatesMax,
        d.general.workerConfigTemplatesMax,
        CHECKLIST_MAX_BOUNDS.min,
        CHECKLIST_MAX_BOUNDS.max,
      ),
    },
    commandHistory: {
      store: typeof cmd.store === "boolean" ? cmd.store : d.commandHistory.store,
      retentionDays:
        typeof cmd.retentionDays === "number"
          ? cmd.retentionDays
          : d.commandHistory.retentionDays,
    },
    communityRetention: {
      forumPosts:
        typeof cr.forumPosts === "number" ? cr.forumPosts : d.communityRetention.forumPosts,
      messages: typeof cr.messages === "number" ? cr.messages : d.communityRetention.messages,
      attachments:
        typeof cr.attachments === "number" ? cr.attachments : d.communityRetention.attachments,
    },
    communityEdit: {
      editWindowMinutes: readEditWindow(ce.editWindowMinutes, d.communityEdit.editWindowMinutes),
      deleteWindowMinutes: readEditWindow(ce.deleteWindowMinutes, d.communityEdit.deleteWindowMinutes),
    },
    tokens: {
      web: {
        accessTtlSec: readTtl(
          tokens.web?.accessTtlSec,
          d.tokens.web.accessTtlSec,
          B.accessTtlSec.min,
          B.accessTtlSec.max,
        ),
        refreshTtlSec: readTtl(
          tokens.web?.refreshTtlSec,
          d.tokens.web.refreshTtlSec,
          B.refreshTtlSec.min,
          B.refreshTtlSec.max,
        ),
      },
      cli: {
        wsTokenTtlSec: readTtl(
          tokens.cli?.wsTokenTtlSec,
          d.tokens.cli.wsTokenTtlSec,
          B.wsTokenTtlSec.min,
          B.wsTokenTtlSec.max,
        ),
        hashcode3TtlSec: readHashcode3Ttl(tokens.cli?.hashcode3TtlSec, d.tokens.cli.hashcode3TtlSec),
      },
    },
    cli: {
      reconnectMaxBackoffSec: readTtl(
        cli.reconnectMaxBackoffSec,
        d.cli.reconnectMaxBackoffSec,
        CB.reconnectMaxBackoffSec.min,
        CB.reconnectMaxBackoffSec.max,
      ),
      autoUpdateDaily:
        typeof cli.autoUpdateDaily === "boolean" ? cli.autoUpdateDaily : d.cli.autoUpdateDaily,
      autoUpdateHour: readTtl(
        cli.autoUpdateHour,
        d.cli.autoUpdateHour,
        CB.autoUpdateHour.min,
        CB.autoUpdateHour.max,
      ),
    },
    storageAlerts: readStorageAlerts(settings?.storageAlerts),
    storageAutoClear: readStorageAutoClear(settings?.storageAutoClear),
    aiPoolId: typeof settings?.aiPoolId === "string" && settings.aiPoolId ? settings.aiPoolId : d.aiPoolId,
    network: readOrgNetworkSettings(settings?.network),
  };
}

/**
 * Return a copy of `Organization.settings` for responses (org-0001/0002): typed namespaces filled with
 * defaults, and the retired `mail` namespace (platform-only mail) stripped so a stale
 * stored value (which may hold credentials) is never returned.
 * @adr 0366
 */
export function maskOrgSettingsSecrets(
  settings: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const s = readOrgSettings(settings);
  const out: Record<string, unknown> = {
    ...(settings ?? {}),
    commandHistory: s.commandHistory,
    tokens: s.tokens,
    cli: s.cli,
  };
  delete out.mail;
  return out;
}

/** Response data of GET/PATCH /organizations/me. */
export interface OrgResponse {
  id: string;
  name: string;
  /** Slug login user org. @adr 0023 */
  slug: string;
  /** Memorable login alias set by ADMIN; null when unset. @adr 0111 */
  alias: string | null;
  settings: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/**
 * Login alias format: 3–40 chars of `[a-z0-9-]`, or empty string to clear it.
 * Reserved words are rejected server-side.
 * @adr 0111
 */
export const orgAliasSchema = z
  .string()
  .regex(/^([a-z0-9-]{3,40})?$/, "alias must be 3–40 chars of a–z, 0–9, -");

/**
 * Hosted-storage usage vs the plan cap, split into the 3 meter colours plus the
 * per-kind figures.
 * With `?userId`, `machineUser` carries that machine user's own cli footprint (across its links).
 * @api org-0004 @adr 0122 @adr 0365
 */
export interface StorageUsageResponse {
  /** `entitlements.templateStorageBytes` (total hosted cap); null = unlimited. */
  quotaBytes: number | null;
  /** messages + attachments + commandHistory + files. */
  usedBytes: number;
  /** When the counter was last reconciled — UI shows "as of N min ago". */
  computedAt: string;
  breakdown: {
    /** Text bytes — messages + 4rum posts + comments + memo (UI label "Text"). */
    messages: number;
    /** cli input + output + whole-machine log + history metadata. */
    commandHistory: number;
    /** Templates + artifacts + message/post/comment attachments + memo/AI-doc images and files. */
    files: number;
  };
  /** Per-kind bytes; the colours above are sums of these. */
  kinds: StorageKindBytes;
  /** `usedBytes ≥ quotaBytes` — writes/uploads/new AI runs are blocked (never true when unlimited). */
  full: boolean;
  /** Present only for `?userId`: that machine user's server-stored cli footprint (all its links). */
  machineUser?: {
    input: number;
    output: number;
    log: number;
  };
}

/**
 * Org overview for the Organization dashboard card — readable by **any** org member
 * (no permission gate), so every role sees the org's headline counts, this-month AI-token usage
 * and hosted-storage breakdown. Deliberately excludes billing identity (the plan name) — that
 * stays ADMIN-only on the subscription card.
 * @api org-0005
 */
export interface OrgOverviewResponse {
  /** Total non-deleted accounts in the org (humans + machines). */
  userCount: number;
  /** Rented (4PM-hosted pool) machine accounts currently surfaced into the org. @adr 0132 */
  rentedCount: number;
  /** Non-deleted teams. */
  teamCount: number;
  /** Non-deleted projects. */
  projectCount: number;
  /** This calendar month's org-wide AI-token usage vs the org quota (`limit` null = unlimited). */
  aiTokens: { used: number; limit: number | null };
  /** Hosted-storage breakdown vs the plan cap — same shape as `GET /organizations/me/storage-usage`. */
  storage: StorageUsageResponse;
}

/** Body PATCH /organizations/me (partial update). */
export const updateOrgRequestSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  // ADMIN-only login alias (ADR-0111); empty string clears it.
  alias: orgAliasSchema.optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
});
export type UpdateOrgRequest = z.infer<typeof updateOrgRequestSchema>;
