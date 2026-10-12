/**
 * User role catalog (Roles).
 * Multi-role: one user can have several roles; ADMIN/MACHINE/CLIENT are exclusive (a single role only).
 * The role flags come from the JSON RBAC catalog (`rbac/roles.json`). @adr 0482
 */
import { ROLE_CATALOG } from "./rbac/catalog";

/** System roles — the values stored in `users.roles[]`. */
export const Role = {
  ADMIN: "ADMIN",
  PM: "PM",
  SA_SE: "SA_SE",
  QA: "QA",
  BA: "BA",
  MACHINE: "MACHINE",
  // An org's customer: sees only the projects it is a direct member of (ADR-0449).
  CLIENT: "CLIENT",
} as const;

/** Union type of roles. */
export type Role = (typeof Role)[keyof typeof Role];

/** List of all roles (used for select/validate). */
export const ALL_ROLES: readonly Role[] = Object.values(Role);

/** The roles whose catalog flag `flag` is set, in catalog order. */
function rolesWhere(flag: "exclusive" | "nonMember" | "pmGrantable" | "integrationClient"): readonly Role[] {
  return ALL_ROLES.filter((role) => ROLE_CATALOG[role]?.[flag] === true);
}

/** Exclusive roles — a user with such a role cannot have any other role. */
export const EXCLUSIVE_ROLES: readonly Role[] = rolesWhere("exclusive");

/**
 * Roles that are not internal people: MACHINE (a worker) and CLIENT (a customer). Excluded from the
 * project-people fan-outs (notifications, announcements) and from team/PM assignments.
 * @adr 0449
 */
export const NON_MEMBER_ROLES: readonly Role[] = rolesWhere("nonMember");

/**
 * Roles a PM may assign when editing a member's roles (ADR-0051, anti-escalation):
 * only roles below PM — never PM/ADMIN (equal-or-above) nor MACHINE (a worker type).
 * ADMIN is not restricted.
 */
export const PM_GRANTABLE_ROLES: readonly Role[] = rolesWhere("pmGrantable");

/** Roles whose holders may own a public-API client (all but MACHINE). @adr 0482 */
export const INTEGRATION_CLIENT_ROLES: readonly Role[] = rolesWhere("integrationClient");

/** True when a user with `roles` may own a public-API client — every one of its roles must allow it. @adr 0482 */
export function canOwnIntegrationClient(roles: readonly Role[]): boolean {
  return roles.length > 0 && roles.every((role) => INTEGRATION_CLIENT_ROLES.includes(role));
}

/**
 * Validate a role set against the exclusivity rule (ADMIN/MACHINE/CLIENT only one role).
 */
export function isValidRoleSet(roles: readonly Role[]): boolean {
  if (roles.length === 0) return false;
  if (roles.some((r) => EXCLUSIVE_ROLES.includes(r))) return roles.length === 1;
  return true;
}

/**
 * Account status: `paused` = org-level pause — the account still
 * exists/searchable but cannot operate (login/API/token/WS blocked) until resumed.
 * @adr 0093
 */
export const UserStatus = {
  ACTIVE: "active",
  PAUSED: "paused",
} as const;

/** Union type of user statuses. */
export type UserStatus = (typeof UserStatus)[keyof typeof UserStatus];
