/**
 * Vendored from @4pm/dto (user.ts) by scripts/vendor-shared.mjs — do not edit.
 */
import type { OrgOnboarding, UserOnboarding } from "./onboarding";
import type { ResolvedOverviewLayout } from "./overview-layout";
import type { UserTutorial } from "./tutorial";
import { z } from "zod";
import { ALL_ROLES, isValidRoleSet, type ProjectStatus, type Role, type UserStatus } from "@4pm/shared-constants";
import { emailSchema, ipAllowlistSchema, passwordSchema, phoneSchema, usernameSchema, } from "@4pm/validation";
import { baseRequestSchema, deletedFilterSchema } from "./base";
import { timeZoneSchema } from "./time-zone";
import type { WorkerFailingTool } from "./machine";
export interface UserResponse {
    id: string;
    orgId: string;
    username: string;
    aliasName: string | null;
    email: string | null;
    phone: string | null;
    roles: Role[];
    customRoles?: {
        id: string;
        key: string;
        name: string;
        root: Role | null;
    }[];
    gitAccounts?: {
        id: string;
        provider: "github" | "gitlab";
        host: string;
        login: string;
        status: "verified" | "email_match" | "admin_linked";
    }[];
    isRoot: boolean;
    isRented: boolean;
    status: UserStatus;
    ipAllowlist: string[];
    emailVerifiedAt: string | null;
    avatarUrl: string | null;
    idleLockMinutes?: number;
    timezone?: string | null;
    orgTimezone?: string;
    onboarding?: UserOnboarding;
    orgOnboarding?: OrgOnboarding;
    overview?: ResolvedOverviewLayout;
    tutorial?: UserTutorial;
    sessionLocked?: boolean;
    hasPin?: boolean;
    passwordExpiresAt?: string | null;
    failingTools?: WorkerFailingTool[];
    createdAt: string;
    updatedAt: string;
}
export interface AvatarUploadResponse {
    avatarUrl: string;
}
export const AVATAR_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
export interface UserRelationSummary {
    id: string;
    name: string;
}
export interface UserTeamSummary extends UserRelationSummary {
    avatarUrl: string | null;
    leadName: string | null;
    isLead: boolean;
}
export interface UserProjectSummary extends UserRelationSummary {
    direct: boolean;
    viaTeams: string[];
    status: ProjectStatus;
    memberCount: number;
    teamCount: number;
    pmName: string | null;
    createdAt: string;
}
export interface UserDetailResponse extends UserResponse {
    teams: UserTeamSummary[];
    projects: UserProjectSummary[];
    machineServedProjects?: UserRelationSummary[];
    lastActivityAt: string | null;
    canManageSettings: boolean;
    alerts: UsageAlertRule[];
    cliRetentionDays: number;
}
export interface UserListItemResponse extends UserResponse {
    teams: UserRelationSummary[];
    projects: UserRelationSummary[];
    machineProjectId: string | null;
    machinePoolId: string | null;
    machineConnected: boolean | null;
    machineCliVersion: string | null;
    machineCliOutdated: boolean | null;
    machineCliUnsupported: boolean | null;
    machineCliUnsupportedFrom: string | null;
    machineCliVersionNote: string | null;
    machineCliUpdateLocked?: boolean | null;
}
export const USAGE_ALERT_METRICS = ["session5h", "weekly", "monthlyTokens"] as const;
export type UsageAlertMetric = (typeof USAGE_ALERT_METRICS)[number];
export const usageAlertRuleSchema = z.object({
    id: z.string().min(1).max(64),
    metric: z.enum(USAGE_ALERT_METRICS),
    threshold: z.number().int().min(1),
    email: z.union([emailSchema, z.literal("")]).optional(),
    enabled: z.boolean().default(true),
});
export type UsageAlertRule = z.infer<typeof usageAlertRuleSchema>;
export const userAlertsSchema = z.object({
    rules: z.array(usageAlertRuleSchema).max(100).default([]),
});
export type UserAlerts = z.infer<typeof userAlertsSchema>;
export function readUserAlertRules(settings: Record<string, unknown> | null | undefined): UsageAlertRule[] {
    const parsed = userAlertsSchema.safeParse((settings ?? {})["alerts"] ?? { rules: [] });
    return parsed.success ? parsed.data.rules : [];
}
export function readUserCliRetentionDays(settings: Record<string, unknown> | null | undefined): number {
    const v = (settings ?? {})["cliRetentionDays"];
    return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
}
export const rolesSchema = z
    .array(z.enum(ALL_ROLES as [
    Role,
    ...Role[]
]))
    .min(1)
    .refine((roles) => isValidRoleSet(roles), {
    message: "ADMIN/MACHINE cannot be combined with other roles",
});
export const builtInRolesSchema = z
    .array(z.enum(ALL_ROLES as [
    Role,
    ...Role[]
]))
    .refine((roles) => roles.length === 0 || isValidRoleSet(roles), {
    message: "ADMIN/MACHINE cannot be combined with other roles",
});
export const customRoleIdsSchema = z.array(z.string().uuid()).max(20);
export const listUsersQuerySchema = baseRequestSchema.extend({
    role: z.enum(ALL_ROLES as [
        Role,
        ...Role[]
    ]).optional(),
    deleted: deletedFilterSchema,
});
export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;
export const createUserRequestSchema = z.object({
    username: usernameSchema,
    password: passwordSchema,
    email: emailSchema.optional(),
    roles: builtInRolesSchema.default([]),
    customRoleIds: customRoleIdsSchema.optional(),
    gitAccountIds: z.array(z.string().uuid()).max(4).optional(),
    phone: phoneSchema.optional(),
    ipAllowlist: ipAllowlistSchema.optional(),
});
export type CreateUserRequest = z.infer<typeof createUserRequestSchema>;
export const updateUserRequestSchema = z.object({
    email: emailSchema.optional(),
    phone: phoneSchema.nullable().optional(),
    roles: builtInRolesSchema.optional(),
    customRoleIds: customRoleIdsSchema.optional(),
    ipAllowlist: ipAllowlistSchema.optional(),
    aliasName: z.string().trim().max(60).nullable().optional(),
    alerts: userAlertsSchema.optional(),
    cliRetentionDays: z.number().int().min(0).max(3650).optional(),
    timezone: timeZoneSchema.nullable().optional(),
});
export type UpdateUserRequest = z.infer<typeof updateUserRequestSchema>;
export const setUserPasswordRequestSchema = z.object({
    password: passwordSchema,
});
export type SetUserPasswordRequest = z.infer<typeof setUserPasswordRequestSchema>;
export const contactChangeRequestSchema = z
    .object({
    email: emailSchema.optional(),
    phone: phoneSchema.optional(),
})
    .refine((v) => Boolean(v.email) !== Boolean(v.phone), {
    message: "exactly one of email or phone is required",
    path: ["email"],
});
export type ContactChangeRequest = z.infer<typeof contactChangeRequestSchema>;
export const contactChangeVerifySchema = z.object({
    otp: z.string().min(4).max(10),
});
export type ContactChangeVerifyRequest = z.infer<typeof contactChangeVerifySchema>;
export const contactChangeConfirmSchema = z.object({
    token: z.string().min(1),
});
export type ContactChangeConfirmRequest = z.infer<typeof contactChangeConfirmSchema>;
export interface ContactChangeStartResponse {
    type: "email" | "phone";
    method: "phone_otp" | "email_link";
}
export interface ContactChangePending {
    type: "email" | "phone";
    newValue: string;
    expiresAt: string;
}
export interface ContactChangeStatusResponse {
    pending: ContactChangePending | null;
}
export const activityHeartbeatSchema = z.object({
    projectId: z.string().guid().optional(),
    idle: z.boolean().optional(),
});
export type ActivityHeartbeatRequest = z.infer<typeof activityHeartbeatSchema>;
export const PRESENCE_STATUSES = ["online", "idle", "offline"] as const;
export type PresenceStatus = (typeof PRESENCE_STATUSES)[number];
export const USER_CARDS_MAX_IDS = 100;
export const userCardsQuerySchema = z.object({
    ids: z
        .string()
        .transform((v) => [...new Set(v.split(",").map((s) => s.trim()).filter(Boolean))])
        .pipe(z.array(z.string().guid()).min(1).max(USER_CARDS_MAX_IDS)),
});
export type UserCardsQuery = z.infer<typeof userCardsQuerySchema>;
export interface UserCardResponse {
    id: string;
    username: string;
    aliasName: string | null;
    avatarUrl: string | null;
    status: PresenceStatus;
}
export interface ProjectActivity {
    projectId: string;
    name: string;
    activeMs: number;
}
export interface UserStatsResponse {
    createdAt: string;
    totalActiveMs: number;
    perProject: ProjectActivity[];
    teamCount: number;
    projectCount: number;
    commandCount: number;
    tokenCount: number;
    activityCount: number;
    processingMs: number;
}
export interface TeamStatsResponse {
    createdAt: string;
    memberCount: number;
    totalActiveMs: number;
    perProject: ProjectActivity[];
    projectCount: number;
    commandCount: number;
    tokenCount: number;
    activityCount: number;
    processingMs: number;
}
