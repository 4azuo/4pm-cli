/**
 * Vendored from @4pm/shared-constants (billing.ts) by scripts/vendor-shared.mjs — do not edit.
 */
export const PaymentProvider = {
    STRIPE: "stripe",
    PAYPAL: "paypal",
} as const;
export type PaymentProvider = (typeof PaymentProvider)[keyof typeof PaymentProvider];
export const ENTERPRISE_PLAN_CODE = "enterprise";
export const PaymentMethod = {
    CARD: "card",
    CREDIT: "credit",
} as const;
export type PaymentMethod = (typeof PaymentMethod)[keyof typeof PaymentMethod];
export const AddonKind = {
    STORAGE: "storage",
    SCALE_PACK: "scale_pack",
    MACHINE_USER: "machine_user",
} as const;
export type AddonKind = (typeof AddonKind)[keyof typeof AddonKind];
export const AddonCode = {
    EXTRA_STORAGE: "extra_storage",
    PACK_PRO: "pack_pro",
    PACK_MAX: "pack_max",
    RENTED_MACHINE: "rented_machine",
} as const;
export type AddonCode = (typeof AddonCode)[keyof typeof AddonCode];
export const AddonStatus = {
    ACTIVE: "active",
    CANCELED: "canceled",
} as const;
export type AddonStatus = (typeof AddonStatus)[keyof typeof AddonStatus];
export const HostedSlotStatus = {
    AVAILABLE: "available",
    RENTED: "rented",
    MAINTENANCE: "maintenance",
    RETIRED: "retired",
} as const;
export type HostedSlotStatus = (typeof HostedSlotStatus)[keyof typeof HostedSlotStatus];
