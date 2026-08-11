/**
 * BaseResponse (ADR-0009) + BaseRequest (ADR-0008) — standard envelope & list
 * query params for every API.
 *
 * Error i18n: on failure the server returns `errorCode` (+ optional `meta` for
 * interpolation) and clients localize the message themselves. `message` is only
 * an English fallback / for non-i18n clients; `errorId` is a support reference,
 * never shown to end users.
 */
import { z } from "zod";
import type { ErrorCode } from "@4pm/constants";

/** Interpolation params attached to an error so clients can build the message. */
export type ErrorMeta = Record<string, string | number>;

/** Standard envelope wrapping every response that has a body. */
export interface BaseResponse<T = unknown> {
  success: boolean;
  errorCode: ErrorCode | null;
  /** English fallback message; clients should localize from `errorCode`. */
  message: string | null;
  data: T | null;
  /** Support reference for tracing logs (not shown to end users). */
  errorId?: string;
  /** Interpolation params for the localized error message. */
  meta?: ErrorMeta;
  /** List endpoints only. */
  page?: number;
  size?: number;
  total?: number;
}

/**
 * Whether a value is already a BaseResponse envelope. The single source of truth for
 * envelope detection — reused by the server's ResponseInterceptor (skip double-wrapping)
 * and by S2S clients that unwrap the envelope's `data`. Checked by the full envelope
 * signature (`success` + `errorCode` + `data`), never by the presence of `data` alone, so
 * a raw paging payload like `{ data, total }` is not mistaken for an envelope.
 */
export function isBaseResponse(value: unknown): value is BaseResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "success" in value &&
    "errorCode" in value &&
    "data" in value
  );
}

/** Build a successful BaseResponse (optional message). */
export function successResponse<T>(
  data: T | null,
  message: string | null = null,
): BaseResponse<T> {
  return { success: true, errorCode: null, message, data };
}

/** Build a successful list BaseResponse (page/size/total on the envelope). */
export function listResponse<T>(
  items: T[],
  page: number,
  size: number,
  total: number,
): BaseResponse<T[]> {
  return { success: true, errorCode: null, message: null, data: items, page, size, total };
}

/** Options for an error BaseResponse. */
export interface ErrorResponseOptions {
  /** Support reference id (kept in body + logs, never shown to end users). */
  errorId?: string;
  /** Interpolation params for the localized message. */
  meta?: ErrorMeta;
  /** English fallback message (clients localize from `errorCode`). */
  message?: string | null;
}

/**
 * Build an error BaseResponse. The `errorId` stays a separate field and is not
 * concatenated into `message`, so it never leaks into the UI.
 */
export function errorResponse(
  errorCode: ErrorCode,
  options: ErrorResponseOptions = {},
): BaseResponse<never> {
  return {
    success: false,
    errorCode,
    message: options.message ?? null,
    data: null,
    ...(options.errorId ? { errorId: options.errorId } : {}),
    ...(options.meta ? { meta: options.meta } : {}),
  };
}

/** Shared query schema for list endpoints (page/size/search/sort/order). */
export const baseRequestSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  size: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().max(200).optional(),
  sort: z.string().max(50).optional(),
  order: z.enum(["asc", "desc"]).default("desc"),
});

/** Standard list/query params — list DTOs extend with their own filters. */
export type BaseRequest = z.infer<typeof baseRequestSchema>;

/** Filter `pinned=true` (string query ⇒ boolean) — shared list flag (ADR-0027). */
export const pinnedFilterSchema = z
  .enum(["true", "false"])
  .transform((v) => v === "true")
  .optional();

/**
 * Filter `deleted=true` (string query ⇒ boolean) — ADMIN-only Trash view listing
 * soft-deleted records (ADR-0109). Shared by project/team/user list DTOs.
 */
export const deletedFilterSchema = z
  .enum(["true", "false"])
  .transform((v) => v === "true")
  .optional();
