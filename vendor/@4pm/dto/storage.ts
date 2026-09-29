/**
 * Hosted-storage kinds + self-managed storage DTOs (ADR-0365): the storage-kind catalogue shared by the
 * meter, manual clear, storage alerts and auto clear; the org settings shapes for alerts / auto clear;
 * the clear request/response bodies; and the plan-caps counters (org-0010).
 */
import { z } from "zod";

/** Every metered storage kind (arch 0021 § Storage kinds). */
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
] as const;
export type StorageKind = (typeof STORAGE_KINDS)[number];

/** The three meter colours (the `messages` colour is labelled "Text" in the UI). */
export type StorageColour = "messages" | "files" | "commandHistory";

/** Which meter colour each kind adds into. */
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
};

/** Kinds owned (stored + cleared) by `@4pm/community`. */
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

/** Kinds a user may clear on the server side (aiDocImages / artifacts are metered but not clearable). */
export const SERVER_CLEARABLE_STORAGE_KINDS = [
  "memoText",
  "memoImages",
  "memoFiles",
  "templates",
  "commandHistory",
] as const satisfies readonly StorageKind[];
export type ServerClearableStorageKind = (typeof SERVER_CLEARABLE_STORAGE_KINDS)[number];

/** Every clearable kind across both services (manual clear + auto clear). */
export const CLEARABLE_STORAGE_KINDS: readonly StorageKind[] = [
  ...COMMUNITY_STORAGE_KINDS,
  ...SERVER_CLEARABLE_STORAGE_KINDS,
];

/** Type guard: is `v` a known storage kind. */
export function isStorageKind(v: unknown): v is StorageKind {
  return typeof v === "string" && (STORAGE_KINDS as readonly string[]).includes(v);
}

/** True when `kind` is one of the clearable kinds. */
export function isClearableStorageKind(kind: StorageKind): boolean {
  return CLEARABLE_STORAGE_KINDS.includes(kind);
}

/** Per-kind byte figures; kinds absent from the map count as 0. */
export type StorageKindBytes = Partial<Record<StorageKind, number>>;

/** Sum the per-kind bytes into the three meter colours. */
export function colourTotals(kinds: StorageKindBytes): Record<StorageColour, number> {
  const out: Record<StorageColour, number> = { messages: 0, files: 0, commandHistory: 0 };
  for (const k of STORAGE_KINDS) out[STORAGE_KIND_COLOUR[k]] += kinds[k] ?? 0;
  return out;
}

/** What a storage alert / auto-clear rule measures: the total, one meter colour, or one kind. */
export type StorageTarget = "total" | StorageColour | StorageKind;

/** Type guard for a storage target. */
export function isStorageTarget(v: unknown): v is StorageTarget {
  return v === "total" || v === "messages" || v === "files" || v === "commandHistory" || isStorageKind(v);
}

/** Bytes a target measures, given the per-kind map and the total. */
export function storageTargetBytes(target: StorageTarget, kinds: StorageKindBytes, usedBytes: number): number {
  if (target === "total") return usedBytes;
  if (target === "messages" || target === "files" || target === "commandHistory") return colourTotals(kinds)[target];
  return kinds[target] ?? 0;
}

/** One storage-alert rule (`settings.storageAlerts[]`) — fires at `thresholdPercent` of the total cap. */
export interface StorageAlertRule {
  id: string;
  target: StorageTarget;
  /** 1–100, a percentage of the plan's total hosted-storage cap. */
  thresholdPercent: number;
  /** Optional recipient email. */
  email: string;
  /** Optional org user notified in-app. */
  notifyUserId: string;
  enabled: boolean;
}

/** Auto-clear config (`settings.storageAutoClear`). Off by default. */
export interface StorageAutoClearSettings {
  enabled: boolean;
  target: StorageTarget;
  /** Run when the target reaches this % of the cap. */
  triggerPercent: number;
  /** Clear oldest-first until the target is back at this % (< triggerPercent). */
  targetPercent: number;
  /** Clearable kinds auto clear may delete. */
  kinds: StorageKind[];
  /** Never touch content newer than this many days. */
  minAgeDays: number;
  /** Optional recipient email. */
  email: string;
  /** Org users notified in-app (the org admins are always notified). */
  notifyUserIds: string[];
}

