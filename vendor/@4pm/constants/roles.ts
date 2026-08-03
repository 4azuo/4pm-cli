/**
 * User role catalog (Roles).
 * Multi-role: one user can have several roles; ADMIN/MACHINE are exclusive (a single role only).
 */

/** System roles — the values stored in `users.roles[]`. */
export const Role = {
  ADMIN: "ADMIN",
  PM: "PM",
  SA_SE: "SA_SE",
  QA: "QA",
  BA: "BA",
  MACHINE: "MACHINE",
} as const;

/** Union type of roles. */
export type Role = (typeof Role)[keyof typeof Role];

/** List of all roles (used for select/validate). */
export const ALL_ROLES: readonly Role[] = Object.values(Role);

/** Exclusive roles — a user with such a role cannot have any other role. */
export const EXCLUSIVE_ROLES: readonly Role[] = [Role.ADMIN, Role.MACHINE];

/**
 * Roles a PM may assign when editing a member's roles (ADR-0051, anti-escalation):
 * only roles below PM — never PM/ADMIN (equal-or-above) nor MACHINE (a worker type).
 * ADMIN is not restricted.
 */
export const PM_GRANTABLE_ROLES: readonly Role[] = [Role.SA_SE, Role.QA, Role.BA];

/**
 * Validate a role set against the exclusivity rule (ADMIN/MACHINE only one role).
 */
export function isValidRoleSet(roles: readonly Role[]): boolean {
  if (roles.length === 0) return false;
  if (roles.some((r) => EXCLUSIVE_ROLES.includes(r))) return roles.length === 1;
  return true;
}

/**
 * Account status (ADR-0093): `paused` = org-level pause — the account still
 * exists/searchable but cannot operate (login/API/token/WS blocked) until resumed.
 */
export const UserStatus = {
  ACTIVE: "active",
  PAUSED: "paused",
} as const;

/** Union type of user statuses. */
export type UserStatus = (typeof UserStatus)[keyof typeof UserStatus];
