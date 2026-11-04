/**
 * Vendored from @4pm/shared-constants (roles.ts) by scripts/vendor-shared.mjs — do not edit.
 */
import { ROLE_CATALOG } from "./rbac/catalog";
export const Role = {
    ADMIN: "ADMIN",
    PM: "PM",
    SA_SE: "SA_SE",
    QA: "QA",
    BA: "BA",
    MACHINE: "MACHINE",
    CLIENT: "CLIENT",
} as const;
export type Role = (typeof Role)[keyof typeof Role];
export const ALL_ROLES: readonly Role[] = Object.values(Role);
function rolesWhere(flag: "exclusive" | "nonMember" | "pmGrantable" | "integrationClient"): readonly Role[] {
    return ALL_ROLES.filter((role) => ROLE_CATALOG[role]?.[flag] === true);
}
export const EXCLUSIVE_ROLES: readonly Role[] = rolesWhere("exclusive");
export const NON_MEMBER_ROLES: readonly Role[] = rolesWhere("nonMember");
export const PM_GRANTABLE_ROLES: readonly Role[] = rolesWhere("pmGrantable");
export const INTEGRATION_CLIENT_ROLES: readonly Role[] = rolesWhere("integrationClient");
export function canOwnIntegrationClient(roles: readonly Role[]): boolean {
    return roles.length > 0 && roles.every((role) => INTEGRATION_CLIENT_ROLES.includes(role));
}
export function isValidRoleSet(roles: readonly Role[]): boolean {
    if (roles.length === 0)
        return false;
    if (roles.some((r) => EXCLUSIVE_ROLES.includes(r)))
        return roles.length === 1;
    return true;
}
export const UserStatus = {
    ACTIVE: "active",
    PAUSED: "paused",
} as const;
export type UserStatus = (typeof UserStatus)[keyof typeof UserStatus];
