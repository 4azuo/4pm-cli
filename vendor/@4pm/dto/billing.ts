/**
 * Vendored from @4pm/dto (billing.ts) by scripts/vendor-shared.mjs — do not edit.
 */
import { z } from "zod";
import { AddonKind, AddonStatus, PaymentMethod, PaymentProvider, QuotaOnExceed, QuotaPeriod, UsageMetric, } from "@4pm/shared-constants";
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
export const planEntitlementsSchema = z.object({
    maxUsers: z.number().int().min(1).nullable().default(null),
    maxProjects: z.number().int().min(1).nullable().default(null),
    teams: z.boolean().default(false),
    community: z.boolean().default(false),
    retentionDays: z.number().int().min(1).nullable().default(null),
    templateStorageBytes: z.number().int().min(0).nullable().default(null),
    templateFileMaxBytes: z.number().int().min(0).nullable().default(null),
    rentedMachineSeats: z.number().int().min(0).default(0),
    chat: z.boolean().default(false),
    integrations: z.boolean().default(false),
    machinePools: z.boolean().default(false),
    marketPublish: z.boolean().default(false),
    usageAlerts: z.boolean().default(false),
    samlSso: z.boolean().default(false),
    auditLog: z.boolean().default(false),
    helpDailyUserCap: z.number().int().min(0).nullable().default(10),
    maxConcurrentRuns: z.number().int().min(1).nullable().default(2),
    maxMemoItems: z.number().int().min(0).nullable().default(200),
    autonomousRequestsPerMonth: z.number().int().min(0).nullable().default(300),
    announcements: z.boolean().default(false),
    announcementDailyRecipients: z.number().int().min(0).nullable().default(0),
    aiResearch: z.boolean().default(false),
    aiDocInsights: z.boolean().default(false),
    ciSecurity: z.boolean().default(false),
    maxDeployEnvironments: z.number().int().min(0).nullable().default(1),
    deploySchedules: z.boolean().default(false),
    workerHosting: z.boolean().default(false),
    marketingPhotos: z.boolean().default(true),
    marketingVideo: z.boolean().default(true),
    remotionLicenseRequired: z.boolean().default(false),
    automationRules: z.number().int().min(0).nullable().default(0),
    automationRunsPerDay: z.number().int().min(0).nullable().default(0),
    maxTeams: z.number().int().min(0).nullable().default(2),
    maxTags: z.number().int().min(0).nullable().default(20),
    maxApiClients: z.number().int().min(0).nullable().default(2),
    maxProjectAlertRules: z.number().int().min(0).nullable().default(1),
    maxUserAlertRules: z.number().int().min(0).nullable().default(1),
    dailyCreateLimit: z.number().int().min(0).nullable().default(5),
});
export type PlanEntitlements = z.infer<typeof planEntitlementsSchema>;
export const DEFAULT_ENTITLEMENTS: PlanEntitlements = {
    maxUsers: 5,
    maxProjects: 1,
    teams: true,
    community: false,
    retentionDays: 30,
    templateStorageBytes: 100 * 1024 * 1024,
    templateFileMaxBytes: 10 * 1024 * 1024,
    rentedMachineSeats: 0,
    chat: false,
    integrations: false,
    machinePools: false,
    marketPublish: false,
    usageAlerts: true,
    samlSso: false,
    auditLog: false,
    helpDailyUserCap: 10,
    maxConcurrentRuns: 2,
    maxMemoItems: 200,
    autonomousRequestsPerMonth: 300,
    announcements: false,
    announcementDailyRecipients: 0,
    aiResearch: false,
    aiDocInsights: false,
    ciSecurity: false,
    maxDeployEnvironments: 1,
    deploySchedules: false,
    workerHosting: false,
    marketingPhotos: true,
    marketingVideo: true,
    remotionLicenseRequired: false,
    automationRules: 0,
    automationRunsPerDay: 0,
    maxTeams: 2,
    maxTags: 20,
    maxApiClients: 2,
    maxProjectAlertRules: 1,
    maxUserAlertRules: 1,
    dailyCreateLimit: 5,
};
export type PlanFeature = "teams" | "community" | "chat" | "integrations" | "machinePools" | "marketPublish" | "usageAlerts" | "samlSso" | "auditLog" | "announcements" | "aiResearch" | "aiDocInsights" | "ciSecurity" | "deploySchedules" | "workerHosting" | "marketingPhotos" | "marketingVideo";
export const AI_JOB_PLAN_FEATURE: Readonly<Record<string, PlanFeature>> = {
    "graph-suggest": "aiDocInsights",
    "doc-find": "aiDocInsights",
    "er-draft": "aiDocInsights",
    "diagram-draft": "aiDocInsights",
    "flow-map": "aiDocInsights",
    "flow-map-update": "aiDocInsights",
    "marketing-photos-generate": "marketingPhotos",
    "marketing-scenes-compose": "marketingPhotos",
    "marketing-video-compose": "marketingVideo",
    "marketing-video-generate": "marketingVideo",
};
export function readPlanEntitlements(value: Record<string, unknown> | null | undefined): PlanEntitlements {
    const v = (value ?? {}) as Partial<PlanEntitlements>;
    const num = (x: unknown, def: number | null): number | null => x === null ? null : typeof x === "number" && Number.isFinite(x) ? Math.floor(x) : def;
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
        rentedMachineSeats: typeof v.rentedMachineSeats === "number" && Number.isFinite(v.rentedMachineSeats)
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
export type EntitlementOverrides = Partial<Record<EntitlementOverrideKey, number | null>>;
export const ENTITLEMENT_OVERRIDE_MAX = 1000000;
export function readEntitlementOverrides(value: unknown): EntitlementOverrides {
    const out: EntitlementOverrides = {};
    if (!value || typeof value !== "object")
        return out;
    const v = value as Record<string, unknown>;
    for (const k of ENTITLEMENT_OVERRIDE_KEYS) {
        if (!(k in v))
            continue;
        const x = v[k];
        if (x === null)
            out[k] = null;
        else if (typeof x === "number" && Number.isFinite(x))
            out[k] = Math.max(0, Math.min(ENTITLEMENT_OVERRIDE_MAX, Math.floor(x)));
    }
    return out;
}
export interface OrgEntitlementOverridesView {
    planCode: string;
    overrides: EntitlementOverrides;
    plan: Record<EntitlementOverrideKey, number | null>;
    effective: Record<EntitlementOverrideKey, number | null>;
}
export function pickOverridableCaps(ent: PlanEntitlements): Record<EntitlementOverrideKey, number | null> {
    return Object.fromEntries(ENTITLEMENT_OVERRIDE_KEYS.map((k) => [k, ent[k]])) as Record<EntitlementOverrideKey, number | null>;
}
export function applyEntitlementOverrides(ent: PlanEntitlements, overrides: EntitlementOverrides): PlanEntitlements {
    const out = { ...ent };
    for (const k of ENTITLEMENT_OVERRIDE_KEYS) {
        if (k in overrides)
            out[k] = overrides[k] ?? null;
    }
    return out;
}
export interface AddonQuantity {
    code: string;
    quantity: number;
    effect?: Partial<PlanEntitlements>;
}
export function applyAddonEffects(base: PlanEntitlements, addons: AddonQuantity[] | null | undefined): PlanEntitlements {
    const eff: PlanEntitlements = { ...base };
    for (const { quantity, effect } of addons ?? []) {
        const qty = Math.max(0, Math.floor(quantity || 0));
        if (qty === 0 || !effect)
            continue;
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
export interface PlanResponse {
    code: string;
    name: string;
    price: number;
    limits: PlanLimit[];
    entitlements: PlanEntitlements;
}
export interface PublicPlanResponse {
    code: string;
    name: string;
    price: number;
    billingCycle: "month" | "year";
    limits: Omit<PlanLimit, "onExceed">[];
    selfServe: boolean;
    providers: PaymentProvider[];
    entitlements: PlanEntitlements;
}
export const checkoutRequestSchema = z.object({
    planCode: z.string().min(1).max(50),
    provider: z.enum([PaymentProvider.STRIPE, PaymentProvider.PAYPAL]).optional(),
});
export type CheckoutRequest = z.infer<typeof checkoutRequestSchema>;
export interface ChangePlanResponse {
    charged: number;
    paidFrom: "balance" | "card";
    refund: number;
}
export interface ChangeQuoteResponse {
    amountDue: number;
    payFrom: "balance" | "card";
    refund: number;
    currentPlanPrice: number;
    currentPlanIntervalMonths: number;
    currentPeriodDays: number;
    remainingDays: number;
    balanceBefore: number;
    balanceAfter: number;
}
export interface SubscriptionResponse {
    id: string;
    planCode: string;
    planName: string;
    status: string;
    periodStart: string;
    periodEnd: string;
}
export const assignPlanRequestSchema = z.object({
    planCode: z.string().min(1).max(50),
    periodDays: z.number().int().min(1).max(366).default(30),
});
export type AssignPlanRequest = z.infer<typeof assignPlanRequestSchema>;
export interface AddonProduct {
    code: string;
    kind: AddonKind;
    name: string;
    unitPrice: number;
    active: boolean;
    effect?: Partial<PlanEntitlements>;
}
export interface SubscriptionAddon {
    id: string;
    code: string;
    kind: AddonKind;
    quantity: number;
    unitPrice: number;
    status: AddonStatus;
    canceledAt: string | null;
    createdAt: string;
    scheduledQuantity: number | null;
    endReason?: string | null;
}
export interface AddonsResponse {
    catalog: AddonProduct[];
    owned: SubscriptionAddon[];
}
export const addonBuyRequestSchema = z.object({
    code: z.string().min(1).max(50),
    quantity: z.number().int().min(1).max(1000),
    provider: z.enum([PaymentProvider.STRIPE, PaymentProvider.PAYPAL]).optional(),
});
export type AddonBuyRequest = z.infer<typeof addonBuyRequestSchema>;
export const addonChangeRequestSchema = z.object({
    quantity: z.number().int().min(0).max(1000),
    provider: z.enum([PaymentProvider.STRIPE, PaymentProvider.PAYPAL]).optional(),
});
export type AddonChangeRequest = z.infer<typeof addonChangeRequestSchema>;
export interface AddonMutationResponse {
    addon: SubscriptionAddon;
    checkoutUrl?: string;
}
export interface InvoiceLineItem {
    code: string;
    kind: string;
    label: string;
    quantity: number;
    unitPrice: number;
    amount: number;
    chargeDate?: string;
}
export interface StatementResponse {
    periodStart: string;
    periodEnd: string;
    paymentMethod: PaymentMethod;
    lineItems: InvoiceLineItem[];
    total: number;
    status: string;
    creditBalance?: number;
    planIntervalMonths?: number;
}
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
export interface HostedMachineSlot {
    id: string;
    label: string;
    region: string | null;
    claudeProfileRef: string;
    status: string;
    rentedByOrgId: string | null;
    rentedMachineUserId: string | null;
    createdAt: string;
}
export interface RentableMachine {
    id: string;
    label: string;
    region: string;
    price: number;
    rentalMode: "exclusive" | "shared" | null;
}
export interface RentableMachinesResponse {
    machines: RentableMachine[];
    regions: string[];
}
export type RentalStatus = "active" | "cancelled" | "releasing";
export interface RentalResponse {
    id: string;
    machineUserId: string;
    label: string;
    region: string;
    startedAt: string;
    status: RentalStatus;
    releaseAt: string | null;
    endReason?: string | null;
    nextRenewalAt: string | null;
    price: number;
}
export interface RentalHistoryResponse {
    id: string;
    machineUserId: string;
    label: string;
    region: string;
    startedAt: string;
    endedAt: string;
}
