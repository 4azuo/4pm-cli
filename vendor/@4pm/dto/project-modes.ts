/**
 * Project modes — three independent presets (Delivery × Rigor × Collaboration) stored in `projects.settings.modes`.
 * A mode writes the knobs it governs (project autonomous settings + `outboundReview.enabled`); the engine reads only
 * the knobs. `customOf` lists the knobs edited away from the presets, shown as *Custom*.
 * @adr 0608 @arch 0065
 */
import { z } from "zod";
import type { ProjectAutonomousSettings } from "./autonomous-policy";

export const DELIVERY_MODES = ["auto", "manual"] as const;
export const RIGOR_MODES = ["full", "efficient", "fast"] as const;
export const COLLABORATION_MODES = ["team", "personal"] as const;

export type DeliveryMode = (typeof DELIVERY_MODES)[number];
export type RigorMode = (typeof RIGOR_MODES)[number];
export type CollaborationMode = (typeof COLLABORATION_MODES)[number];

/** The three modes of a project. */
export interface ProjectModes {
  delivery: DeliveryMode;
  rigor: RigorMode;
  collaboration: CollaborationMode;
  /** Auto was chosen on create; the merge-rights probe runs once the primary repo is cloned. */
  pendingAuto?: boolean;
  /** The outcome of that probe, shown once as a banner on the project page. @adr 0616 */
  autoProbe?: { ok: boolean; reason?: string; at: string };
}

/** Defaults: Manual · Power efficiency · Team. */
export const DEFAULT_PROJECT_MODES: ProjectModes = { delivery: "manual", rigor: "efficient", collaboration: "team" };

/** The zod shape of a modes body (create + project-0135). */
export const projectModesSchema = z
  .object({
    delivery: z.enum(DELIVERY_MODES),
    rigor: z.enum(RIGOR_MODES),
    collaboration: z.enum(COLLABORATION_MODES),
  })
  .strict();

/** Body PUT /projects/:id/modes. @api project-0135 */
export const projectModesWriteSchema = z.object({ modes: projectModesSchema }).strict();
export type ProjectModesWriteBody = z.infer<typeof projectModesWriteSchema>;

/** Read the stored modes (missing / invalid ⇒ defaults). */
export function readProjectModes(raw: unknown): ProjectModes {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const p = (o.autoProbe && typeof o.autoProbe === "object" ? o.autoProbe : null) as Record<string, unknown> | null;
  const autoProbe =
    p && typeof p.ok === "boolean" && typeof p.at === "string"
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

/** The boolean autonomous knobs a mode governs. */
export type ModeAutonomousKnob =
  | "skipPullRequest"
  | "autoResolvePrConflicts"
  | "autoMergeRequestPr"
  | "autoMergeBooksSync"
  | "autoVerifyBooks"
  | "autoVerifyDone"
  | "securityReview"
  | "docsPhase"
  | "evidencePhase"
  | "erAutoApprove"
  | "diagramAutoApprove"
  | "autoApprove";

/** Every knob a mode governs (`outboundReview.enabled` lives in the outbound-review settings). */
export type ModeKnob = ModeAutonomousKnob | "outboundReview.enabled";

/** Every governed knob, in display order. */
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

/** The knob values a set of modes writes (Collaboration writes none; Best performance leaves the ER / diagram knobs). */
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

/** The current value of every governed knob. */
export function knobValues(settings: ProjectAutonomousSettings, outboundReviewEnabled: boolean): Record<ModeKnob, boolean> {
  const out = {} as Record<ModeKnob, boolean>;
  for (const k of MODE_KNOBS) out[k] = k === "outboundReview.enabled" ? outboundReviewEnabled : settings[k];
  return out;
}

/** The knobs whose value differs from the presets of `modes` (empty = the modes hold exactly). */
export function customOf(modes: ProjectModes, knobs: Record<ModeKnob, boolean>): ModeKnob[] {
  const preset = presetKnobs(modes);
  return MODE_KNOBS.filter((k) => preset[k] !== undefined && preset[k] !== knobs[k]);
}

/** The warning level of a Rigor × Delivery pair: red = no review and auto-merge. */
export function modesWarning(modes: Pick<ProjectModes, "delivery" | "rigor">): "none" | "yellow" | "red" {
  if (modes.rigor === "fast") return modes.delivery === "auto" ? "red" : "yellow";
  if (modes.rigor === "efficient" && modes.delivery === "auto") return "yellow";
  return "none";
}

/** Data PUT /projects/:id/modes. @api project-0135 */
export interface ProjectModesResponse {
  modes: ProjectModes;
  knobs: Record<ModeKnob, boolean>;
  /** Knobs that differ from the presets. */
  custom: ModeKnob[];
}
