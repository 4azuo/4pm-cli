/**
 * DTO for the user domain (21-api/user-0001…0006).
 */
import { z } from "zod";
import { ALL_ROLES, isValidRoleSet, type ProjectStatus, type Role, type UserStatus } from "@4pm/constants";
import {
  emailSchema,
  ipAllowlistSchema,
  passwordSchema,
  phoneSchema,
  usernameSchema,
} from "@4pm/validation";
import { baseRequestSchema, deletedFilterSchema } from "./base";

/** User profile returned by the API (never includes password_hash). */
export interface UserResponse {
  id: string;
  orgId: string;
  username: string;
  /**
   * Friendly display name shown in place of the immutable `username` where the account is
   * presented to humans (ADR-0200) — use `aliasName || username`. Null = show the username.
   */
  aliasName: string | null;
  /** null = internal account created without email (ADR-0039). */
  email: string | null;
  phone: string | null;
  roles: Role[];
  isRoot: boolean;
  /**
   * Rented (4PM-hosted pool) MACHINE user (ADR-0132) — surfaced into a customer org only
   * while it holds an active rental; the web badges it "Rented" and shows a read-only,
   * rental-scoped user page (no Settings/Permission tabs).
   */
  isRented: boolean;
  /** Account status: "active" | "paused" (org-level pause — ADR-0093). */
  status: UserStatus;
  ipAllowlist: string[];
  emailVerifiedAt: string | null;
  /** URL to the avatar image (`/users/:id/avatar`); null when not uploaded (ADR-0028). */
  avatarUrl: string | null;
  /**
   * The org's idle privacy-lock timeout in minutes (ADR-0202) — an org policy surfaced on the
   * self `GET /users/me` so every member can apply it (org.read is ADMIN-only). `0` = off.
   * Only populated on the `me()` response; omitted elsewhere.
   */
  idleLockMinutes?: number;
  /**
   * Whether **this session** is currently idle-locked server-side (ADR-0204). Fresh (not cached) on
   * the `me()` response so a reload while locked re-shows the lock overlay. Only on `me()`.
   */
  sessionLocked?: boolean;
  /** Whether the user has set an unlock PIN (ADR-0205) — the lock overlay offers PIN vs password.
   * Only on the self `me()` response. */
  hasPin?: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Data PUT /users/me/avatar (user-0007) — the new avatar URL. */
export interface AvatarUploadResponse {
  avatarUrl: string;
}

/** Allowed avatar MIME types + max size (ADR-0028). */
export const AVATAR_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

/** Summary of teams/projects attached to a user (user-0004). */
export interface UserRelationSummary {
  id: string;
  name: string;
}

/**
 * A team a user belongs to, enriched for the user Info page (user-0004): the team's avatar,
 * its lead's display name (null when none) and whether THIS user is the lead.
 */
export interface UserTeamSummary extends UserRelationSummary {
  /** Team avatar URL (`/teams/:id/avatar`), null when none uploaded (ADR-0043). */
  avatarUrl: string | null;
  /** Team lead's display name, or null when no lead is set. */
  leadName: string | null;
  /** Whether this user is (one of) the team's lead(s). */
  isLead: boolean;
}

/**
 * A project a user can reach (user-0004): either assigned **directly** (`project_users`) or
 * **via a team** the user belongs to (`project_teams`), or both. `viaTeams` lists the team
 * names granting access when the reach is team-derived (empty when only direct).
 */
export interface UserProjectSummary extends UserRelationSummary {
  /** True when the user is directly assigned to the project (`project_users`). */
  direct: boolean;
  /** Team names that grant access to this project (empty when only direct). */
  viaTeams: string[];
  /** Project lifecycle status (ADR-0092) — rendered as a status badge on the row. */
  status: ProjectStatus;
  /** Human members on the project (`project_users`, excluding MACHINE accounts — ADR-0041). */
  memberCount: number;
  /** Teams attached to the project (`project_teams`). */
  teamCount: number;
  /** Project manager's display name (ADR-0038), or null when none is set. */
  pmName: string | null;
  /** Project creation time (ISO). */
  createdAt: string;
}

/** Data GET /users/:id — profile + teams + projects. */
export interface UserDetailResponse extends UserResponse {
  teams: UserTeamSummary[];
  projects: UserProjectSummary[];
  /**
   * Last activity time — the most recent `UserRecentProject.occurredAt` (ADR-0029);
   * null when the user has never interacted with a project.
   */
  lastActivityAt: string | null;
  /**
   * Whether the requesting actor may edit this user's settings — specifically the
   * IP allowlist (ADR-0050). True for ADMIN (anyone) and for a PM/TL who manages the
   * user's project/team. Roles remain ADMIN-only regardless. Self edits profile via
   * `isSelf`, independent of this flag.
   */
  canManageSettings: boolean;
  /** Usage-alert rules for this cli user (ADR-0110); empty when none configured. */
  alerts: UsageAlertRule[];
  /** cli data retention (days) for this machine user (ADR-0115); 0 = cli defaults. */
  cliRetentionDays: number;
}

/** A row of GET /users (user-0002) — profile + team memberships (for grouping in the UI). */
export interface UserListItemResponse extends UserResponse {
  teams: UserRelationSummary[];
  /** Projects the user is directly assigned to (`project_users`), for the list UI. */
  projects: UserRelationSummary[];
  /**
   * For a MACHINE user, the id of the single project it is a member of (ADR-0041);
   * null when unassigned or for non-MACHINE users. Lets the UI hide machines that
   * are already tied to another project.
   */
  machineProjectId: string | null;
  /**
   * For a **rented** (4PM-hosted pool) user (`isRented`), the live WS state of its
   * pool-owned worker cli (ADR-0160) — the org's own `machines.list` never returns the
   * pool link, so the machine list can't derive it. `null` for non-rented users (the UI
   * keeps deriving those from the org's links). A rented user is always paired.
   */
  machineConnected: boolean | null;
}

/**
 * Usage-alert rule (ADR-0110) — emails when a cli user's usage crosses a threshold within a
 * period. `session5h`/`weekly` thresholds are utilization percent (1–100); `monthlyTokens` is
 * an absolute month-to-date AI-token count. `email` empty ⇒ send to the user's own email.
 */
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

/** The `alerts` block of `users.settings` (ADR-0110). */
export const userAlertsSchema = z.object({
  rules: z.array(usageAlertRuleSchema).max(20).default([]),
});
export type UserAlerts = z.infer<typeof userAlertsSchema>;

/** Read the usage-alert rules out of a loosely-typed `users.settings` JSON (ADR-0110). */
export function readUserAlertRules(
  settings: Record<string, unknown> | null | undefined,
): UsageAlertRule[] {
  const parsed = userAlertsSchema.safeParse(
    (settings ?? {})["alerts"] ?? { rules: [] },
  );
  return parsed.success ? parsed.data.rules : [];
}

/**
 * Per-machine-user cli data retention in days (ADR-0115) — applied by the cli to its logs,
 * command-history and command-output. `0` = the cli's built-in defaults. Capped at the plan's
 * `retentionDays` server-side.
 */
export function readUserCliRetentionDays(
  settings: Record<string, unknown> | null | undefined,
): number {
  const v = (settings ?? {})["cliRetentionDays"];
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
}

/** roles[] schema — multi-role, ADMIN/MACHINE only one role. */
export const rolesSchema = z
  .array(z.enum(ALL_ROLES as [Role, ...Role[]]))
  .min(1)
  .refine((roles) => isValidRoleSet(roles), {
    message: "ADMIN/MACHINE cannot be combined with other roles",
  });

/** Query GET /users — BaseRequest + filter role. */
export const listUsersQuerySchema = baseRequestSchema.extend({
  role: z.enum(ALL_ROLES as [Role, ...Role[]]).optional(),
  /** ADMIN-only Trash: list soft-deleted users (ADR-0109). */
  deleted: deletedFilterSchema,
});
export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;

/** Body POST /users — ADMIN creates a sub-account (user-0003). */
export const createUserRequestSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
  // optional — allowed only when the org enables it (ADR-0039); enforced server-side
  email: emailSchema.optional(),
  roles: rolesSchema,
  phone: phoneSchema.optional(),
  ipAllowlist: ipAllowlistSchema.optional(),
});
export type CreateUserRequest = z.infer<typeof createUserRequestSchema>;

