/**
 * Vendored from @4pm/validation (schemas.ts) by scripts/vendor-shared.mjs — do not edit.
 */
import { z } from "zod";
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;
export const passwordSchema = z
    .string()
    .min(PASSWORD_MIN_LENGTH, `password: at least ${PASSWORD_MIN_LENGTH} characters`)
    .max(PASSWORD_MAX_LENGTH, `password: at most ${PASSWORD_MAX_LENGTH} characters`);
export const passwordInputSchema = z.string().min(1).max(PASSWORD_MAX_LENGTH);
export const usernameSchema = z
    .string()
    .min(3)
    .max(32)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, "username: invalid characters");
export const emailSchema = z.string().email().max(254).toLowerCase();
export const phoneSchema = z
    .string()
    .regex(/^\+?[0-9]{8,15}$/, "phone: invalid format");
const IPV4_CIDR_RE = /^((25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9])(\/(3[0-2]|[12]?[0-9]))?$/;
const IPV6_LAX_RE = /^[0-9a-fA-F:]{2,45}(\/(12[0-8]|1[01][0-9]|[1-9]?[0-9]))?$/;
export const ipCidrSchema = z
    .string()
    .refine((v) => IPV4_CIDR_RE.test(v) || IPV6_LAX_RE.test(v), {
    message: "ipAllowlist: invalid IP/CIDR",
});
export const ipAllowlistSchema = z.array(ipCidrSchema).max(50).default([]);
export const hexTokenSchema = z
    .string()
    .regex(/^[0-9a-f]{64}$/, "token: invalid format");
