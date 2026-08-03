/**
 * Shared validation schemas (zod): password policy, IP/CIDR, username,
 * email/phone, hashcode & mail token format.
 */
import { z } from "zod";

/** Password policy: 8–32 characters, at least 1 letter and 1 digit. */
export const passwordSchema = z
  .string()
  .min(8, "password: at least 8 characters")
  .max(32, "password: at most 32 characters")
  .regex(/[a-zA-Z]/, "password: needs at least 1 letter")
  .regex(/[0-9]/, "password: needs at least 1 digit");

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
