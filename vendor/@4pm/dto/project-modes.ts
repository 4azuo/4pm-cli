/**
 * Vendored from @4pm/dto (project-modes.ts) by scripts/vendor-shared.mjs — do not edit.
 */
import { z } from "zod";
import type { ProjectAutonomousSettings } from "./autonomous-policy";
export const DELIVERY_MODES = ["auto", "manual"] as const;
export const RIGOR_MODES = ["full", "efficient", "fast"] as const;
export const COLLABORATION_MODES = ["team", "personal"] as const;
export type DeliveryMode = (typeof DELIVERY_MODES)[number];
export type RigorMode = (typeof RIGOR_MODES)[number];
export type CollaborationMode = (typeof COLLABORATION_MODES)[number];
export interface ProjectModes {
    delivery: DeliveryMode;
    rigor: RigorMode;
    collaboration: CollaborationMode;
    pendingAuto?: boolean;
    autoProbe?: {
        ok: boolean;
        reason?: string;
        at: string;
    };
}
export const DEFAULT_PROJECT_MODES: ProjectModes = { delivery: "manual", rigor: "efficient", collaboration: "team" };
export const projectModesSchema = z
    .object({
    delivery: z.enum(DELIVERY_MODES),
    rigor: z.enum(RIGOR_MODES),
    collaboration: z.enum(COLLABORATION_MODES),
})
    .strict();
export const projectModesWriteSchema = z.object({ modes: projectModesSchema }).strict();
export type ProjectModesWriteBody = z.infer<typeof projectModesWriteSchema>;
export function readProjectModes(raw: unknown): ProjectModes {
    const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const p = (o.autoProbe && typeof o.autoProbe === "object" ? o.autoProbe : null) as Record<string, unknown> | null;
    const autoProbe = p && typeof p.ok === "boolean" && typeof p.at === "string"
        ? { ok: p.ok, at: p.at, ...(typeof p.reason === "string" ? { reason: p.reason.slice(0, 300) } : {}) }
        : null;
    const pick = <T extends string>(list: readonly T[], v: unknown, def: T): T => (list.includes(v as T) ? (v as T) : def);
    return {
        delivery: pick(DELIVERY_MODES, o.delivery, DEFAULT_PROJECT_MODES.delivery),
        rigor: pick(RIGOR_MODES, o.rigor, DEFAULT_PROJECT_MODES.rigor),
        collaboration: pick(COLLABORATION_MODES, o.collaboration, DEFAULT_PROJECT_MODES.collaboration),
        ...(o.pendingAuto === true ? { pendingAuto: true } : {}),
        ...(autoProbe ? { autoProbe } : {}),
    };
}
export type ModeAutonomousKnob = "skipPullRequest" | "autoResolvePrConflicts" | "autoMergeRequestPr" | "autoMergeBooksSync" | "autoVerifyBooks" | "autoVerifyDone" | "securityReview" | "docsPhase" | "evidencePhase" | "erAutoApprove" | "diagramAutoApprove" | "autoApprove";
export type ModeKnob = ModeAutonomousKnob | "outboundReview.enabled";
export const MODE_KNOBS: readonly ModeKnob[] = [
    "skipPullRequest",
    "autoResolvePrConflicts",
    "autoMergeRequestPr",
    "autoMergeBooksSync",
    "outboundReview.enabled",
    "autoVerifyBooks",
    "autoVerifyDone",
    "securityReview",
    "docsPhase",
    "evidencePhase",
    "erAutoApprove",
    "diagramAutoApprove",
    "autoApprove",
];
export function presetKnobs(modes: Pick<ProjectModes, "delivery" | "rigor">): Partial<Record<ModeKnob, boolean>> {
    const auto = modes.delivery === "auto";
    const out: Partial<Record<ModeKnob, boolean>> = {
        skipPullRequest: auto,
        autoResolvePrConflicts: auto,
        autoMergeRequestPr: auto,
        autoMergeBooksSync: auto,
    };
    const full = modes.rigor === "full";
    const fast = modes.rigor === "fast";
    out["outboundReview.enabled"] = full;
    out.autoVerifyBooks = full;
    out.autoVerifyDone = full;
    out.securityReview = full;
    out.docsPhase = !fast;
    out.evidencePhase = !fast;
    out.autoApprove = fast;
    if (!fast) {
        out.erAutoApprove = !full;
        out.diagramAutoApprove = !full;
    }
    return out;
}
export function knobValues(settings: ProjectAutonomousSettings, outboundReviewEnabled: boolean): Record<ModeKnob, boolean> {
    const out = {} as Record<ModeKnob, boolean>;
    for (const k of MODE_KNOBS)
        out[k] = k === "outboundReview.enabled" ? outboundReviewEnabled : settings[k];
    return out;
}
export function customOf(modes: ProjectModes, knobs: Record<ModeKnob, boolean>): ModeKnob[] {
    const preset = presetKnobs(modes);
    return MODE_KNOBS.filter((k) => preset[k] !== undefined && preset[k] !== knobs[k]);
}
export function modesWarning(modes: Pick<ProjectModes, "delivery" | "rigor">): "none" | "yellow" | "red" {
    if (modes.rigor === "fast")
        return modes.delivery === "auto" ? "red" : "yellow";
    if (modes.rigor === "efficient" && modes.delivery === "auto")
        return "yellow";
    return "none";
}
export interface ProjectModesResponse {
    modes: ProjectModes;
    knobs: Record<ModeKnob, boolean>;
    custom: ModeKnob[];
}
