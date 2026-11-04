/**
 * Vendored from @4pm/dto (tutorial.ts) by scripts/vendor-shared.mjs — do not edit.
 */
import { z } from "zod";
export interface UserTutorial {
    enabled: boolean;
    seen: Record<string, number>;
}
export const TOUR_ID = /^[a-z0-9][a-z0-9.-]{0,63}$/;
export const tutorialUpdateSchema = z
    .object({
    enabled: z.boolean().optional(),
    seen: z.record(z.string().regex(TOUR_ID), z.number().int().min(0).max(10000)).optional(),
    reset: z.boolean().optional(),
})
    .refine((b) => b.enabled !== undefined || b.seen !== undefined || b.reset !== undefined, { message: "nothing to update" });
export type TutorialUpdate = z.infer<typeof tutorialUpdateSchema>;
export function readUserTutorial(settings: Record<string, unknown> | null | undefined): UserTutorial {
    const s = settings ?? {};
    const raw = (s.tutorial && typeof s.tutorial === "object" ? s.tutorial : {}) as Record<string, unknown>;
    const onb = (s.onboarding && typeof s.onboarding === "object" ? s.onboarding : {}) as {
        tutorial?: {
            enabled?: unknown;
        };
    };
    const enabled = typeof raw.enabled === "boolean" ? raw.enabled : onb.tutorial?.enabled === true;
    const seen: Record<string, number> = {};
    if (raw.seen && typeof raw.seen === "object") {
        for (const [k, v] of Object.entries(raw.seen as Record<string, unknown>)) {
            if (TOUR_ID.test(k) && typeof v === "number" && Number.isInteger(v) && v >= 0)
                seen[k] = v;
        }
    }
    return { enabled, seen };
}
export function applyTutorialUpdate(cur: UserTutorial, body: TutorialUpdate): UserTutorial {
    const seen = body.reset ? {} : { ...cur.seen };
    for (const [k, v] of Object.entries(body.seen ?? {}))
        seen[k] = Math.max(seen[k] ?? 0, v);
    return { enabled: body.enabled ?? cur.enabled, seen };
}
