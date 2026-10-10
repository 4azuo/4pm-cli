/**
 * Constants for the authentication flow.
 * @adr 0005
 */

/** Access-token lifetime (seconds) — JWT 1 hour, checked against Redis. */
export const ACCESS_TOKEN_TTL_SEC = 60 * 60;

/** Mail-token TTL (seconds) — verify/change/reset, one-time, 5 minutes. */
export const MAIL_TOKEN_TTL_SEC = 5 * 60;

/** Number of consecutive failed logins before a temporary account lockout. */
export const LOCKOUT_MAX_ATTEMPTS = 5;

/** Base lockout duration (seconds) — backoff increases with each lockout. */
export const LOCKOUT_BASE_SEC = 15 * 60;

/** Random-token length (bytes) — 256-bit for mail token / refresh / hashcode. */
export const TOKEN_BYTES = 32;

/** Purpose of a token sent by mail. */
export const MailTokenPurpose = {
  VERIFY_EMAIL: "verify",
  CHANGE_PASSWORD: "change",
  RESET_PASSWORD: "reset",
} as const;

/** Union type of mail-token purposes. */
export type MailTokenPurpose =
  (typeof MailTokenPurpose)[keyof typeof MailTokenPurpose];

/**
 * Org MFA policy (`settings.security.mfaPolicy`): who must have a second factor. MACHINE users are
 * always exempt; root is always required.
 * @adr 0446
 */
export const MfaPolicy = {
  OFF: "off",
  ADMINS: "admins",
  ALL: "all",
} as const;

/** Union type of org MFA policies. */
export type MfaPolicy = (typeof MfaPolicy)[keyof typeof MfaPolicy];

/** Second-factor methods a login challenge can offer. @adr 0446 */
export const MfaMethod = {
  TOTP: "totp",
  PASSKEY: "passkey",
  RECOVERY: "recovery",
  EMAIL: "email",
} as const;

/** Union type of second-factor methods. */
export type MfaMethod = (typeof MfaMethod)[keyof typeof MfaMethod];

/** Number of recovery codes issued per batch. @adr 0446 */
export const MFA_RECOVERY_CODE_COUNT = 10;
