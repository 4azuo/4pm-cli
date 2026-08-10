/**
 * DTO for the organization domain (21-api/org-0001…0002).
 */
import { z } from "zod";
import { PaymentProvider } from "@4pm/constants";

/**
 * Pending paid-plan checkout recorded at register (ADR-0104), stored under
 * `settings.billing.pending`. After verify + first login the web opens the hosted checkout;
 * the subscription consumer clears it once the sub is active.
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

/** Security-related org policy (ADR-0039), stored under `settings.security`. */
export interface OrgSecuritySettings {
  /** Allow ADMIN to create sub-accounts without an email address. */
  allowSubAccountWithoutEmail: boolean;
  /**
   * Org-wide IP/CIDR allowlist — the outer boundary above each user's allowlist
   * (org > user inheritance, ADR-0044). Empty = no org-level restriction.
   */
  ipAllowlist: string[];
}

/** General/regional org policy (ADR-0039), stored under `settings.general`. */
export interface OrgGeneralSettings {
  /** IANA timezone name (e.g. "UTC", "Asia/Ho_Chi_Minh") — the org's default. */
  timezone: string;
  /**
   * Default rows per page for the org's paginated list views (ADR-0198). Drives the `size`
   * query the web sends; clamped to {@link PAGE_SIZE_BOUNDS}.
   */
  pageSize: number;
  /**
   * Idle privacy-lock timeout in minutes for the whole org (ADR-0202). After this much
   * inactivity the web covers the app with a backdrop until the user re-enters their password.
   * `0` disables it; other values clamp to {@link IDLE_LOCK_BOUNDS}.
   */
  idleLockMinutes: number;
}

/** Bounds (rows) for the list page size (ADR-0198) — values outside clamp to the default. */
export const PAGE_SIZE_BOUNDS = { min: 5, max: 100 } as const;

/** Default rows per page when unset (ADR-0198). */
export const DEFAULT_PAGE_SIZE = 10;

/** Bounds (minutes) for the idle privacy-lock (ADR-0202); `0` (off) is allowed separately. */
export const IDLE_LOCK_BOUNDS = { min: 1, max: 480 } as const;

/** Default idle privacy-lock timeout in minutes when unset (ADR-0202). */
export const DEFAULT_IDLE_LOCK_MINUTES = 30;

/** Mail provider identifiers (ADR-0007). */
export type OrgMailProvider = "console" | "smtp" | "ses" | "resend";

/**
 * Per-org mail provider config (ADR-0045), stored under `settings.mail` —
 * overrides ENV; empty falls back to ENV then defaults. Secrets (`smtp.pass`,
 * `resend.apiKey`) are write-only (masked in responses).
 */
export interface OrgMailSettings {
  provider: OrgMailProvider;
  from: string;
  smtp: { host: string; port: number; user: string; pass: string; secure: boolean };
  ses: { region: string };
  resend: { apiKey: string };
}

/**
 * Per-org command-history policy (ADR-0045), stored under `settings.commandHistory`.
 * `store=false` skips writing history files but still records recent activity
 * (`user_recent_projects`, ADR-0029). `retentionDays=0` keeps forever.
 */
export interface OrgCommandHistorySettings {
  store: boolean;
  retentionDays: number;
}

/**
 * Per-org token lifetimes (ADR-0056), stored under `settings.tokens`. Web uses
 * access + refresh JWT; cli maps `ws_token` → access and `hashcode3` → refresh
 * (the cli has no JWT). All values in **seconds**; `cli.hashcode3TtlSec = 0` means
 * "never expires". Empty/out-of-bound values fall back to the defaults below.
 */
export interface OrgTokenSettings {
  web: { accessTtlSec: number; refreshTtlSec: number };
  cli: { wsTokenTtlSec: number; hashcode3TtlSec: number };
}

/** Bounds (seconds) for token TTLs (ADR-0056) — values outside clamp to default. */
export const TOKEN_TTL_BOUNDS = {
  accessTtlSec: { min: 300, max: 86_400 },
  refreshTtlSec: { min: 3_600, max: 7_776_000 },
  wsTokenTtlSec: { min: 300, max: 604_800 },
  // hashcode3 also accepts the special value 0 ("never expires").
  hashcode3TtlSec: { min: 86_400, max: 31_536_000 },
} as const;

