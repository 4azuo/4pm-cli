/**
 * Vendored from @4pm/dto (org.ts) by scripts/vendor-shared.mjs — do not edit.
 */
import { DEFAULT_STORAGE_AUTO_CLEAR, readStorageAlerts, readStorageAutoClear, type StorageAlertRule, type StorageAutoClearSettings, type StorageKindBytes, } from "./storage";
import { z } from "zod";
import { MfaPolicy, PaymentProvider } from "@4pm/shared-constants";
import { readOrgNetworkSettings, type OrgNetworkSettings } from "./network";
import type { EntitlementOverrides, OrgEntitlementOverridesView } from "./billing";
export interface BillingPendingCheckout {
    planCode: string;
    provider?: PaymentProvider;
}
export function readPendingCheckout(settings: Record<string, unknown> | null | undefined): BillingPendingCheckout | null {
    const billing = settings?.billing as {
        pending?: unknown;
    } | undefined;
    const pending = billing?.pending as Partial<BillingPendingCheckout> | undefined;
    if (!pending || typeof pending.planCode !== "string" || pending.planCode.length === 0) {
        return null;
    }
    const provider = pending.provider === PaymentProvider.STRIPE || pending.provider === PaymentProvider.PAYPAL
        ? pending.provider
        : undefined;
    return { planCode: pending.planCode, provider };
}
export interface OrgSecuritySettings {
    allowSubAccountWithoutEmail: boolean;
    ipAllowlist: string[];
    mfaPolicy: MfaPolicy;
    allowForeignHooks: boolean;
    passwordMaxAgeDays: number;
}
export const PASSWORD_MAX_AGE_BOUNDS = { min: 0, max: 365 } as const;
export interface OrgGeneralSettings {
    timezone: string;
    pageSize: number;
    idleLockMinutes: number;
    workerConfigVersionsKept: number;
    checklistMax: number;
    checklistVersionsKept: number;
    workerConfigTemplatesMax: number;
}
export const PAGE_SIZE_BOUNDS = { min: 5, max: 100 } as const;
export const DEFAULT_PAGE_SIZE = 10;
export const IDLE_LOCK_BOUNDS = { min: 1, max: 480 } as const;
export const DEFAULT_IDLE_LOCK_MINUTES = 30;
export const WORKER_CONFIG_VERSIONS_BOUNDS = { min: 1, max: 100 } as const;
export const DEFAULT_WORKER_CONFIG_VERSIONS_KEPT = 10;
export interface OrgResourceCaps {
    checklistMax: number;
    checklistVersionsKept: number;
    workerConfigTemplatesMax: number;
    workerConfigVersionsKept: number;
}
export interface OrgCapsDetail extends OrgResourceCaps {
    entitlements: OrgEntitlementOverridesView;
}
export interface SetOrgCapsRequest extends Partial<OrgResourceCaps> {
    overrides?: EntitlementOverrides;
    reason?: string;
}
export const CHECKLIST_MAX_BOUNDS = { min: 1, max: 1000 } as const;
export const DEFAULT_CHECKLIST_MAX = 100;
export const DEFAULT_CHECKLIST_VERSIONS_KEPT = 10;
export const DEFAULT_WORKER_CONFIG_TEMPLATES_MAX = 100;
export interface OrgCommandHistorySettings {
    store: boolean;
    retentionDays: number;
}
export interface OrgTokenSettings {
    web: {
        accessTtlSec: number;
        refreshTtlSec: number;
    };
    cli: {
        wsTokenTtlSec: number;
        hashcode3TtlSec: number;
    };
    client: {
        refreshTtlSec: number;
    };
}
export const TOKEN_TTL_BOUNDS = {
    accessTtlSec: { min: 300, max: 86400 },
    refreshTtlSec: { min: 3600, max: 7776000 },
    clientRefreshTtlSec: { min: 3600, max: 15552000 },
    wsTokenTtlSec: { min: 300, max: 604800 },
    hashcode3TtlSec: { min: 86400, max: 31536000 },
} as const;
export interface OrgCliSettings {
    reconnectMaxBackoffSec: number;
    autoUpdateDaily: boolean;
    autoUpdateHour: number;
}
export const CLI_SETTINGS_BOUNDS = {
    reconnectMaxBackoffSec: { min: 5, max: 60 },
    autoUpdateHour: { min: 0, max: 23 },
} as const;
export interface OrgCommunityRetentionSettings {
    forumPosts: number;
    messages: number;
    attachments: number;
}
export interface OrgCommunityEditSettings {
    editWindowMinutes: number;
    deleteWindowMinutes: number;
}
export const COMMUNITY_EDIT_WINDOW_MAX_MINUTES = 43200;
export interface OrgSettings {
    security: OrgSecuritySettings;
    general: OrgGeneralSettings;
    commandHistory: OrgCommandHistorySettings;
    communityRetention: OrgCommunityRetentionSettings;
    communityEdit: OrgCommunityEditSettings;
    tokens: OrgTokenSettings;
    cli: OrgCliSettings;
    storageAlerts: StorageAlertRule[];
    storageAutoClear: StorageAutoClearSettings;
    aiPoolId: string | null;
    network: OrgNetworkSettings;
}
export const DEFAULT_ORG_SETTINGS: OrgSettings = {
    security: { allowSubAccountWithoutEmail: false, ipAllowlist: [], mfaPolicy: MfaPolicy.ADMINS, allowForeignHooks: false, passwordMaxAgeDays: 0 },
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
        web: { accessTtlSec: 3600, refreshTtlSec: 604800 },
        cli: { wsTokenTtlSec: 86400, hashcode3TtlSec: 0 },
        client: { refreshTtlSec: 2592000 },
    },
    cli: { reconnectMaxBackoffSec: 60, autoUpdateDaily: false, autoUpdateHour: 0 },
    storageAlerts: [],
    storageAutoClear: DEFAULT_STORAGE_AUTO_CLEAR,
    aiPoolId: null,
    network: { deny: [] },
};
function readTtl(value: unknown, def: number, min: number, max: number): number {
    return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max
        ? Math.floor(value)
        : def;
}
function readEditWindow(value: unknown, def: number): number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= COMMUNITY_EDIT_WINDOW_MAX_MINUTES
        ? Math.floor(value)
        : def;
}
function readHashcode3Ttl(value: unknown, def: number): number {
    if (typeof value !== "number" || !Number.isFinite(value))
        return def;
    if (value === 0)
        return 0;
    const b = TOKEN_TTL_BOUNDS.hashcode3TtlSec;
    return value >= b.min && value <= b.max ? Math.floor(value) : def;
}
export function readOrgSettings(settings: Record<string, unknown> | null | undefined): OrgSettings {
    const security = (settings?.security ?? {}) as Partial<OrgSecuritySettings>;
    const general = (settings?.general ?? {}) as Partial<OrgGeneralSettings>;
    const cmd = (settings?.commandHistory ?? {}) as Partial<OrgCommandHistorySettings>;
    const cr = (settings?.communityRetention ?? {}) as Partial<OrgCommunityRetentionSettings>;
    const ce = (settings?.communityEdit ?? {}) as Partial<OrgCommunityEditSettings>;
    const tokens = (settings?.tokens ?? {}) as {
        web?: Partial<OrgTokenSettings["web"]>;
        cli?: Partial<OrgTokenSettings["cli"]>;
        client?: Partial<OrgTokenSettings["client"]>;
    };
    const cli = (settings?.cli ?? {}) as Partial<OrgCliSettings>;
    const d = DEFAULT_ORG_SETTINGS;
    const B = TOKEN_TTL_BOUNDS;
    const CB = CLI_SETTINGS_BOUNDS;
    return {
        security: {
            allowSubAccountWithoutEmail: security.allowSubAccountWithoutEmail ?? d.security.allowSubAccountWithoutEmail,
            ipAllowlist: Array.isArray(security.ipAllowlist)
                ? security.ipAllowlist
                : d.security.ipAllowlist,
            mfaPolicy: (Object.values(MfaPolicy) as string[]).includes(security.mfaPolicy as string)
                ? (security.mfaPolicy as MfaPolicy)
                : d.security.mfaPolicy,
            allowForeignHooks: typeof security.allowForeignHooks === "boolean" ? security.allowForeignHooks : d.security.allowForeignHooks,
            passwordMaxAgeDays: Number.isInteger(security.passwordMaxAgeDays) &&
                (security.passwordMaxAgeDays as number) >= PASSWORD_MAX_AGE_BOUNDS.min &&
                (security.passwordMaxAgeDays as number) <= PASSWORD_MAX_AGE_BOUNDS.max
                ? (security.passwordMaxAgeDays as number)
                : d.security.passwordMaxAgeDays,
        },
        general: {
            timezone: typeof general.timezone === "string" && general.timezone
                ? general.timezone
                : d.general.timezone,
            pageSize: readTtl(general.pageSize, d.general.pageSize, PAGE_SIZE_BOUNDS.min, PAGE_SIZE_BOUNDS.max),
            idleLockMinutes: general.idleLockMinutes === 0
                ? 0
                : readTtl(general.idleLockMinutes, d.general.idleLockMinutes, IDLE_LOCK_BOUNDS.min, IDLE_LOCK_BOUNDS.max),
            workerConfigVersionsKept: readTtl(general.workerConfigVersionsKept, d.general.workerConfigVersionsKept, WORKER_CONFIG_VERSIONS_BOUNDS.min, WORKER_CONFIG_VERSIONS_BOUNDS.max),
            checklistMax: readTtl(general.checklistMax, d.general.checklistMax, CHECKLIST_MAX_BOUNDS.min, CHECKLIST_MAX_BOUNDS.max),
            checklistVersionsKept: readTtl(general.checklistVersionsKept, d.general.checklistVersionsKept, WORKER_CONFIG_VERSIONS_BOUNDS.min, WORKER_CONFIG_VERSIONS_BOUNDS.max),
            workerConfigTemplatesMax: readTtl(general.workerConfigTemplatesMax, d.general.workerConfigTemplatesMax, CHECKLIST_MAX_BOUNDS.min, CHECKLIST_MAX_BOUNDS.max),
        },
        commandHistory: {
            store: typeof cmd.store === "boolean" ? cmd.store : d.commandHistory.store,
            retentionDays: typeof cmd.retentionDays === "number"
                ? cmd.retentionDays
                : d.commandHistory.retentionDays,
        },
        communityRetention: {
            forumPosts: typeof cr.forumPosts === "number" ? cr.forumPosts : d.communityRetention.forumPosts,
            messages: typeof cr.messages === "number" ? cr.messages : d.communityRetention.messages,
            attachments: typeof cr.attachments === "number" ? cr.attachments : d.communityRetention.attachments,
        },
        communityEdit: {
            editWindowMinutes: readEditWindow(ce.editWindowMinutes, d.communityEdit.editWindowMinutes),
            deleteWindowMinutes: readEditWindow(ce.deleteWindowMinutes, d.communityEdit.deleteWindowMinutes),
        },
        tokens: {
            web: {
                accessTtlSec: readTtl(tokens.web?.accessTtlSec, d.tokens.web.accessTtlSec, B.accessTtlSec.min, B.accessTtlSec.max),
                refreshTtlSec: readTtl(tokens.web?.refreshTtlSec, d.tokens.web.refreshTtlSec, B.refreshTtlSec.min, B.refreshTtlSec.max),
            },
            cli: {
                wsTokenTtlSec: readTtl(tokens.cli?.wsTokenTtlSec, d.tokens.cli.wsTokenTtlSec, B.wsTokenTtlSec.min, B.wsTokenTtlSec.max),
                hashcode3TtlSec: readHashcode3Ttl(tokens.cli?.hashcode3TtlSec, d.tokens.cli.hashcode3TtlSec),
            },
            client: {
                refreshTtlSec: readTtl(tokens.client?.refreshTtlSec, d.tokens.client.refreshTtlSec, B.clientRefreshTtlSec.min, B.clientRefreshTtlSec.max),
            },
        },
        cli: {
            reconnectMaxBackoffSec: readTtl(cli.reconnectMaxBackoffSec, d.cli.reconnectMaxBackoffSec, CB.reconnectMaxBackoffSec.min, CB.reconnectMaxBackoffSec.max),
            autoUpdateDaily: typeof cli.autoUpdateDaily === "boolean" ? cli.autoUpdateDaily : d.cli.autoUpdateDaily,
            autoUpdateHour: readTtl(cli.autoUpdateHour, d.cli.autoUpdateHour, CB.autoUpdateHour.min, CB.autoUpdateHour.max),
        },
        storageAlerts: readStorageAlerts(settings?.storageAlerts),
        storageAutoClear: readStorageAutoClear(settings?.storageAutoClear),
        aiPoolId: typeof settings?.aiPoolId === "string" && settings.aiPoolId ? settings.aiPoolId : d.aiPoolId,
        network: readOrgNetworkSettings(settings?.network),
    };
}
export function maskOrgSettingsSecrets(settings: Record<string, unknown> | null | undefined): Record<string, unknown> {
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
export interface OrgResponse {
    id: string;
    name: string;
    slug: string;
    alias: string | null;
    settings: Record<string, unknown>;
    createdAt: string;
    updatedAt: string;
}
export const orgAliasSchema = z
    .string()
    .regex(/^([a-z0-9-]{3,40})?$/, "alias must be 3–40 chars of a–z, 0–9, -");
export interface StorageUsageResponse {
    quotaBytes: number | null;
    usedBytes: number;
    computedAt: string;
    breakdown: {
        messages: number;
        commandHistory: number;
        files: number;
        marketing: number;
    };
    kinds: StorageKindBytes;
    full: boolean;
    machineUser?: {
        input: number;
        output: number;
        log: number;
    };
}
export interface OrgOverviewResponse {
    userCount: number;
    rentedCount: number;
    teamCount: number;
    projectCount: number;
    enabledRuleCount: number;
    aiTokens: {
        used: number;
        limit: number | null;
    };
    storage: StorageUsageResponse;
}
export const updateOrgRequestSchema = z.object({
    name: z.string().min(1).max(100).optional(),
    alias: orgAliasSchema.optional(),
    settings: z.record(z.string(), z.unknown()).optional(),
});
export type UpdateOrgRequest = z.infer<typeof updateOrgRequestSchema>;
