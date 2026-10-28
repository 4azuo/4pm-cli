/**
 * DTOs for the billing domain (manual plan assignment,
 * no payment gateway integrated yet).
 */
import { z } from "zod";
import {
  AddonKind,
  AddonStatus,
  PaymentMethod,
  PaymentProvider,
  QuotaOnExceed,
  QuotaPeriod,
  UsageMetric,
} from "@4pm/constants";

/** One limit in plans.limits — mapped to quotas when a plan is assigned. */
export const planLimitSchema = z.object({
  metric: z.enum([
    UsageMetric.AI_TOKENS,
    UsageMetric.COMMANDS,
    UsageMetric.AUTONOMOUS_MINUTES,
  ]),
  limit: z.number().int().min(0),
  period: z.enum([QuotaPeriod.DAY, QuotaPeriod.MONTH]),
  onExceed: z
    .enum([QuotaOnExceed.BLOCK, QuotaOnExceed.WARN])
    .default(QuotaOnExceed.BLOCK),
});
export type PlanLimit = z.infer<typeof planLimitSchema>;

/**
 * Plan entitlements — resource caps + feature gates, distinct from the per-period
 * usage `limits[]`. `null` = unlimited.
 * @adr 0105 @adr 0020
 */
export const planEntitlementsSchema = z.object({
  /** Max seats — every live user, MACHINE included; null = unlimited. @adr 0656 */
  maxUsers: z.number().int().min(1).nullable().default(null),
  /** Max projects; null = unlimited. */
  maxProjects: z.number().int().min(1).nullable().default(null),
  /** Allowed to create teams. */
  teams: z.boolean().default(false),
  /** Allowed to use Community/4rum. */
  community: z.boolean().default(false),
  /** Retention cap (days) for log/command/chat; null = unlimited. */
  retentionDays: z.number().int().min(1).nullable().default(null),
  /**
   * Total 4PM-hosted storage per org (bytes). Originally the template-file cap,
   * broadened by ADR-0122 to the org's WHOLE hosted storage: messages + command history
   * (cli input/output/log) + files (templates/attachments/artifacts). `null` = unlimited.
   * @adr 0113
   */
  templateStorageBytes: z.number().int().min(0).nullable().default(null),
  /** Per-file cap for a template upload (bytes); null = unlimited. @adr 0113 */
  templateFileMaxBytes: z.number().int().min(0).nullable().default(null),
  /**
   * How many 4PM-hosted machine-users the org may rent. Base plans grant `0`;
   * raised only by the `rented_machine` add-on. Never `null` (not "unlimited").
   * @adr 0126 @adr 0123 @adr 0124
   */
  rentedMachineSeats: z.number().int().min(0).default(0),
  /** Messenger chat writes. @adr 0357 */
  chat: z.boolean().default(false),
  /** Jira/GitHub/Backlog integration connections + sync. @adr 0357 */
  integrations: z.boolean().default(false),
  /** Create/edit worker pools + pool routing. @adr 0357 */
  machinePools: z.boolean().default(false),
  /** Publish packages / new versions to the Marketplace. @adr 0357 */
  marketPublish: z.boolean().default(false),
  /** Usage-alert rules + their evaluation. @adr 0357 */
  usageAlerts: z.boolean().default(false),
  /** Org SAML IdP config + SAML login. @adr 0357 */
  samlSso: z.boolean().default(false),
  /** Org audit log + activity-log drill-down. @adr 0357 */
  auditLog: z.boolean().default(false),
  /**
   * Plan AI Help questions per user per day; enforced = min(this, platform cap); null = no plan cap.
   * @adr 0357
   */
  helpDailyUserCap: z.number().int().min(0).nullable().default(10),
  /** Concurrent AI runs per org (run slots, excess queued); null = unlimited. @adr 0359 */
  maxConcurrentRuns: z.number().int().min(1).nullable().default(2),
  /** Live memo items per org across all tiers; null = unlimited. @adr 0365 */
  maxMemoItems: z.number().int().min(0).nullable().default(200),
  /**
   * New rows per autonomous book (USER_TODO / USER_QA / AI_TODO) per UTC month; null = unlimited.
   * @adr 0365
   */
  autonomousRequestsPerMonth: z.number().int().min(0).nullable().default(300),
  /** Org Announcements tab + `announcement-*` API. @adr 0367 */
  announcements: z.boolean().default(false),
  /** Announcement recipients per org per UTC day; null = unlimited. @adr 0367 */
  announcementDailyRecipients: z.number().int().min(0).nullable().default(0),
  /** Org AI Research tab + `research-*` API. @adr 0380 */
  aiResearch: z.boolean().default(false),
  /** Graph AI review + RAG AI doc finder + ER / system-diagram AI draft (AI jobs `graph-suggest` / `doc-find` / `er-draft` / `diagram-draft`). @adr 0488 @adr 0489 @adr 0491 @adr 0530 */
  aiDocInsights: z.boolean().default(false),
  /** CI/CD Security: subtab, security templates, AI security workflows, finding import. @adr 0606 */
  ciSecurity: z.boolean().default(false),
  /** Deploy environments per project (Free 1 · Pro 5 · Max 20); null = unlimited. @adr 0663 */
  maxDeployEnvironments: z.number().int().min(0).nullable().default(1),
  /** Scheduled deploys (deploy schedules + the scheduler). @adr 0663 */
  deploySchedules: z.boolean().default(false),
  /** Worker hosting — the `worker` deploy target. @adr 0664 */
  workerHosting: z.boolean().default(false),
  /** Marketing photos: Generate + AI compose of shots (reading stays open). Every plan since ADR-0662. @adr 0640 @adr 0662 */
  marketingPhotos: z.boolean().default(true),
  /** Marketing videos (P3b). Every plan since ADR-0662. @adr 0640 @adr 0662 */
  marketingVideo: z.boolean().default(true),
  /** Video Generate needs the project's Remotion license key (paid plans). @adr 0662 */
  remotionLicenseRequired: z.boolean().default(false),
  /** Created automation rules per org — org + project rules (0 = feature off); null = unlimited. @adr 0465 */
  automationRules: z.number().int().min(0).nullable().default(0),
  /** Automation rule runs per org per UTC day; null = unlimited. @adr 0458 */
  automationRunsPerDay: z.number().int().min(0).nullable().default(0),
  /** Live teams per org; null = unlimited. @adr 0656 */
  maxTeams: z.number().int().min(0).nullable().default(2),
  /** Org tags per org, and each project's own tags per project; null = unlimited. @adr 0656 */
  maxTags: z.number().int().min(0).nullable().default(20),
  /** Live API clients (public API, integrate-server) per org; null = unlimited. @adr 0656 */
  maxApiClients: z.number().int().min(0).nullable().default(2),
  /** Usage-alert rules per project; null = unlimited. @adr 0656 */
  maxProjectAlertRules: z.number().int().min(0).nullable().default(1),
  /** Personal usage-alert rules per user; null = unlimited. @adr 0656 */
  maxUserAlertRules: z.number().int().min(0).nullable().default(1),
  /** Projects / users / teams created per rolling 24 h, per kind (deleted rows count); null = unlimited. @adr 0656 */
  dailyCreateLimit: z.number().int().min(0).nullable().default(5),
});
export type PlanEntitlements = z.infer<typeof planEntitlementsSchema>;

