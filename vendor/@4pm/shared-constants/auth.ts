/**
 * Vendored from @4pm/shared-constants (auth.ts) by scripts/vendor-shared.mjs — do not edit.
 */
export const MailTokenPurpose = {
    VERIFY_EMAIL: "verify",
    CHANGE_PASSWORD: "change",
    RESET_PASSWORD: "reset",
} as const;
export type MailTokenPurpose = (typeof MailTokenPurpose)[keyof typeof MailTokenPurpose];
export const MfaPolicy = {
    OFF: "off",
    ADMINS: "admins",
    ALL: "all",
} as const;
export type MfaPolicy = (typeof MfaPolicy)[keyof typeof MfaPolicy];
export const MfaMethod = {
    TOTP: "totp",
    PASSKEY: "passkey",
    RECOVERY: "recovery",
    EMAIL: "email",
} as const;
export type MfaMethod = (typeof MfaMethod)[keyof typeof MfaMethod];
export const MFA_RECOVERY_CODE_COUNT = 10;