/** Body PATCH /users/:id — partial; does not change username/password (user-0005). */
export const updateUserRequestSchema = z.object({
  email: emailSchema.optional(),
  phone: phoneSchema.nullable().optional(),
  roles: rolesSchema.optional(),
  ipAllowlist: ipAllowlistSchema.optional(),
  // Friendly display name (ADR-0200) — shown instead of the immutable username; blank ⇒ cleared.
  aliasName: z.string().trim().max(60).nullable().optional(),
  // Usage-alert rules (ADR-0110) — manager-only, like the IP allowlist.
  alerts: userAlertsSchema.optional(),
  // cli data retention days (ADR-0115) — manager-only; capped at the plan's retentionDays.
  cliRetentionDays: z.number().int().min(0).max(3650).optional(),
});
export type UpdateUserRequest = z.infer<typeof updateUserRequestSchema>;

/** Body PUT /users/:id/password — ADMIN resets a sub-account's password (user-0010). */
export const setUserPasswordRequestSchema = z.object({
  password: passwordSchema,
});
export type SetUserPasswordRequest = z.infer<typeof setUserPasswordRequestSchema>;

/**
 * Body POST /users/me/contact-change (user-0011, ADR-0046) — start changing the
 * caller's own email OR phone (exactly one). Email change is verified by an OTP
 * sent to the current phone; phone change by a link sent to the current email.
 */
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