/** Default entitlements = the `free` tier (applied when a plan/settings omits them). */
export const DEFAULT_ENTITLEMENTS: PlanEntitlements = {
  maxUsers: 5,
  maxProjects: 1,
  // Free tier gets 2 teams (ADR-0656).
  teams: true,
  community: false,
  retentionDays: 30,
  // Free tier: 100 MB total, 10 MB per file (ADR-0113).
  templateStorageBytes: 100 * 1024 * 1024,
  templateFileMaxBytes: 10 * 1024 * 1024,
  // No rented machine-user seats by default — bought via the `rented_machine` add-on (ADR-0126).
  rentedMachineSeats: 0,
  // Feature gates + per-plan limits of the Free tier (ADR-0357).
  chat: false,
  integrations: false,
  machinePools: false,
  marketPublish: false,
  // Free tier gets 1 usage-alert rule per project / per user (ADR-0656).
  usageAlerts: true,
  samlSso: false,
  auditLog: false,
  helpDailyUserCap: 10,
  maxConcurrentRuns: 2,
  maxMemoItems: 200,
  autonomousRequestsPerMonth: 300,
  // Free tier has no Announcements (ADR-0367).
  announcements: false,
  announcementDailyRecipients: 0,
  // Free tier has no AI Research (ADR-0380).
  aiResearch: false,
  // Free tier has no Graph AI review / RAG AI doc finder (ADR-0488).
  aiDocInsights: false,
  // Free tier has no CI/CD Security (ADR-0606).
  ciSecurity: false,
  // Free tier: one deploy environment, no schedules, no worker hosting (ADR-0663 / ADR-0664).
  maxDeployEnvironments: 1,
  deploySchedules: false,
  workerHosting: false,
  // Marketing photos / videos on every plan; Free renders without a Remotion key (ADR-0662).
  marketingPhotos: true,
  marketingVideo: true,
  remotionLicenseRequired: false,
  // Free tier has no automation rules (ADR-0458).
  automationRules: 0,
  automationRunsPerDay: 0,
  // Count caps + anti-churn of the Free tier (ADR-0656).
  maxTeams: 2,
  maxTags: 20,
  maxApiClients: 2,
  maxProjectAlertRules: 1,
  maxUserAlertRules: 1,
  dailyCreateLimit: 5,
};

