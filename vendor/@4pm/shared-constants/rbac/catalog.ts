/**
 * Vendored from @4pm/shared-constants (rbac/catalog.ts) by scripts/vendor-shared.mjs — do not edit.
 */
import rolesData from "./roles.json";
import permissionsData from "./permissions.json";
export interface RoleMeta {
    exclusive: boolean;
    capped: boolean;
    nonMember: boolean;
    pmGrantable: boolean;
    integrationClient: boolean;
    defaults: string[];
}
export interface DerivedRoleMeta {
    extends: string;
    exclude: string[];
}
export interface PermissionMeta {
    group: string;
    level: "org" | "project";
    selfService: boolean;
    adminOnly: boolean;
    nonDelegable: boolean;
    teamGrantable: boolean;
    projectGrantable: boolean;
    projectScopeChecked: boolean;
    clientSelf: boolean;
    sensitive: boolean;
    integrateApi: boolean;
    integrateScopes: string[];
}
export const ROLE_CATALOG: Readonly<Record<string, RoleMeta>> = rolesData.roles;
export const DERIVED_ROLE_CATALOG: Readonly<Record<string, DerivedRoleMeta>> = rolesData.derived;
export const ROLE_GROUPS: Readonly<Record<string, readonly string[]>> = rolesData.groups;
export const PERMISSION_CATALOG: Readonly<Record<string, PermissionMeta>> = permissionsData.codes as Record<string, PermissionMeta>;
export function expandRoleDefaults(role: string, allCodes: readonly string[]): string[] {
    const meta = ROLE_CATALOG[role];
    if (!meta)
        throw new Error(`RBAC catalog: unknown role ${role}`);
    const known = new Set(allCodes);
    const out = new Set<string>();
    for (const entry of meta.defaults) {
        if (entry === "*") {
            for (const code of allCodes)
                out.add(code);
        }
        else if (entry.startsWith("@")) {
            const group = ROLE_GROUPS[entry.slice(1)];
            if (!group)
                throw new Error(`RBAC catalog: role ${role} references unknown group ${entry}`);
            for (const code of group)
                out.add(assertKnown(code, known, role));
        }
        else if (entry.startsWith("!")) {
            out.delete(assertKnown(entry.slice(1), known, role));
        }
        else {
            out.add(assertKnown(entry, known, role));
        }
    }
    return [...out];
}
function assertKnown(code: string, known: ReadonlySet<string>, where: string): string {
    if (!known.has(code))
        throw new Error(`RBAC catalog: ${where} references unknown permission ${code}`);
    return code;
}
export function assertPermissionCatalog(allCodes: readonly string[]): void {
    const codes = new Set(allCodes);
    for (const code of allCodes) {
        if (!PERMISSION_CATALOG[code])
            throw new Error(`RBAC catalog: permission ${code} has no entry in permissions.json`);
    }
    for (const [code, meta] of Object.entries(PERMISSION_CATALOG)) {
        if (!codes.has(code))
            throw new Error(`RBAC catalog: permissions.json lists unknown code ${code}`);
        if ((meta.level === "project") !== meta.projectGrantable) {
            throw new Error(`RBAC catalog: ${code} level must be "project" exactly when it is projectGrantable`);
        }
        if (meta.integrateApi !== meta.integrateScopes.length > 0) {
            throw new Error(`RBAC catalog: ${code} integrateApi must be true exactly when it has integrateScopes`);
        }
    }
}
