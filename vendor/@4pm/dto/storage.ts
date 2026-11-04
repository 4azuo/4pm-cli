/**
 * Vendored from @4pm/dto (storage.ts) by scripts/vendor-shared.mjs — do not edit.
 */
import { z } from "zod";
export const STORAGE_KINDS = [
    "messageText",
    "postText",
    "commentText",
    "memoText",
    "messageImages",
    "messageFiles",
    "postImages",
    "postFiles",
    "commentImages",
    "commentFiles",
    "memoImages",
    "memoFiles",
    "templates",
    "aiDocImages",
    "artifacts",
    "commandHistory",
    "knowledgeText",
    "marketPackages",
    "marketMedia",
    "marketing",
    "flowMaps",
] as const;
export type StorageKind = (typeof STORAGE_KINDS)[number];
export type StorageColour = "messages" | "files" | "commandHistory" | "marketing";
export const STORAGE_KIND_COLOUR: Record<StorageKind, StorageColour> = {
    messageText: "messages",
    postText: "messages",
    commentText: "messages",
    memoText: "messages",
    messageImages: "files",
    messageFiles: "files",
    postImages: "files",
    postFiles: "files",
    commentImages: "files",
    commentFiles: "files",
    memoImages: "files",
    memoFiles: "files",
    templates: "files",
    aiDocImages: "files",
    artifacts: "files",
    commandHistory: "commandHistory",
    knowledgeText: "messages",
    marketPackages: "files",
    marketMedia: "files",
    marketing: "marketing",
    flowMaps: "messages",
};
export const COMMUNITY_STORAGE_KINDS = [
    "messageText",
    "postText",
    "commentText",
    "messageImages",
    "messageFiles",
    "postImages",
    "postFiles",
    "commentImages",
    "commentFiles",
] as const satisfies readonly StorageKind[];
export type CommunityStorageKind = (typeof COMMUNITY_STORAGE_KINDS)[number];
export const MARKET_STORAGE_KINDS = [
    "knowledgeText",
    "marketPackages",
    "marketMedia",
] as const satisfies readonly StorageKind[];
export type MarketStorageKind = (typeof MARKET_STORAGE_KINDS)[number];
export const SERVER_CLEARABLE_STORAGE_KINDS = [
    "memoText",
    "memoImages",
    "memoFiles",
    "templates",
    "commandHistory",
] as const satisfies readonly StorageKind[];
export type ServerClearableStorageKind = (typeof SERVER_CLEARABLE_STORAGE_KINDS)[number];
export const CLEARABLE_STORAGE_KINDS: readonly StorageKind[] = [
    ...COMMUNITY_STORAGE_KINDS,
    ...SERVER_CLEARABLE_STORAGE_KINDS,
];
export function isStorageKind(v: unknown): v is StorageKind {
    return typeof v === "string" && (STORAGE_KINDS as readonly string[]).includes(v);
}
export function isClearableStorageKind(kind: StorageKind): boolean {
    return CLEARABLE_STORAGE_KINDS.includes(kind);
}
export type StorageKindBytes = Partial<Record<StorageKind, number>>;
export function colourTotals(kinds: StorageKindBytes): Record<StorageColour, number> {
    const out: Record<StorageColour, number> = { messages: 0, files: 0, commandHistory: 0, marketing: 0 };
    for (const k of STORAGE_KINDS)
        out[STORAGE_KIND_COLOUR[k]] += kinds[k] ?? 0;
    return out;
}
export type StorageTarget = "total" | StorageColour | StorageKind;
export function isStorageTarget(v: unknown): v is StorageTarget {
    return v === "total" || v === "messages" || v === "files" || v === "commandHistory" || v === "marketing" || isStorageKind(v);
}
export function storageTargetBytes(target: StorageTarget, kinds: StorageKindBytes, usedBytes: number): number {
    if (target === "total")
        return usedBytes;
    if (target === "messages" || target === "files" || target === "commandHistory" || target === "marketing")
        return colourTotals(kinds)[target];
    return kinds[target] ?? 0;
}
export interface StorageAlertRule {
    id: string;
    target: StorageTarget;
    thresholdPercent: number;
    email: string;
    notifyUserId: string;
    enabled: boolean;
}
export interface StorageAutoClearSettings {
    enabled: boolean;
    target: StorageTarget;
    triggerPercent: number;
    targetPercent: number;
    kinds: StorageKind[];
    minAgeDays: number;
    email: string;
    notifyUserIds: string[];
}
export const DEFAULT_STORAGE_AUTO_CLEAR: StorageAutoClearSettings = {
    enabled: false,
    target: "total",
    triggerPercent: 90,
    targetPercent: 70,
    kinds: [],
    minAgeDays: 7,
    email: "",
    notifyUserIds: [],
};
export const STORAGE_AUTO_CLEAR_MAX_MIN_AGE_DAYS = 3650;
export const STORAGE_ALERTS_MAX = 20;
function readPercent(v: unknown, def: number): number {
    return typeof v === "number" && Number.isFinite(v) && v >= 1 && v <= 100 ? Math.floor(v) : def;
}
export function readStorageAlerts(raw: unknown): StorageAlertRule[] {
    if (!Array.isArray(raw))
        return [];
    const out: StorageAlertRule[] = [];
    for (const r of raw.slice(0, STORAGE_ALERTS_MAX)) {
        if (!r || typeof r !== "object")
            continue;
        const o = r as Record<string, unknown>;
        if (typeof o.id !== "string" || !o.id || !isStorageTarget(o.target))
            continue;
        out.push({
            id: o.id,
            target: o.target,
            thresholdPercent: readPercent(o.thresholdPercent, 80),
            email: typeof o.email === "string" ? o.email.trim() : "",
            notifyUserId: typeof o.notifyUserId === "string" ? o.notifyUserId : "",
            enabled: o.enabled !== false,
        });
    }
    return out;
}
export function readStorageAutoClear(raw: unknown): StorageAutoClearSettings {
    const d = DEFAULT_STORAGE_AUTO_CLEAR;
    const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const triggerPercent = readPercent(o.triggerPercent, d.triggerPercent);
    let targetPercent = readPercent(o.targetPercent, d.targetPercent);
    if (targetPercent >= triggerPercent)
        targetPercent = Math.max(1, triggerPercent - 1);
    const minAge = typeof o.minAgeDays === "number" && Number.isFinite(o.minAgeDays) && o.minAgeDays >= 0
        ? Math.min(Math.floor(o.minAgeDays), STORAGE_AUTO_CLEAR_MAX_MIN_AGE_DAYS)
        : d.minAgeDays;
    return {
        enabled: o.enabled === true,
        target: isStorageTarget(o.target) ? o.target : d.target,
        triggerPercent,
        targetPercent,
        kinds: Array.isArray(o.kinds)
            ? [...new Set(o.kinds.filter((k): k is StorageKind => isStorageKind(k) && isClearableStorageKind(k)))]
            : [],
        minAgeDays: minAge,
        email: typeof o.email === "string" ? o.email.trim() : "",
        notifyUserIds: Array.isArray(o.notifyUserIds)
            ? o.notifyUserIds.filter((u): u is string => typeof u === "string" && u.length > 0).slice(0, 20)
            : [],
    };
}
export const storageClearRequestSchema = z.object({
    kinds: z.array(z.enum(STORAGE_KINDS)).min(1).max(STORAGE_KINDS.length),
    before: z.string().datetime({ offset: true }),
    confirm: z.string().max(200).optional(),
});
export type StorageClearRequest = z.infer<typeof storageClearRequestSchema>;
export interface StorageKindCount {
    count: number;
    bytes: number;
}
export interface StorageClearPreviewResponse {
    perKind: Partial<Record<StorageKind, StorageKindCount>>;
    totalBytes: number;
}
export type StorageClearResponse = {
    perKind: Partial<Record<StorageKind, StorageKindCount>>;
    freedBytes: number;
    jobId?: undefined;
} | {
    jobId: string;
    perKind?: undefined;
    freedBytes?: undefined;
};
export const STORAGE_CLEAR_INLINE_MAX_ROWS = 5000;
export const AUTONOMOUS_BOOKS = ["USER_TODO", "USER_QA", "AI_TODO"] as const;
export type AutonomousBook = (typeof AUTONOMOUS_BOOKS)[number];
export interface CapCounter {
    used: number;
    limit: number | null;
}
export interface PlanCapsResponse {
    memoItems: CapCounter;
    autonomousBooks: Record<AutonomousBook, CapCounter>;
    automationRules: CapCounter;
    users: CapCounter;
    projects: CapCounter;
    teams: CapCounter;
    orgTags: CapCounter;
    resetAt: string;
}
export function utcMonthKey(d: Date = new Date()): string {
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
export function nextUtcMonthStart(d: Date = new Date()): Date {
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
}
