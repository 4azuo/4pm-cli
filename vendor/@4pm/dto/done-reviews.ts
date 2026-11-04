/**
 * Vendored from @4pm/dto (done-reviews.ts) by scripts/vendor-shared.mjs — do not edit.
 */
import { z } from "zod";
import { SIDECAR_DIR } from "./autonomous-books-set";
export const DONE_REVIEWS_SIDECAR_REL = `${SIDECAR_DIR}/.autonomous.done-reviews.json`;
export const DONE_REVIEW_STATES = ["open", "closed"] as const;
export type DoneReviewState = (typeof DONE_REVIEW_STATES)[number];
export interface DoneReviewEntry {
    state: DoneReviewState;
    proposals: string[];
    at: string;
    closedBy?: string;
    closedByLabel?: string;
    closedAt?: string;
    created?: string[];
}
export type DoneReviewsSidecar = Record<string, DoneReviewEntry>;
export function parseDoneReviews(text: string | null | undefined): DoneReviewsSidecar {
    try {
        const o = JSON.parse(text || "{}") as unknown;
        if (!o || typeof o !== "object" || Array.isArray(o))
            return {};
        const out: DoneReviewsSidecar = {};
        for (const [id, v] of Object.entries(o as Record<string, unknown>)) {
            const r = (v ?? {}) as Record<string, unknown>;
            if (r.state !== "open" && r.state !== "closed")
                continue;
            const str = (x: unknown): string | undefined => (typeof x === "string" ? x : undefined);
            const list = (x: unknown): string[] => (Array.isArray(x) ? x.filter((s): s is string => typeof s === "string") : []);
            out[id] = {
                state: r.state,
                proposals: list(r.proposals),
                at: str(r.at) ?? "",
                ...(str(r.closedBy) ? { closedBy: str(r.closedBy) } : {}),
                ...(str(r.closedByLabel) ? { closedByLabel: str(r.closedByLabel) } : {}),
                ...(str(r.closedAt) ? { closedAt: str(r.closedAt) } : {}),
                ...(list(r.created).length ? { created: list(r.created) } : {}),
            };
        }
        return out;
    }
    catch {
        return {};
    }
}
export const doneReviewBodySchema = z
    .object({
    action: z.enum(["close", "created"]),
    createdIds: z.array(z.string().min(1).max(64)).max(50).optional(),
})
    .strict();
export type DoneReviewBody = z.infer<typeof doneReviewBodySchema>;
export function mayCloseDoneReview(row: {
    assigneeIds: readonly string[];
    requesterId: string | null;
}, userId: string, adminOrPm: boolean): boolean {
    if (adminOrPm)
        return true;
    if (row.assigneeIds.length)
        return row.assigneeIds.includes(userId);
    return row.requesterId === userId;
}