/** Body POST /users/me/contact-change/verify (user-0012) — the phone OTP for an email change. */
export const contactChangeVerifySchema = z.object({
  otp: z.string().min(4).max(10),
});
export type ContactChangeVerifyRequest = z.infer<typeof contactChangeVerifySchema>;

/** Body POST /users/contact-change/confirm (user-0014) — the email-link token for a phone change. */
export const contactChangeConfirmSchema = z.object({
  token: z.string().min(1),
});
export type ContactChangeConfirmRequest = z.infer<typeof contactChangeConfirmSchema>;

/** The verification channel started for a contact change. */
export interface ContactChangeStartResponse {
  type: "email" | "phone";
  /** email change ⇒ "phone_otp" (enter the OTP); phone change ⇒ "email_link" (check inbox). */
  method: "phone_otp" | "email_link";
}

/** A pending contact-change (GET /users/me/contact-change, user-0013). */
export interface ContactChangePending {
  type: "email" | "phone";
  /** Masked new value for display (e.g. `n***@x.com`). */
  newValue: string;
  expiresAt: string;
}

/** Response of GET /users/me/contact-change — the pending request or null. */
export interface ContactChangeStatusResponse {
  pending: ContactChangePending | null;
}

/**
 * Body POST /users/me/activity/heartbeat (user-0020, ADR-0201) — the keepalive tick reports
 * the caller's current presence. `projectId` = the project page the user is on (omitted on
 * non-project pages). Doubles as the session keepalive (ADR-0098).
 */
export const activityHeartbeatSchema = z.object({
  projectId: z.string().uuid().optional(),
});
export type ActivityHeartbeatRequest = z.infer<typeof activityHeartbeatSchema>;

/** Active time a user accrued on one project (ADR-0201) — `activeMs` = summed session duration. */
export interface ProjectActivity {
  projectId: string;
  name: string;
  activeMs: number;
}

/**
 * Data GET /users/:id/stats (user-0021, ADR-0201) — locally-attributable activity statistics for
 * the User Info page. `totalActiveMs`/`perProject` come from `user_sessions`; the rest from the org
 * DB. Cross-service per-user counts (community posts, integration issues/tasks) are **not** included
 * here — they require per-user endpoints on those separate apps (a follow-up per ADR-0201).
 */
export interface UserStatsResponse {
  /** Account creation time (ISO). */
  createdAt: string;
  /** Total active time across all sessions (ms). */
  totalActiveMs: number;
  /** Active time per project, most-active first. */
  perProject: ProjectActivity[];
  /** Teams the user belongs to. */
  teamCount: number;
  /** Distinct projects reachable (direct ∪ via team). */
  projectCount: number;
  /** Commands attributed to the user (`command_history.userId`). */
  commandCount: number;
  /** AI tokens attributed to the user (Σ `command_history.tokens`). */
  tokenCount: number;
}

/**
 * Data GET /teams/:id/stats (team-0010, ADR-0201) — the same activity stats aggregated over the
 * team's members, plus the team's own `createdAt` and `memberCount`.
 */
export interface TeamStatsResponse {
  createdAt: string;
  memberCount: number;
  totalActiveMs: number;
  perProject: ProjectActivity[];
  projectCount: number;
  commandCount: number;
  /** AI tokens attributed to the team's members (Σ `command_history.tokens`). */
  tokenCount: number;
}
