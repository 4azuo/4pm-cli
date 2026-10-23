/**
 * The Home Overview as an ordered list of widgets: the built-in catalog, the two stored layers (org default + locks,
 * user layout) and the pure resolution both the server and the web use.
 * @adr 0610 @api user-0033 @page 0008
 */
import { z } from "zod";

/** Every Overview widget, in its built-in default order. */
export const OVERVIEW_WIDGETS = ["hero", "account", "orgOverview", "focusProject", "recentProjects", "pinned", "communityNews"] as const;
export type OverviewWidgetId = (typeof OVERVIEW_WIDGETS)[number];

/** Widgets hidden until someone turns them on (the rest start visible). */
const DEFAULT_HIDDEN: ReadonlySet<OverviewWidgetId> = new Set(["focusProject"]);

/** One entry of a stored layout. */
export interface OverviewWidgetEntry {
  id: OverviewWidgetId;
  visible: boolean;
}

/** `organization.settings.overview` — the org default + the widgets members cannot hide. */
export interface OrgOverviewSettings {
  widgets?: OverviewWidgetEntry[];
  locked?: OverviewWidgetId[];
}

/** `users.settings.overview` — the caller's own layout + the project the Focus widget shows. */
export interface UserOverviewSettings {
  widgets?: OverviewWidgetEntry[];
  focusProjectId?: string;
}

/** The resolved layout returned on GET /users/me. */
export interface ResolvedOverviewLayout {
  widgets: OverviewWidgetEntry[];
  locked: OverviewWidgetId[];
  focusProjectId?: string;
}

const widgetEntry = z.object({ id: z.enum(OVERVIEW_WIDGETS), visible: z.boolean() });

/** Body of PUT /users/me/overview (`widgets: null` resets to the org default). */
export const overviewUpdateSchema = z
  .object({
    widgets: z.array(widgetEntry).max(OVERVIEW_WIDGETS.length * 2).nullable().optional(),
    focusProjectId: z.string().uuid().nullable().optional(),
  })
  .refine((b) => b.widgets !== undefined || b.focusProjectId !== undefined, { message: "nothing to update" });
export type OverviewUpdate = z.infer<typeof overviewUpdateSchema>;

/** The `settings.overview` namespace of PATCH /organizations/me. @api org-0002 */
export const orgOverviewSettingsSchema = z.object({
  widgets: z.array(widgetEntry).max(OVERVIEW_WIDGETS.length * 2).optional(),
  locked: z.array(z.enum(OVERVIEW_WIDGETS)).max(OVERVIEW_WIDGETS.length).optional(),
});

/** The built-in layout. */
export function defaultOverviewWidgets(): OverviewWidgetEntry[] {
  return OVERVIEW_WIDGETS.map((id) => ({ id, visible: !DEFAULT_HIDDEN.has(id) }));
}

/** Keep known ids once each, in order (drops unknown / repeated entries of a stored layout). */
export function cleanOverviewWidgets(raw: unknown): OverviewWidgetEntry[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const seen = new Set<string>();
  const out: OverviewWidgetEntry[] = [];
  for (const e of raw) {
    const id = (e as { id?: unknown })?.id;
    if (typeof id !== "string" || !OVERVIEW_WIDGETS.includes(id as OverviewWidgetId) || seen.has(id)) continue;
    seen.add(id);
    out.push({ id: id as OverviewWidgetId, visible: (e as { visible?: unknown }).visible !== false });
  }
  return out;
}

/** Read stored org overview settings (invalid parts dropped). */
export function readOrgOverview(raw: unknown): OrgOverviewSettings {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const locked = Array.isArray(o.locked) ? [...new Set(o.locked.filter((x): x is OverviewWidgetId => OVERVIEW_WIDGETS.includes(x as OverviewWidgetId)))] : [];
  return { widgets: cleanOverviewWidgets(o.widgets), locked };
}

/** Read stored user overview settings. */
export function readUserOverview(raw: unknown): UserOverviewSettings {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out: UserOverviewSettings = {};
  const widgets = cleanOverviewWidgets(o.widgets);
  if (widgets) out.widgets = widgets;
  if (typeof o.focusProjectId === "string" && o.focusProjectId) out.focusProjectId = o.focusProjectId;
  return out;
}

/**
 * Resolve the layout to render: the user layout, else the org default, else the built-in; widgets missing from it are
 * appended in org-default order (visibility from the org default); locked widgets are forced visible.
 */
export function resolveOverviewLayout(user: UserOverviewSettings, org: OrgOverviewSettings): ResolvedOverviewLayout {
  const orgBase = org.widgets?.length ? org.widgets : defaultOverviewWidgets();
  // The org default also lists the built-in widgets it does not mention (new widgets keep appearing).
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

/** The layout a user gets when they answer "one project": the org layout with Focus project first and visible. */
export function singleProjectOverview(org: OrgOverviewSettings): OverviewWidgetEntry[] {
  const base = resolveOverviewLayout({}, org).widgets.filter((w) => w.id !== "focusProject");
  return [{ id: "focusProject", visible: true }, ...base];
}