/** Defaults for auto clear. */
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

/** Upper bound for `minAgeDays` (10 years). */
export const STORAGE_AUTO_CLEAR_MAX_MIN_AGE_DAYS = 3650;
/** Max storage alert rules per org. */
export const STORAGE_ALERTS_MAX = 20;

/** Clamp a percentage to 1–100 (integer), else `def`. */
function readPercent(v: unknown, def: number): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 1 && v <= 100 ? Math.floor(v) : def;
}

/** Read `settings.storageAlerts` from the loose JSON store, dropping malformed rules. */
export function readStorageAlerts(raw: unknown): StorageAlertRule[] {
  if (!Array.isArray(raw)) return [];
  const out: StorageAlertRule[] = [];
  for (const r of raw.slice(0, STORAGE_ALERTS_MAX)) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    if (typeof o.id !== "string" || !o.id || !isStorageTarget(o.target)) continue;
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

/** Read `settings.storageAutoClear`, filling defaults and keeping `targetPercent < triggerPercent`. */
export function readStorageAutoClear(raw: unknown): StorageAutoClearSettings {
  const d = DEFAULT_STORAGE_AUTO_CLEAR;
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const triggerPercent = readPercent(o.triggerPercent, d.triggerPercent);
  let targetPercent = readPercent(o.targetPercent, d.targetPercent);
  if (targetPercent >= triggerPercent) targetPercent = Math.max(1, triggerPercent - 1);
  const minAge =
    typeof o.minAgeDays === "number" && Number.isFinite(o.minAgeDays) && o.minAgeDays >= 0
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

/** Body of a storage clear / preview (org-0008/0009, community-0014/0015). */
export const storageClearRequestSchema = z.object({
  kinds: z.array(z.enum(STORAGE_KINDS)).min(1).max(STORAGE_KINDS.length),
  before: z.string().datetime({ offset: true }),
  /** org-0009 / community-0015 only — must equal the org name. */
  confirm: z.string().max(200).optional(),
});
export type StorageClearRequest = z.infer<typeof storageClearRequestSchema>;

/** Count + bytes one kind holds (preview) or freed (clear). */
export interface StorageKindCount {
  count: number;
  bytes: number;
}

/** Data of a storage clear preview. */
export interface StorageClearPreviewResponse {
  perKind: Partial<Record<StorageKind, StorageKindCount>>;
  totalBytes: number;
}

/** Data of a storage clear — inline result (`200`) or a background job (`202`). */
export type StorageClearResponse =
  | { perKind: Partial<Record<StorageKind, StorageKindCount>>; freedBytes: number; jobId?: undefined }
  | { jobId: string; perKind?: undefined; freedBytes?: undefined };

/** Above this many rows a clear runs as a background job instead of inline. */
export const STORAGE_CLEAR_INLINE_MAX_ROWS = 5000;

/** The autonomous books capped by `autonomousRequestsPerMonth`. */
export const AUTONOMOUS_BOOKS = ["USER_TODO", "USER_QA", "AI_TODO"] as const;
export type AutonomousBook = (typeof AUTONOMOUS_BOOKS)[number];

/** A used/limit pair (`limit` null = unlimited). */
export interface CapCounter {
  used: number;
  limit: number | null;
}

/** Data GET /organizations/me/plan-caps (org-0010). */
export interface PlanCapsResponse {
  memoItems: CapCounter;
  autonomousBooks: Record<AutonomousBook, CapCounter>;
  /** Start of the next UTC month — when the book counters reset. */
  resetAt: string;
}

/** The UTC `YYYY-MM` period key for `d`. */
export function utcMonthKey(d: Date = new Date()): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Start of the UTC month after `d`. */
export function nextUtcMonthStart(d: Date = new Date()): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
}
