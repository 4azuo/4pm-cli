/**
 * Vendored from @4pm/dto (onboarding.ts) by scripts/vendor-shared.mjs — do not edit.
 */
import { z } from "zod";
export const UI_MODES = ["simple", "full"] as const;
export type UiMode = (typeof UI_MODES)[number];
export const PROJECT_FOCUS = ["single", "many"] as const;
export type ProjectFocus = (typeof PROJECT_FOCUS)[number];
export const ONBOARDING_GOALS = ["game", "web", "desktop", "mobile", "other"] as const;
export type OnboardingGoal = (typeof ONBOARDING_GOALS)[number];
export const PROJECT_SIZES = ["small", "large"] as const;
export type ProjectSize = (typeof PROJECT_SIZES)[number];
export interface UserOnboarding {
    uiMode?: UiMode;
    tutorial?: {
        enabled: boolean;
    };
    projectFocus?: ProjectFocus;
    skipped?: boolean;
    completedAt?: string;
}
export interface OrgOnboarding {
    goals: OnboardingGoal[];
    size?: ProjectSize;
    skipped?: boolean;
    completedAt?: string;
}
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
export const orgOnboardingSettingsSchema = z.object({
    goals: z.array(z.enum(ONBOARDING_GOALS)).max(ONBOARDING_GOALS.length).default([]),
    size: z.enum(PROJECT_SIZES).optional(),
    skipped: z.boolean().optional(),
    completedAt: z.string().optional(),
});
export function readUserOnboarding(raw: unknown): UserOnboarding {
    const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const out: UserOnboarding = {};
    if (UI_MODES.includes(o.uiMode as UiMode))
        out.uiMode = o.uiMode as UiMode;
    const tut = o.tutorial as Record<string, unknown> | undefined;
    if (tut && typeof tut.enabled === "boolean")
        out.tutorial = { enabled: tut.enabled };
    if (PROJECT_FOCUS.includes(o.projectFocus as ProjectFocus))
        out.projectFocus = o.projectFocus as ProjectFocus;
    if (o.skipped === true)
        out.skipped = true;
    if (typeof o.completedAt === "string")
        out.completedAt = o.completedAt;
    return out;
}
export function readOrgOnboarding(raw: unknown): OrgOnboarding {
    const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const goals = Array.isArray(o.goals) ? o.goals.filter((g): g is OnboardingGoal => ONBOARDING_GOALS.includes(g as OnboardingGoal)) : [];
    const out: OrgOnboarding = { goals: [...new Set(goals)] };
    if (PROJECT_SIZES.includes(o.size as ProjectSize))
        out.size = o.size as ProjectSize;
    if (o.skipped === true)
        out.skipped = true;
    if (typeof o.completedAt === "string")
        out.completedAt = o.completedAt;
    return out;
}
export function applyOnboardingUpdate(user: UserOnboarding, org: OrgOnboarding, body: OnboardingUpdate, canAnswerOrg: boolean, now: string): {
    user: UserOnboarding;
    org: OrgOnboarding;
    orgChanged: boolean;
} {
    const nextUser: UserOnboarding = { ...user };
    if (body.uiMode)
        nextUser.uiMode = body.uiMode;
    if (body.tutorial)
        nextUser.tutorial = { enabled: body.tutorial.enabled };
    if (body.projectFocus)
        nextUser.projectFocus = body.projectFocus;
    if (body.skipped !== undefined)
        nextUser.skipped = body.skipped || undefined;
    if (body.complete && !nextUser.completedAt)
        nextUser.completedAt = now;
    let nextOrg = org;
    let orgChanged = false;
    if (body.org && canAnswerOrg && !org.completedAt) {
        nextOrg = { ...org };
        if (body.org.goals)
            nextOrg.goals = [...new Set(body.org.goals)];
        if (body.org.size)
            nextOrg.size = body.org.size;
        if (body.org.skipped !== undefined)
            nextOrg.skipped = body.org.skipped || undefined;
        if (body.complete)
            nextOrg.completedAt = now;
        orgChanged = true;
    }
    return { user: nextUser, org: nextOrg, orgChanged };
}
const GOAL_PLATFORM: Partial<Record<OnboardingGoal, string>> = { game: "game", web: "web", desktop: "desktop", mobile: "mobile" };
export function platformFromGoals(goals: readonly OnboardingGoal[]): string | undefined {
    const platforms = [...new Set(goals.map((g) => GOAL_PLATFORM[g]).filter((p): p is string => Boolean(p)))];
    return platforms.length === 1 ? platforms[0] : undefined;
}
export const OPTIONAL_SPEC_GROUPS_SMALL = ["context", "constraints", "deploy"] as const;
