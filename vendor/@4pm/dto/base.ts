/**
 * Vendored from @4pm/dto (base.ts) by scripts/vendor-shared.mjs — do not edit.
 */
import { z } from "zod";
import type { ErrorCode } from "@4pm/shared-constants";
export type ErrorMeta = Record<string, string | number>;
export interface BaseResponse<T = unknown> {
    success: boolean;
    errorCode: ErrorCode | null;
    message: string | null;
    data: T | null;
    errorId?: string;
    meta?: ErrorMeta;
    page?: number;
    size?: number;
    total?: number;
    max?: number;
    hasOlder?: boolean;
    hasNewer?: boolean;
}
export function isBaseResponse(value: unknown): value is BaseResponse {
    return (typeof value === "object" &&
        value !== null &&
        "success" in value &&
        "errorCode" in value &&
        "data" in value);
}
export function successResponse<T>(data: T | null, message: string | null = null): BaseResponse<T> {
    return { success: true, errorCode: null, message, data };
}
export function listResponse<T>(items: T[], page: number, size: number, total: number, max?: number): BaseResponse<T[]> {
    return {
        success: true,
        errorCode: null,
        message: null,
        data: items,
        page,
        size,
        total,
        ...(max !== undefined ? { max } : {}),
    };
}
export interface ErrorResponseOptions {
    errorId?: string;
    meta?: ErrorMeta;
    message?: string | null;
}
export function errorResponse(errorCode: ErrorCode, options: ErrorResponseOptions = {}): BaseResponse<never> {
    return {
        success: false,
        errorCode,
        message: options.message ?? null,
        data: null,
        ...(options.errorId ? { errorId: options.errorId } : {}),
        ...(options.meta ? { meta: options.meta } : {}),
    };
}
export const baseRequestSchema = z.object({
    page: z.coerce.number().int().min(1).default(1),
    size: z.coerce.number().int().min(1).max(100).default(20),
    search: z.string().max(200).optional(),
    sort: z.string().max(50).optional(),
    order: z.enum(["asc", "desc"]).default("desc"),
});
export type BaseRequest = z.infer<typeof baseRequestSchema>;
export const pinnedFilterSchema = z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional();
export const deletedFilterSchema = z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional();
