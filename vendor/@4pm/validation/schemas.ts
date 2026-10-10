/**
 * Shared validation schemas (zod): password policy, IP/CIDR, username,
 * email/phone, hashcode & mail token format.
 */
import { z } from "zod";

/** Minimum length of a NEW password (ADR-0426, NIST SP 800-63B — no composition rules). */
export const PASSWORD_MIN_LENGTH = 12;

/** Maximum accepted password length — long passphrases must fit (NIST: allow ≥ 64). */
export const PASSWORD_MAX_LENGTH = 128;

/**
 * Policy for a NEW password (ADR-0426): 12–128 characters, any characters — no letter/digit rule.
 * Breached passwords are refused server-side (Have I Been Pwned). Existing shorter passwords still
 * log in: login / current-password fields only bound the length ({@link passwordInputSchema}).
 */
export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `password: at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(PASSWORD_MAX_LENGTH, `password: at most ${PASSWORD_MAX_LENGTH} characters`);

/** An EXISTING password typed to log in / confirm (any length the old or new policy allowed). */
export const passwordInputSchema = z.string().min(1).max(PASSWORD_MAX_LENGTH);

/** Username: 3–32 characters, letters/digits and . _ -, starting with a letter or digit. */
export const usernameSchema = z
  .string()
  .min(3)
  .max(32)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, "username: invalid characters");

/** A valid email (normalized to lowercase). */
export const emailSchema = z.string().email().max(254).toLowerCase();

/** Phone number: 8–15 digits, an optional + prefix. */
export const phoneSchema = z
  .string()
  .regex(/^\+?[0-9]{8,15}$/, "phone: invalid format");

const IPV4_CIDR_RE =
  /^((25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9])(\/(3[0-2]|[12]?[0-9]))?$/;
const IPV6_LAX_RE = /^[0-9a-fA-F:]{2,45}(\/(12[0-8]|1[01][0-9]|[1-9]?[0-9]))?$/;

/** A single IP or CIDR range (strict IPv4; loose IPv6 check). */
export const ipCidrSchema = z
  .string()
  .refine((v) => IPV4_CIDR_RE.test(v) || IPV6_LAX_RE.test(v), {
    message: "ipAllowlist: invalid IP/CIDR",
  });

/** IP allowlist — empty = allow every IP. */
export const ipAllowlistSchema = z.array(ipCidrSchema).max(50).default([]);

/** A 256-bit hex token (mail token, refresh token, hashcode). */
export const hexTokenSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "token: invalid format");