/** Boolean feature gates of a plan — the `meta.feature` of `PLAN_FEATURE_UNAVAILABLE`. @adr 0105 @adr 0357 */
export type PlanFeature =
  | "teams"
  | "community"
  | "chat"
  | "integrations"
  | "machinePools"
  | "marketPublish"
  | "usageAlerts"
  | "samlSso"
  | "auditLog"
  | "announcements"
  | "aiResearch"
  | "aiDocInsights"
  | "ciSecurity"
  | "deploySchedules"
  | "workerHosting"
  | "marketingPhotos"
  | "marketingVideo";

/**
 * AI jobs (`AiJob` wire values) that need a plan feature — checked on `POST /commands` with `ai:true`.
 * @adr 0488 @adr 0489 @adr 0491
 */
export const AI_JOB_PLAN_FEATURE: Readonly<Record<string, PlanFeature>> = {
  "graph-suggest": "aiDocInsights",
  "doc-find": "aiDocInsights",
  "er-draft": "aiDocInsights",
  "diagram-draft": "aiDocInsights",
  "marketing-photos-generate": "marketingPhotos",
  "marketing-scenes-compose": "marketingPhotos",
  "marketing-video-compose": "marketingVideo",
  "marketing-video-generate": "marketingVideo",
};

/**
 * Read entitlements from the loosely-typed plan JSON, filling defaults (free) for missing
 * keys. `undefined`/absent numeric caps stay `null` only when explicitly null; otherwise the
 * free default is used so an empty `{}` behaves like `free`.
 */
