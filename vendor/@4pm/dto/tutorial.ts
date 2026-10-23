/**
 * Guided tutorial state per user (`users.settings.tutorial`): whether tours start on their own, and the version of
 * each tour already seen; plus the body of PUT /users/me/tutorial.
 * @adr 0612 @api user-0034
 */
import { z } from "zod";

/** The caller's tour state. */
export interface UserTutorial {
  enabled: boolean;
  /** Tour id → the version finished or skipped. */
  seen: Record<string, number>;
}

/** Tour ids are kebab / dotted names. */
const TOUR_ID = /^[a-z0-9][a-z0-9.-]{0,63}$/;

/** Body of PUT /users/me/tutorial — `reset` clears `seen` (Restart all tours). */
export const tutorialUpdateSchema = z
  .object({
    enabled: z.boolean().optional(),
    seen: z.record(z.string().regex(TOUR_ID), z.number().int().min(0).max(10_000)).optional(),
    reset: z.boolean().optional(),
  })
  .refine((b) => b.enabled !== undefined || b.seen !== undefined || b.reset !== undefined, { message: "nothing to update" });
export type TutorialUpdate = z.infer<typeof tutorialUpdateSchema>;

/**
 * Read the tour state from a user's settings object: `tutorial`, falling back to the first-login answer
 * (`onboarding.tutorial.enabled`) for `enabled`.
 */
export function readUserTutorial(settings: Record<string, unknown> | null | undefined): UserTutorial {
  const s = settings ?? {};
  const raw = (s.tutorial && typeof s.tutorial === "object" ? s.tutorial : {}) as Record<string, unknown>;
  const onb = (s.onboarding && typeof s.onboarding === "object" ? s.onboarding : {}) as { tutorial?: { enabled?: unknown } };
  const enabled = typeof raw.enabled === "boolean" ? raw.enabled : onb.tutorial?.enabled === true;
  const seen: Record<string, number> = {};
  if (raw.seen && typeof raw.seen === "object") {
    for (const [k, v] of Object.entries(raw.seen as Record<string, unknown>)) {
      if (TOUR_ID.test(k) && typeof v === "number" && Number.isInteger(v) && v >= 0) seen[k] = v;
    }
  }
  return { enabled, seen };
}

/** Apply an update (pure): `reset` first, then `seen` merged (a higher version wins), then `enabled`. */
export function applyTutorialUpdate(cur: UserTutorial, body: TutorialUpdate): UserTutorial {
  const seen = body.reset ? {} : { ...cur.seen };
  for (const [k, v] of Object.entries(body.seen ?? {})) seen[k] = Math.max(seen[k] ?? 0, v);
  return { enabled: body.enabled ?? cur.enabled, seen };
}
