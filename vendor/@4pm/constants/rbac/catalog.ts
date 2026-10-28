/**
 * RBAC catalog loader — typed access to `roles.json` and `permissions.json`, the single source of
 * truth for role metadata, role default permissions and per-permission flags. `roles.ts` and
 * `permissions.ts` derive every exported set from here; this module only reads the JSON, expands the
 * role defaults and fails fast on an inconsistent catalog. It works on plain strings so it doesn't
 * import the code/role constants (no import cycle).
 * @adr 0482
 */
import rolesData from "./roles.json";
import permissionsData from "./permissions.json";

/** Metadata of one stored role (`users.roles[]` value). */
export interface RoleMeta {
  /** A user with this role has no other role. */
  exclusive: boolean;
  /** The role's defaults are also its ceiling — no grant can widen it. */
  capped: boolean;
  /** Not an internal person (worker / customer): excluded from people fan-outs and team/PM assignment. */
  nonMember: boolean;
  /** A PM may assign this role when editing a member. */
  pmGrantable: boolean;
  /** A user holding this role may own a public-API client. */
  integrationClient: boolean;
  /** Default permissions: `*` = every code, `@group`, `!code` (remove), or a code. */
  defaults: string[];
}

/** A role computed from another one (TL = PM minus some codes). */
export interface DerivedRoleMeta {
  extends: string;
  exclude: string[];
}

/** Flags of one permission code. */
export interface PermissionMeta {
  /** The resource family (prefix of the code). */
  group: string;
  /** Where the code acts: `project` = on one project (exactly the project-grantable codes), `org` = outside. @adr 0659 */
  level: "org" | "project";
  /** Always allowed for everyone; never offered as a grant. */
  selfService: boolean;
  /** Belongs to ADMIN only; never delegable. */
  adminOnly: boolean;
  /** Held by role default only; granting it would let the right to grant chain. */
  nonDelegable: boolean;
  /** May be granted to a team. */
  teamGrantable: boolean;
  /** May be granted within one project (to the project or one member of it). */
  projectGrantable: boolean;
  /** Project-context code that passes the PM/TL project scope check. */
  projectScopeChecked: boolean;
  /** Passes on any route for a CLIENT (self-service). */
  clientSelf: boolean;
  /** Shown with a warning in the permission UIs. */
  sensitive: boolean;
  /** May be exercised through the public integrate API. */
  integrateApi: boolean;
  /** The client scopes that unlock this code through the API (empty when `integrateApi` is false). */
  integrateScopes: string[];
}

/** Every stored role's metadata, in catalog order. */
export const ROLE_CATALOG: Readonly<Record<string, RoleMeta>> = rolesData.roles;

/** Derived roles (not stored in `users.roles[]`). */
export const DERIVED_ROLE_CATALOG: Readonly<Record<string, DerivedRoleMeta>> = rolesData.derived;

/** Named code groups referenced from role defaults with `@name`. */
export const ROLE_GROUPS: Readonly<Record<string, readonly string[]>> = rolesData.groups;

/** Every permission code's flags, in catalog order. */
export const PERMISSION_CATALOG: Readonly<Record<string, PermissionMeta>> = permissionsData.codes as Record<string, PermissionMeta>;

/**
 * Expand a role's `defaults` entries in order: `*` adds every code, `@group` adds a group, `!code`
 * removes a code added earlier, anything else adds that code. Unknown codes or groups throw.
 */
export function expandRoleDefaults(role: string, allCodes: readonly string[]): string[] {
  const meta = ROLE_CATALOG[role];
  if (!meta) throw new Error(`RBAC catalog: unknown role ${role}`);
  const known = new Set(allCodes);
  const out = new Set<string>();
  for (const entry of meta.defaults) {
    if (entry === "*") {
      for (const code of allCodes) out.add(code);
    } else if (entry.startsWith("@")) {
      const group = ROLE_GROUPS[entry.slice(1)];
      if (!group) throw new Error(`RBAC catalog: role ${role} references unknown group ${entry}`);
      for (const code of group) out.add(assertKnown(code, known, role));
    } else if (entry.startsWith("!")) {
      out.delete(assertKnown(entry.slice(1), known, role));
    } else {
      out.add(assertKnown(entry, known, role));
    }
  }
  return [...out];
}

/** Throw when `code` isn't a real permission code. */
function assertKnown(code: string, known: ReadonlySet<string>, where: string): string {
  if (!known.has(code)) throw new Error(`RBAC catalog: ${where} references unknown permission ${code}`);
  return code;
}

/**
 * Check the catalog against the code list: every code has an entry and every entry is a code, and an
 * API-usable code names at least one scope. Throws on the first problem (run once at module load).
 */
export function assertPermissionCatalog(allCodes: readonly string[]): void {
  const codes = new Set(allCodes);
  for (const code of allCodes) {
    if (!PERMISSION_CATALOG[code]) throw new Error(`RBAC catalog: permission ${code} has no entry in permissions.json`);
  }
  for (const [code, meta] of Object.entries(PERMISSION_CATALOG)) {
    if (!codes.has(code)) throw new Error(`RBAC catalog: permissions.json lists unknown code ${code}`);
    if ((meta.level === "project") !== meta.projectGrantable) {
      throw new Error(`RBAC catalog: ${code} level must be "project" exactly when it is projectGrantable`);
    }
    if (meta.integrateApi !== meta.integrateScopes.length > 0) {
      throw new Error(`RBAC catalog: ${code} integrateApi must be true exactly when it has integrateScopes`);
    }
  }
}
