/**
 * First-login onboarding: the per-user answers (`users.settings.onboarding`) and the org answers
 * (`organization.settings.onboarding`), plus the body of PUT /users/me/onboarding.
 * @adr 0610 @api user-0032
 */
import { z } from "zod";

/** The interface a user prefers: the Simple UI (`/simple/*`) or the full app. */
export const UI_MODES = ["simple", "full"] as const;
export type UiMode = (typeof UI_MODES)[number];

/** Whether the user works on one project or several (one ⇒ the Focus project widget leads the Overview). */
export const PROJECT_FOCUS = ["single", "many"] as const;
export type ProjectFocus = (typeof PROJECT_FOCUS)[number];

/** What the org builds (multi-select). */
export const ONBOARDING_GOALS = ["game", "web", "desktop", "mobile", "other"] as const;
export type OnboardingGoal = (typeof ONBOARDING_GOALS)[number];

/** The usual project size of the org. */
export const PROJECT_SIZES = ["small", "large"] as const;
export type ProjectSize = (typeof PROJECT_SIZES)[number];

/** The caller's own answers (`users.settings.onboarding`); no `completedAt` ⇒ the wizard opens. */
export interface UserOnboarding {
  uiMode?: UiMode;
  tutorial?: { enabled: boolean };
  projectFocus?: ProjectFocus;
  skipped?: boolean;
  completedAt?: string;
}

/** The org answers (`organization.settings.onboarding`), surfaced to every member on GET /users/me. */
export interface OrgOnboarding {
  goals: OnboardingGoal[];
  size?: ProjectSize;
  skipped?: boolean;
  completedAt?: string;
}

/** Body of PUT /users/me/onboarding — the `org` part is applied only for root / ADMIN while the org is open. */
export const onboardingUpdateSchema = z.object({
  uiMode: z.enum(UI_MODES).optional(),
  tutorial: z.object({ enabled: z.boolean() }).optional(),
  projectFocus: z.enum(PROJECT_FOCUS).optional(),
  skipped: z.boolean().optional(),
  complete: z.boolean().optional(),
  org: z
    .object({
      goals: z.array(z.enum(ONBOARDING_GOALS)).max(ONBOARDING_GOALS.length).optional(),
      size: z.enum(PROJECT_SIZES).optional(),
      skipped: z.boolean().optional(),
    })
    .optional(),
});
export type OnboardingUpdate = z.infer<typeof onboardingUpdateSchema>;

/** The `settings.onboarding` namespace of PATCH /organizations/me (ADMIN edit). @api org-0002 */
export const orgOnboardingSettingsSchema = z.object({
  goals: z.array(z.enum(ONBOARDING_GOALS)).max(ONBOARDING_GOALS.length).default([]),
  size: z.enum(PROJECT_SIZES).optional(),
  skipped: z.boolean().optional(),
  completedAt: z.string().optional(),
});

/** Read a stored user onboarding blob (anything invalid ⇒ empty, so the wizard opens). */
export function readUserOnboarding(raw: unknown): UserOnboarding {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out: UserOnboarding = {};
  if (UI_MODES.includes(o.uiMode as UiMode)) out.uiMode = o.uiMode as UiMode;
  const tut = o.tutorial as Record<string, unknown> | undefined;
  if (tut && typeof tut.enabled === "boolean") out.tutorial = { enabled: tut.enabled };
  if (PROJECT_FOCUS.includes(o.projectFocus as ProjectFocus)) out.projectFocus = o.projectFocus as ProjectFocus;
  if (o.skipped === true) out.skipped = true;
  if (typeof o.completedAt === "string") out.completedAt = o.completedAt;
  return out;
}

/** Read a stored org onboarding blob. */
export function readOrgOnboarding(raw: unknown): OrgOnboarding {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const goals = Array.isArray(o.goals) ? o.goals.filter((g): g is OnboardingGoal => ONBOARDING_GOALS.includes(g as OnboardingGoal)) : [];
  const out: OrgOnboarding = { goals: [...new Set(goals)] };
  if (PROJECT_SIZES.includes(o.size as ProjectSize)) out.size = o.size as ProjectSize;
  if (o.skipped === true) out.skipped = true;
  if (typeof o.completedAt === "string") out.completedAt = o.completedAt;
  return out;
}

/**
 * Apply an onboarding update to the stored blobs (pure). The org part applies only when `canAnswerOrg` and the org
 * onboarding is still open; `complete` stamps `completedAt` on the user (and on the org when its part was applied).
 */
export function applyOnboardingUpdate(
  user: UserOnboarding,
  org: OrgOnboarding,
  body: OnboardingUpdate,
  canAnswerOrg: boolean,
  now: string,
): { user: UserOnboarding; org: OrgOnboarding; orgChanged: boolean } {
  const nextUser: UserOnboarding = { ...user };
  if (body.uiMode) nextUser.uiMode = body.uiMode;
  if (body.tutorial) nextUser.tutorial = { enabled: body.tutorial.enabled };
  if (body.projectFocus) nextUser.projectFocus = body.projectFocus;
  if (body.skipped !== undefined) nextUser.skipped = body.skipped || undefined;
  if (body.complete && !nextUser.completedAt) nextUser.completedAt = now;
  let nextOrg = org;
  let orgChanged = false;
  if (body.org && canAnswerOrg && !org.completedAt) {
    nextOrg = { ...org };
    if (body.org.goals) nextOrg.goals = [...new Set(body.org.goals)];
    if (body.org.size) nextOrg.size = body.org.size;
    if (body.org.skipped !== undefined) nextOrg.skipped = body.org.skipped || undefined;
    if (body.complete) nextOrg.completedAt = now;
    orgChanged = true;
  }
  return { user: nextUser, org: nextOrg, orgChanged };
}

/** Spec `platform` values the org goals map to (the `other` goal maps to none). */
const GOAL_PLATFORM: Partial<Record<OnboardingGoal, string>> = { game: "game", web: "web", desktop: "desktop", mobile: "mobile" };

/** The spec `platform` to preselect for a new project: set only when the org named exactly one platform goal. */
export function platformFromGoals(goals: readonly OnboardingGoal[]): string | undefined {
  const platforms = [...new Set(goals.map((g) => GOAL_PLATFORM[g]).filter((p): p is string => Boolean(p)))];
  return platforms.length === 1 ? platforms[0] : undefined;
}

/** Spec groups a *small* org sees collapsed behind "Show more" in the create wizard. */
export const OPTIONAL_SPEC_GROUPS_SMALL = ["context", "constraints", "deploy"] as const;