export function readPlanEntitlements(
  value: Record<string, unknown> | null | undefined,
): PlanEntitlements {
  const v = (value ?? {}) as Partial<PlanEntitlements>;
  const num = (x: unknown, def: number | null): number | null =>
    x === null ? null : typeof x === "number" && Number.isFinite(x) ? Math.floor(x) : def;
  const d = DEFAULT_ENTITLEMENTS;
  const bool = (x: unknown, def: boolean): boolean => (typeof x === "boolean" ? x : def);
  return {
    maxUsers: num(v.maxUsers, d.maxUsers),
    maxProjects: num(v.maxProjects, d.maxProjects),
    teams: typeof v.teams === "boolean" ? v.teams : d.teams,
    community: typeof v.community === "boolean" ? v.community : d.community,
    retentionDays: num(v.retentionDays, d.retentionDays),
    templateStorageBytes: num(v.templateStorageBytes, d.templateStorageBytes),
    templateFileMaxBytes: num(v.templateFileMaxBytes, d.templateFileMaxBytes),
    rentedMachineSeats:
      typeof v.rentedMachineSeats === "number" && Number.isFinite(v.rentedMachineSeats)
        ? Math.max(0, Math.floor(v.rentedMachineSeats))
        : d.rentedMachineSeats,
    chat: bool(v.chat, d.chat),
    integrations: bool(v.integrations, d.integrations),
    machinePools: bool(v.machinePools, d.machinePools),
    marketPublish: bool(v.marketPublish, d.marketPublish),
    usageAlerts: bool(v.usageAlerts, d.usageAlerts),
    samlSso: bool(v.samlSso, d.samlSso),
    auditLog: bool(v.auditLog, d.auditLog),
    helpDailyUserCap: num(v.helpDailyUserCap, d.helpDailyUserCap),
    maxConcurrentRuns: num(v.maxConcurrentRuns, d.maxConcurrentRuns),
    maxMemoItems: num(v.maxMemoItems, d.maxMemoItems),
    autonomousRequestsPerMonth: num(v.autonomousRequestsPerMonth, d.autonomousRequestsPerMonth),
    announcements: bool(v.announcements, d.announcements),
    announcementDailyRecipients: num(v.announcementDailyRecipients, d.announcementDailyRecipients),
    aiResearch: bool(v.aiResearch, d.aiResearch),
    aiDocInsights: bool(v.aiDocInsights, d.aiDocInsights),
    ciSecurity: bool(v.ciSecurity, d.ciSecurity),
    maxDeployEnvironments: num(v.maxDeployEnvironments, d.maxDeployEnvironments),
    deploySchedules: bool(v.deploySchedules, d.deploySchedules),
    workerHosting: bool(v.workerHosting, d.workerHosting),
    marketingPhotos: bool(v.marketingPhotos, d.marketingPhotos),
    marketingVideo: bool(v.marketingVideo, d.marketingVideo),
    remotionLicenseRequired: bool(v.remotionLicenseRequired, d.remotionLicenseRequired),
    automationRules: num(v.automationRules, d.automationRules),
    automationRunsPerDay: num(v.automationRunsPerDay, d.automationRunsPerDay),
    maxTeams: num(v.maxTeams, d.maxTeams),
    maxTags: num(v.maxTags, d.maxTags),
    maxApiClients: num(v.maxApiClients, d.maxApiClients),
    maxProjectAlertRules: num(v.maxProjectAlertRules, d.maxProjectAlertRules),
    maxUserAlertRules: num(v.maxUserAlertRules, d.maxUserAlertRules),
    dailyCreateLimit: num(v.dailyCreateLimit, d.dailyCreateLimit),
  };
}

/** Entitlement caps a platform admin may override per org. @adr 0656 */
export const ENTITLEMENT_OVERRIDE_KEYS = [
  "maxUsers",
  "maxProjects",
  "maxTeams",
  "maxTags",
  "maxApiClients",
  "maxProjectAlertRules",
  "maxUserAlertRules",
  "maxMemoItems",
  "dailyCreateLimit",
] as const;
export type EntitlementOverrideKey = (typeof ENTITLEMENT_OVERRIDE_KEYS)[number];
/** Per-org overrides (`organization.settings.entitlementOverrides`): a number, `null` = unlimited, absent = plan. @adr 0656 */
export type EntitlementOverrides = Partial<Record<EntitlementOverrideKey, number | null>>;

/** Upper bound of an override value (sanity clamp; `null` is the way to say unlimited). @adr 0656 */
export const ENTITLEMENT_OVERRIDE_MAX = 1_000_000;

