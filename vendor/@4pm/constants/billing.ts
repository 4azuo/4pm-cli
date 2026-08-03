/**
 * Billing / payment constants (ADR-0095 · ADR-0104).
 */

/** Hosted-payment provider chosen per checkout (ADR-0104 multi-provider). */
export const PaymentProvider = {
  STRIPE: "stripe",
  PAYPAL: "paypal",
} as const;

/** Union type of payment providers. */
export type PaymentProvider = (typeof PaymentProvider)[keyof typeof PaymentProvider];

/** Plan code that is NOT self-serve (assigned manually — ADR-0095 tier table). */
export const ENTERPRISE_PLAN_CODE = "enterprise";

/** How a subscription period is paid (ADR-0120). */
export const PaymentMethod = {
  CARD: "card",
  CREDIT: "credit",
} as const;

/** Union type of payment methods. */
export type PaymentMethod = (typeof PaymentMethod)[keyof typeof PaymentMethod];

/** Category of a recurring subscription add-on (ADR-0123). */
export const AddonKind = {
  /** Extra hosted-storage capacity (raises the storage cap — ADR-0122/0124). */
  STORAGE: "storage",
  /** Scale pack — a pro/max bundle added onto the current plan's caps (ADR-0124). */
  SCALE_PACK: "scale_pack",
  /** Rented (4PM-hosted) machine-user seat (ADR-0126). */
  MACHINE_USER: "machine_user",
} as const;

/** Union type of add-on kinds. */
export type AddonKind = (typeof AddonKind)[keyof typeof AddonKind];

/** Stable catalog codes of the purchasable add-on SKUs (ADR-0123). */
export const AddonCode = {
  EXTRA_STORAGE: "extra_storage",
  PACK_PRO: "pack_pro",
  PACK_MAX: "pack_max",
  RENTED_MACHINE: "rented_machine",
} as const;

/** Union type of add-on catalog codes. */
export type AddonCode = (typeof AddonCode)[keyof typeof AddonCode];

/** Lifecycle status of a subscription add-on (ADR-0123). */
export const AddonStatus = {
  ACTIVE: "active",
  /** Scheduled to end at the current period end (no refund). */
  CANCELED: "canceled",
} as const;

/** Union type of add-on statuses. */
export type AddonStatus = (typeof AddonStatus)[keyof typeof AddonStatus];

/** Status of a 4PM-hosted machine-user pool slot (ADR-0126). */
export const HostedSlotStatus = {
  AVAILABLE: "available",
  RENTED: "rented",
  MAINTENANCE: "maintenance",
  RETIRED: "retired",
} as const;

/** Union type of hosted-slot statuses. */
export type HostedSlotStatus =
  (typeof HostedSlotStatus)[keyof typeof HostedSlotStatus];
