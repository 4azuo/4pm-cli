/**
 * AI Done follow-up reviews: when the automatic done-verify (Rigor · Full power) proposes follow-ups for a finished
 * row, the row's review is **open** until one of the people who may decide closes it — by hand, or by creating the
 * follow-up rows. Stored on the books branch in `.4pm/.autonomous.done-reviews.json`, shared by the whole team.
 * @adr 0616
 */
import { z } from "zod";
import { SIDECAR_DIR } from "./autonomous-books-set";

/** The done-reviews sidecar. */
export const DONE_REVIEWS_SIDECAR_REL = `${SIDECAR_DIR}/.autonomous.done-reviews.json`;

/** Where a row's follow-up review stands. */
export const DONE_REVIEW_STATES = ["open", "closed"] as const;
export type DoneReviewState = (typeof DONE_REVIEW_STATES)[number];

/** One AI Done row's follow-up review. */
export interface DoneReviewEntry {
  state: DoneReviewState;
  /** The follow-ups the done-verify proposed (one line each). */
  proposals: string[];
  /** When the proposals were written (ISO). */
  at: string;
  closedBy?: string;
  closedByLabel?: string;
  closedAt?: string;
  /** The follow-up rows created from the proposals (when closed that way). */
  created?: string[];
}

/** The sidecar: AI Done row id → its review. */
export type DoneReviewsSidecar = Record<string, DoneReviewEntry>;

/** Parse the sidecar (malformed entries dropped; `{}` on anything invalid). */
export function parseDoneReviews(text: string | null | undefined): DoneReviewsSidecar {
  try {
    const o = JSON.parse(text || "{}") as unknown;
    if (!o || typeof o !== "object" || Array.isArray(o)) return {};
    const out: DoneReviewsSidecar = {};
    for (const [id, v] of Object.entries(o as Record<string, unknown>)) {
      const r = (v ?? {}) as Record<string, unknown>;
      if (r.state !== "open" && r.state !== "closed") continue;
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
  } catch {
    return {};
  }
}

/** Body POST /machines/:id/autonomous/done/:rowId/review — close it, or record the follow-up rows created from it. @api machine-0102 */
export const doneReviewBodySchema = z
  .object({
    action: z.enum(["close", "created"]),
    createdIds: z.array(z.string().min(1).max(64)).max(50).optional(),
  })
  .strict();
export type DoneReviewBody = z.infer<typeof doneReviewBodySchema>;

/**
 * Who may close an AI Done row's review: its assignees; with no assignee its requester; ADMIN and the PM always.
 */
export function mayCloseDoneReview(row: { assigneeIds: readonly string[]; requesterId: string | null }, userId: string, adminOrPm: boolean): boolean {
  if (adminOrPm) return true;
  if (row.assigneeIds.length) return row.assigneeIds.includes(userId);
  return row.requesterId === userId;
}