/** Read the overrides from loosely-typed org settings JSON, dropping unknown keys and bad values. @adr 0656 */
export function readEntitlementOverrides(value: unknown): EntitlementOverrides {
  const out: EntitlementOverrides = {};
  if (!value || typeof value !== "object") return out;
  const v = value as Record<string, unknown>;
  for (const k of ENTITLEMENT_OVERRIDE_KEYS) {
    if (!(k in v)) continue;
    const x = v[k];
    if (x === null) out[k] = null;
    else if (typeof x === "number" && Number.isFinite(x)) out[k] = Math.max(0, Math.min(ENTITLEMENT_OVERRIDE_MAX, Math.floor(x)));
  }
  return out;
}

/** One org's override editor data: the overrides, the plan's values and the effective values. @api admin-0107 @adr 0656 */
export interface OrgEntitlementOverridesView {
  /** The org's plan code (e.g. `pro`). */
  planCode: string;
  overrides: EntitlementOverrides;
  /** Plan + add-ons, before overrides. */
  plan: Record<EntitlementOverrideKey, number | null>;
  /** What the org gets now (overrides + license clamp applied). */
  effective: Record<EntitlementOverrideKey, number | null>;
}

/** Pick the overridable caps out of a full entitlement set. @adr 0656 */
export function pickOverridableCaps(ent: PlanEntitlements): Record<EntitlementOverrideKey, number | null> {
  return Object.fromEntries(ENTITLEMENT_OVERRIDE_KEYS.map((k) => [k, ent[k]])) as Record<EntitlementOverrideKey, number | null>;
}

/** Apply per-org overrides on top of the plan + add-on entitlements (before the license clamp). @adr 0656 */
export function applyEntitlementOverrides(ent: PlanEntitlements, overrides: EntitlementOverrides): PlanEntitlements {
  const out = { ...ent };
  for (const k of ENTITLEMENT_OVERRIDE_KEYS) {
    if (k in overrides) out[k] = overrides[k] ?? null;
  }
  return out;
}

/**
 * A held add-on projected from payment-server. Entitlement = `quantity` × the
 * per-unit `effect`, which payment-server resolves (storage/rented from the product, scale packs
 * from the live plan tier) — so the server owns no add-on effect table.
 * @adr 0123 @adr 0127
 */
export interface AddonQuantity {
  code: string;
  quantity: number;
  /** Per-unit entitlement delta (absent ⇒ no effect). */
  effect?: Partial<PlanEntitlements>;
}

/**
 * Effective entitlements = base plan + Σ (add-on quantity × addon.effect) — ADR-0124/0127.
 * A `null` (unlimited) base cap stays unlimited (the add-on is a no-op); `rentedMachineSeats`
 * always sums (base 0). No add-on code lookup — the per-unit effect travels on each add-on.
 */
export function applyAddonEffects(
  base: PlanEntitlements,
  addons: AddonQuantity[] | null | undefined,
): PlanEntitlements {
  const eff: PlanEntitlements = { ...base };
  for (const { quantity, effect } of addons ?? []) {
    const qty = Math.max(0, Math.floor(quantity || 0));
    if (qty === 0 || !effect) continue;
    if (effect.maxUsers != null && eff.maxUsers != null)
      eff.maxUsers += effect.maxUsers * qty;
    if (effect.maxProjects != null && eff.maxProjects != null)
      eff.maxProjects += effect.maxProjects * qty;
    if (effect.templateStorageBytes != null && eff.templateStorageBytes != null)
      eff.templateStorageBytes += effect.templateStorageBytes * qty;
    if (effect.rentedMachineSeats != null)
      eff.rentedMachineSeats += effect.rentedMachineSeats * qty;
  }
  return eff;
}

/** Plan returned by the API. */
export interface PlanResponse {
  code: string;
  name: string;
  price: number;
  limits: PlanLimit[];
  entitlements: PlanEntitlements;
}

/**
 * Plan returned by the PUBLIC catalog — for marketing/register
 * before login. Self-serve plans only; no raw provider handles, plus available `providers`.
 * @api billing-0010 @adr 0103
 */