/**
 * Per-org cli runtime policy (ADR-0056), stored under `settings.cli`. Delivered to
 * the worker via the daily `ws_token` response. `reconnectMaxBackoffSec` caps the
 * exponential reconnect backoff when the server is unreachable — the cli retries
 * forever without unpairing, so this bounds the gap between attempts. All in seconds.
 */
export interface OrgCliSettings {
  reconnectMaxBackoffSec: number;
  /** Enable the daily scheduled cli auto-update (ADR-0074). */
  autoUpdateDaily: boolean;
  /** Hour of day (0–23, in the org timezone) the daily update runs (ADR-0074). */
  autoUpdateHour: number;
}

/**
 * Bounds for cli policy — the 1-min ceiling on the reconnect backoff (seconds) and the
 * 0–23 range for the daily auto-update hour (ADR-0074).
 */
export const CLI_SETTINGS_BOUNDS = {
  reconnectMaxBackoffSec: { min: 5, max: 60 },
  autoUpdateHour: { min: 0, max: 23 },
} as const;

/**
 * Per-org community retention (ADR-0112), stored under `settings.communityRetention`. Days;
 * `0` = keep forever. Each is capped at the plan's `retentionDays` (ADR-0105) on save.
 * Projected to @4pm/community (OrgRef) to drive its sweep: `forumPosts` (4rum),
 * `messages` (community messages), `attachments` (images & files — one knob).
 */
export interface OrgCommunityRetentionSettings {
  forumPosts: number;
  messages: number;
  attachments: number;
}

/** Typed view of `Organization.settings` (ADR-0039, ADR-0045, ADR-0056). */
export interface OrgSettings {
  security: OrgSecuritySettings;
  general: OrgGeneralSettings;
  mail: OrgMailSettings;
  commandHistory: OrgCommandHistorySettings;
  communityRetention: OrgCommunityRetentionSettings;
  tokens: OrgTokenSettings;
  cli: OrgCliSettings;
}

/** Defaults applied when a settings key is absent. */
export const DEFAULT_ORG_SETTINGS: OrgSettings = {
  security: { allowSubAccountWithoutEmail: false, ipAllowlist: [] },
  general: { timezone: "UTC", pageSize: DEFAULT_PAGE_SIZE, idleLockMinutes: DEFAULT_IDLE_LOCK_MINUTES },
  mail: {
    provider: "console",
    from: "",
    smtp: { host: "", port: 587, user: "", pass: "", secure: false },
    ses: { region: "" },
    resend: { apiKey: "" },
  },
  commandHistory: { store: false, retentionDays: 7 },
  communityRetention: { forumPosts: 0, messages: 0, attachments: 0 },
  tokens: {
    web: { accessTtlSec: 3_600, refreshTtlSec: 604_800 },
    cli: { wsTokenTtlSec: 86_400, hashcode3TtlSec: 0 },
  },
  cli: { reconnectMaxBackoffSec: 60, autoUpdateDaily: false, autoUpdateHour: 0 },
};

