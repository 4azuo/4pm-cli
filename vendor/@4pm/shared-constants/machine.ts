/**
 * Vendored from @4pm/shared-constants (machine.ts) by scripts/vendor-shared.mjs — do not edit.
 */
export const WorkerStatus = {
    ONLINE: "online",
    OFFLINE: "offline",
} as const;
export type WorkerStatus = (typeof WorkerStatus)[keyof typeof WorkerStatus];
export const PhysicProjectStatus = {
    PENDING: "pending",
    ACTIVE: "active",
    NEEDS_PROVISION: "needs_provision",
    MISSING: "missing",
    DISABLED: "disabled",
} as const;
export type PhysicProjectStatus = (typeof PhysicProjectStatus)[keyof typeof PhysicProjectStatus];