export interface PublicPlanResponse {
  code: string;
  name: string;
  price: number;
  /** Billing cycle the `price` covers: `"month"` (default) or `"year"` (annual tier). @adr 0159 */
  billingCycle: "month" | "year";
  /** limits without `onExceed` (display only). */
  limits: Omit<PlanLimit, "onExceed">[];
  /** true = can be subscribed via checkout (free is self-serve/default). */
  selfServe: boolean;
  /** Providers offered for this plan (empty for `free` or when none configured). */
  providers: PaymentProvider[];
  /** Resource caps + feature gates — drives the pricing-card checklist. @adr 0105 */
  entitlements: PlanEntitlements;
}

/**
 * Body POST /billing/checkout. `provider` is required when >1 provider is
 * enabled; with a single provider it is optional and defaults to it.
 * @api billing-0005 @adr 0104
 */
export const checkoutRequestSchema = z.object({
  planCode: z.string().min(1).max(50),
  provider: z.enum([PaymentProvider.STRIPE, PaymentProvider.PAYPAL]).optional(),
});
export type CheckoutRequest = z.infer<typeof checkoutRequestSchema>;

/**
 * Result of a plan change. The target plan's full period is charged
 * first (wallet-first / card-fallback, `paidFrom`), then the old plan's unused remainder is
 * `refund`ed to the credit wallet. All amounts are integer USD units.
 * @api billing-0006 @adr 0163
 */
export interface ChangePlanResponse {
  /** Amount charged for the new plan's full period (= target price). */
  charged: number;
  /** Where `charged` came from: the credit wallet or the card. */
  paidFrom: "balance" | "card";
  /** Unused remainder of the old plan credited back to the wallet (0 when none). */
  refund: number;
}

/**
 * Read-only preview of a plan change — drives the confirm-and-pay
 * dialog before anything is committed. `payFrom: "card"` reports where the charge would come
 * from; it does not guarantee the card will succeed (billing-0006 can still fail).
 * @api billing-0024 @adr 0163
 */
export interface ChangeQuoteResponse {
  /** Target plan's full-period price (what billing-0006 will charge). */
  amountDue: number;
  /** Wallet when the balance covers `amountDue`, else card (no split — mirrors renewal). */
  payFrom: "balance" | "card";
  /** Unused remainder of the old plan that will be credited to the wallet. */
  refund: number;
  /** Old (current) plan's full-period price — the base the `refund` is prorated from. */
  currentPlanPrice: number;
  /** Old plan's billing interval in months — drives the `/yr` vs `/mo` label. @adr 0159 */
  currentPlanIntervalMonths: number;
  /** Total days in the old plan's current period (the proration denominator). */
  currentPeriodDays: number;
  /** Unused days left in the old plan's current period (the proration numerator, clamped). */
  remainingDays: number;
  /** Current wallet balance. */
  balanceBefore: number;
  /** Balance after the change (`balanceBefore − (payFrom==="balance" ? amountDue : 0) + refund`). */
  balanceAfter: number;
}

/** The org's current subscription. */
export interface SubscriptionResponse {
  id: string;
  planCode: string;
  planName: string;
  status: string;
  periodStart: string;
  periodEnd: string;
}

/** Body PUT /billing/subscription — assign a plan to the org (manual). */
export const assignPlanRequestSchema = z.object({
  planCode: z.string().min(1).max(50),
  /** Cycle length in days (defaults to 30). */
  periodDays: z.number().int().min(1).max(366).default(30),
});
export type AssignPlanRequest = z.infer<typeof assignPlanRequestSchema>;

// ── Subscription add-ons (ADR-0123/0125) ─────────────────────────────────────────────

/** A purchasable add-on SKU from the catalog. @api billing-0016 */
export interface AddonProduct {
  code: string;
  kind: AddonKind;
  /** Display name (i18n label key on the web). */
  name: string;
  /** Price per unit, same unit as `plan.price`. */
  unitPrice: number;
  active: boolean;
  /**
   * Per-unit entitlement delta — resolved by payment-server (storage/rented from the
   * product, scale packs from the mirrored live tier). Drives the web's GB / +caps display.
   * @adr 0127
   */
  effect?: Partial<PlanEntitlements>;
}

