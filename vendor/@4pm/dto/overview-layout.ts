/**
 * Vendored from @4pm/dto (overview-layout.ts) by scripts/vendor-shared.mjs — do not edit.
 */
import { z } from "zod";
export const OVERVIEW_WIDGETS = ["hero", "account", "orgOverview", "focusProject", "recentProjects", "pinned", "communityNews"] as const;
export type OverviewWidgetId = (typeof OVERVIEW_WIDGETS)[number];
const DEFAULT_HIDDEN: ReadonlySet<OverviewWidgetId> = new Set(["focusProject"]);
export interface OverviewWidgetEntry {
    id: OverviewWidgetId;
    visible: boolean;
}
export interface OrgOverviewSettings {
    widgets?: OverviewWidgetEntry[];
    locked?: OverviewWidgetId[];
}
export interface UserOverviewSettings {
    widgets?: OverviewWidgetEntry[];
    focusProjectId?: string;
}
export interface ResolvedOverviewLayout {
    widgets: OverviewWidgetEntry[];
    locked: OverviewWidgetId[];
    focusProjectId?: string;
}
const widgetEntry = z.object({ id: z.enum(OVERVIEW_WIDGETS), visible: z.boolean() });
export const overviewUpdateSchema = z
    .object({
    widgets: z.array(widgetEntry).max(OVERVIEW_WIDGETS.length * 2).nullable().optional(),
    focusProjectId: z.string().uuid().nullable().optional(),
})
    .refine((b) => b.widgets !== undefined || b.focusProjectId !== undefined, { message: "nothing to update" });
export type OverviewUpdate = z.infer<typeof overviewUpdateSchema>;
export const orgOverviewSettingsSchema = z.object({
    widgets: z.array(widgetEntry).max(OVERVIEW_WIDGETS.length * 2).optional(),
    locked: z.array(z.enum(OVERVIEW_WIDGETS)).max(OVERVIEW_WIDGETS.length).optional(),
});
export function defaultOverviewWidgets(): OverviewWidgetEntry[] {
    return OVERVIEW_WIDGETS.map((id) => ({ id, visible: !DEFAULT_HIDDEN.has(id) }));
}
export function cleanOverviewWidgets(raw: unknown): OverviewWidgetEntry[] | undefined {
    if (!Array.isArray(raw))
        return undefined;
    const seen = new Set<string>();
    const out: OverviewWidgetEntry[] = [];
    for (const e of raw) {
        const id = (e as {
            id?: unknown;
        })?.id;
        if (typeof id !== "string" || !OVERVIEW_WIDGETS.includes(id as OverviewWidgetId) || seen.has(id))
            continue;
        seen.add(id);
        out.push({ id: id as OverviewWidgetId, visible: (e as {
                visible?: unknown;
            }).visible !== false });
    }
    return out;
}
export function readOrgOverview(raw: unknown): OrgOverviewSettings {
    const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const locked = Array.isArray(o.locked) ? [...new Set(o.locked.filter((x): x is OverviewWidgetId => OVERVIEW_WIDGETS.includes(x as OverviewWidgetId)))] : [];
    return { widgets: cleanOverviewWidgets(o.widgets), locked };
}
export function readUserOverview(raw: unknown): UserOverviewSettings {
    const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const out: UserOverviewSettings = {};
    const widgets = cleanOverviewWidgets(o.widgets);
    if (widgets)
        out.widgets = widgets;
    if (typeof o.focusProjectId === "string" && o.focusProjectId)
        out.focusProjectId = o.focusProjectId;
    return out;
}
export function resolveOverviewLayout(user: UserOverviewSettings, org: OrgOverviewSettings): ResolvedOverviewLayout {
    const orgBase = org.widgets?.length ? org.widgets : defaultOverviewWidgets();
    const orgFull = [...orgBase, ...defaultOverviewWidgets().filter((d) => !orgBase.some((w) => w.id === d.id))];
    const chosen = user.widgets?.length ? user.widgets : orgFull;
    const merged = [...chosen, ...orgFull.filter((w) => !chosen.some((c) => c.id === w.id))];
    const locked = org.locked ?? [];
    return {
        widgets: merged.map((w) => (locked.includes(w.id) ? { ...w, visible: true } : { ...w })),
        locked: [...locked],
        ...(user.focusProjectId ? { focusProjectId: user.focusProjectId } : {}),
    };
}
export function singleProjectOverview(org: OrgOverviewSettings): OverviewWidgetEntry[] {
    const base = resolveOverviewLayout({}, org).widgets.filter((w) => w.id !== "focusProject");
    return [{ id: "focusProject", visible: true }, ...base];
}