/** Read a numeric TTL, clamping out-of-range values back to `def` (ADR-0056). */
function readTtl(value: unknown, def: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max
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

/** Secret keys inside `settings.mail` that must never be returned in responses. */
export const MAIL_SECRET_PATHS = ["smtp.pass", "resend.apiKey"] as const;

/**
 * Read the typed org settings from the loosely-typed JSON store, filling in
 * defaults for any missing keys (ADR-0039).
 */
export function readOrgSettings(settings: Record<string, unknown> | null | undefined): OrgSettings {
  const security = (settings?.security ?? {}) as Partial<OrgSecuritySettings>;
  const general = (settings?.general ?? {}) as Partial<OrgGeneralSettings>;
  const mail = (settings?.mail ?? {}) as Partial<OrgMailSettings>;
  const smtp = (mail.smtp ?? {}) as Partial<OrgMailSettings["smtp"]>;
  const ses = (mail.ses ?? {}) as Partial<OrgMailSettings["ses"]>;
  const resend = (mail.resend ?? {}) as Partial<OrgMailSettings["resend"]>;
  const cmd = (settings?.commandHistory ?? {}) as Partial<OrgCommandHistorySettings>;
  const cr = (settings?.communityRetention ?? {}) as Partial<OrgCommunityRetentionSettings>;
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
    },
    mail: {
      provider: (["console", "smtp", "ses", "resend"] as const).includes(
        mail.provider as OrgMailProvider,
      )
        ? (mail.provider as OrgMailProvider)
        : d.mail.provider,
      from: typeof mail.from === "string" ? mail.from : d.mail.from,
      smtp: {
        host: typeof smtp.host === "string" ? smtp.host : d.mail.smtp.host,
        port: typeof smtp.port === "number" ? smtp.port : d.mail.smtp.port,
        user: typeof smtp.user === "string" ? smtp.user : d.mail.smtp.user,
        pass: typeof smtp.pass === "string" ? smtp.pass : d.mail.smtp.pass,
        secure: typeof smtp.secure === "boolean" ? smtp.secure : d.mail.smtp.secure,
      },
      ses: { region: typeof ses.region === "string" ? ses.region : d.mail.ses.region },
      resend: {
        apiKey: typeof resend.apiKey === "string" ? resend.apiKey : d.mail.resend.apiKey,
      },
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
  };
}

/**
 * Return a copy of `Organization.settings` with mail secrets removed and replaced
 * by boolean `…Set` flags — for responses (org-0001/0002, ADR-0045 write-only).
 */
export function maskOrgSettingsSecrets(
  settings: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const s = readOrgSettings(settings);
  return {
    ...(settings ?? {}),
    mail: {
      provider: s.mail.provider,
      from: s.mail.from,
      smtp: {
        host: s.mail.smtp.host,
        port: s.mail.smtp.port,
        user: s.mail.smtp.user,
        secure: s.mail.smtp.secure,
        passSet: s.mail.smtp.pass.length > 0,
      },
      ses: { region: s.mail.ses.region },
      resend: { apiKeySet: s.mail.resend.apiKey.length > 0 },
    },
    commandHistory: s.commandHistory,
    tokens: s.tokens,
    cli: s.cli,
  };
}

/** Response data of GET/PATCH /organizations/me. */
export interface OrgResponse {
  id: string;
  name: string;
  /** Slug login user org (ADR-0023). */
  slug: string;
  /** Memorable login alias set by ADMIN (ADR-0111); null when unset. */
  alias: string | null;
  settings: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/**
 * Login alias format (ADR-0111): 3–40 chars of `[a-z0-9-]`, or empty string to clear it.
 * Reserved words are rejected server-side.
 */
export const orgAliasSchema = z
  .string()
  .regex(/^([a-z0-9-]{3,40})?$/, "alias must be 3–40 chars of a–z, 0–9, -");

/**
 * org-0004 — hosted-storage usage vs the plan cap, split into the 3 MEMO colours (ADR-0122).
 * With `?userId`, `machineUser` carries that machine user's own cli footprint (across its links).
 */
export interface StorageUsageResponse {
  /** `entitlements.templateStorageBytes` (total hosted cap); null = unlimited. */
  quotaBytes: number | null;
  /** messages + attachments + commandHistory + files. */
  usedBytes: number;
  /** When the counter was last reconciled — UI shows "as of N min ago". */
  computedAt: string;
  breakdown: {
    /** Community message-body bytes. */
    messages: number;
    /** cli input + output + whole-machine log + history metadata. */
    commandHistory: number;
    /** Template files + community attachments + project artifacts. */
    files: number;
  };
  /** Present only for `?userId`: that machine user's server-stored cli footprint (all its links). */
  machineUser?: {
    input: number;
    output: number;
    log: number;
  };
}

/** Body PATCH /organizations/me (partial update). */
export const updateOrgRequestSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  // ADMIN-only login alias (ADR-0111); empty string clears it.
  alias: orgAliasSchema.optional(),
  settings: z.record(z.unknown()).optional(),
});
export type UpdateOrgRequest = z.infer<typeof updateOrgRequestSchema>;