/** An add-on the org currently holds. @api billing-0016 */
export interface SubscriptionAddon {
  id: string;
  code: string;
  kind: AddonKind;
  quantity: number;
  /** Snapshot of the unit price at purchase. */
  unitPrice: number;
  status: AddonStatus;
  /** When cancellation was scheduled (period-end), if any. */
  canceledAt: string | null;
  /** When this add-on row was bought — the "Since" column (per-instance rows). @adr 0213 */
  createdAt: string;
  /**
   * Quantity effective at the next renewal. `0` ⇒ scheduled to cancel at period end
   * (still usable until then); `null` ⇒ no scheduled change (= `quantity`). Drives the "Cancelled —
   * until <period end>" status badge + the Undo (resume) action.
   * @adr 0210
   */
  scheduledQuantity: number | null;
  /**
   * Why this add-on is ending when a platform admin forced it: `provider_inactive` (the
   * storage SKU was deactivated). Set with `scheduledQuantity = 0`; the web shows a warning badge and
   * hides Cancel + Undo (the org can't act on a provider-forced end). Null ⇒ org-initiated / active.
   * @adr 0217
   */
  endReason?: string | null;
}

/** Response of GET /billing/addons — the catalog + the org's owned add-ons. */
export interface AddonsResponse {
  catalog: AddonProduct[];
  owned: SubscriptionAddon[];
}

/**
 * Body POST /billing/addons — buy/increase an add-on. `code` is any catalog SKU
 * (storage SKUs are admin-created — ADR-0127; validated against the catalog server-side).
 * @api billing-0017
 */
export const addonBuyRequestSchema = z.object({
  code: z.string().min(1).max(50),
  quantity: z.number().int().min(1).max(1000),
  /** Card path only; ignored when the org pays by credit. @adr 0104 @adr 0123 */
  provider: z.enum([PaymentProvider.STRIPE, PaymentProvider.PAYPAL]).optional(),
});
export type AddonBuyRequest = z.infer<typeof addonBuyRequestSchema>;

/** Body PATCH /billing/addons/:id — change quantity (0 ⇒ cancel at period end). @api billing-0018 */
export const addonChangeRequestSchema = z.object({
  quantity: z.number().int().min(0).max(1000),
  provider: z.enum([PaymentProvider.STRIPE, PaymentProvider.PAYPAL]).optional(),
});
export type AddonChangeRequest = z.infer<typeof addonChangeRequestSchema>;

/** Response of a buy/change — the add-on + an optional card checkout URL to confirm the charge. */
export interface AddonMutationResponse {
  addon: SubscriptionAddon;
  checkoutUrl?: string;
}

// ── Billing statement & invoices (ADR-0125) ──────────────────────────────────────────

/** One line of a statement / invoice — the plan or one add-on. */
export interface InvoiceLineItem {
  /** `"plan"` or an add-on catalog code. */
  code: string;
  /** `"plan"` or the add-on kind. */
  kind: string;
  /** Display label (i18n key on the web). */
  label: string;
  quantity: number;
  unitPrice: number;
  amount: number;
  /**
   * When this line is next charged (ISO) — ADR-0246: the plan and each add-on renew on their OWN
   * cycle (add-ons monthly, the plan on its tier), so the statement is an upcoming-charges timeline
   * ordered by this date. Absent ⇒ falls on the subscription period end.
   */
  chargeDate?: string;
}

/** GET /billing/statement — the org's upcoming charges, one line per plan/add-on. @api billing-0020 */
export interface StatementResponse {
  periodStart: string;
  periodEnd: string;
  paymentMethod: PaymentMethod;
  lineItems: InvoiceLineItem[];
  total: number;
  status: string;
  /** Present for the credit method (Top-up shortcut when short). */
  creditBalance?: number;
  /**
   * The plan's billing interval in months (1 = monthly, 12 = annual), so the web can forecast the plan's recurrence.
   * @adr 0159
   */
  planIntervalMonths?: number;
}

/** One row of the unified payment history — one charged period. @api billing-0008 */
export interface InvoiceResponse {
  id: string;
  number: string;
  total: number;
  currency: string;
  paymentMethod: PaymentMethod;
  status: string;
  periodStart: string;
  periodEnd: string;
  lineItems: InvoiceLineItem[];
  hostedUrl: string | null;
}

// ── Hosted machine-user pool (ADR-0126, admin-server) ────────────────────────────────

/** A 4PM-hosted machine-user pool slot. @api admin-0021 */
export interface HostedMachineSlot {
  id: string;
  label: string;
  region: string | null;
  /** The 4PM Claude profile the slot runs on (never an org account). */
  claudeProfileRef: string;
  status: string;
  rentedByOrgId: string | null;
  rentedMachineUserId: string | null;
  createdAt: string;
}

// ── Org-facing rental browse/pick (billing-0021/0022, ADR-0144) ───────────────────────

/** One rentable pool machine offered to an org — minimal, no pool-internal fields. @adr 0144 */
export interface RentableMachine {
  /** The pool MACHINE user's id — passed as `machineUserId` on the add-on buy to rent it. */
  id: string;
  /** Display label = the machine's username. */
  label: string;
  /** Region grouping label. */
  region: string;
  /** The machine's own rented price (credits/mo, admin-set per machine). @adr 0212 */
  price: number;
  /**
   * The machine's AI-account label: `exclusive` = its AI account is used by no other rented
   * machine, `shared` = shared with others; null = not set by the admin yet.
   * @adr 0354
   */
  rentalMode: "exclusive" | "shared" | null;
}

/** GET /billing/rentable-machines — the rentable pool + its distinct regions. @api billing-0021 */
export interface RentableMachinesResponse {
  machines: RentableMachine[];
  /** Distinct regions across the whole rentable pool, for the filter control. */
  regions: string[];
}

/**
 * The release-lifecycle state of a current rental. `released` rentals
 * drop out of the current list into history, so it never appears here.
 * @api billing-0022 @adr 0210
 */
export type RentalStatus = "active" | "cancelled" | "releasing";

/** One of the org's current rented-machine bindings. @api billing-0022 @adr 0144 @adr 0210 */
export interface RentalResponse {
  /** The MachineRental binding id. */
  id: string;
  /** The rented pool MACHINE user's id. */
  machineUserId: string;
  /** Display label = the machine's username. */
  label: string;
  /** Region grouping label. */
  region: string;
  startedAt: string;
  /** Release-lifecycle state — drives the per-machine Cancel/Re-Rent/Release-now actions. */
  status: RentalStatus;
  /** When a `cancelled` rental auto-releases (= the subscription's currentPeriodEnd); null otherwise. */
  releaseAt: string | null;
  /**
   * Set when a platform admin retired this machine while the org still rented it:
   * `provider_retired`. The rental is `cancelled` but the org cannot Re-Rent (undo) — the web shows a
   * warning badge and hides Cancel + Re-Rent. Null ⇒ the org's own Cancel (undoable).
   * @adr 0217
   */
  endReason?: string | null;
  /**
   * When this rental next renews (= the org subscription's `periodEnd`) for an `active` rental; `null`
   * for `cancelled`/`releasing` (they won't renew — they release). Shown as the "Next renewal" column.
   */
  nextRenewalAt: string | null;
  /** This machine's own rented price (credits/mo, admin-set per machine). @adr 0212 */
  price: number;
}

/**
 * One of the org's **past** rented-machine bindings — a closed
 * `MachineRental` (`active=false`). Read-only record of "the org rented `label` from
 * `startedAt` to `endedAt`"; the worker's data was scrubbed on release, so this
 * exposes only the binding, not the previous renter's activity.
 * @api billing-0023 @adr 0160 @adr 0132
 */
export interface RentalHistoryResponse {
  /** The MachineRental binding id. */
  id: string;
  /** The rented pool MACHINE user's id. */
  machineUserId: string;
  /** Display label = the machine's username. */
  label: string;
  /** Region grouping label. */
  region: string;
  startedAt: string;
  /** When the rental ended (release / dunning cancel). */
  endedAt: string;
}
