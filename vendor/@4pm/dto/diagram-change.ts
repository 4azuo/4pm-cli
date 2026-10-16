/**
 * System-diagram change requests (`SDC-<n>`) — the pure half: the `sd-meta` JSON + draw.io XML delta file
 * format, the effective per-cell patch of an SDC against the master it was written on (content and geometry as
 * two fields), the three-way conflict check, applying a patch to the module files (new cells placed when they
 * carry no geometry, removals cascading to attached edges / children), the change table, a web edit turned into
 * a delta, and the `.autonomous.diagram.json` sidecar shapes.
 * @adr 0530 @arch 0057
 */
import { z } from "zod";
import { ERC_STATES, type ErChangeRecord, type ErcState } from "./er-change";
import {
  DIAGRAM_DEFAULT_PAGE,
  DIAGRAM_MODULE_RE,
  cellContentKey,
  cellGeometryKey,
  cellStyleOf,
  cloneDiagramCell,
  composeCell,
  defaultStructural,
  diagramMasterOf,
  emptyDiagramModule,
  firstLayerOf,
  geometryBox,
  geometryOf,
  innerMxCell,
  parseDiagramModule,
  setCellStyle,
  type DiagramCell,
  type DiagramMaster,
  type DiagramModule,
  type DiagramParseError,
} from "./diagram-model";
import { parseXml, serializeXml, setXmlAttr, xmlAttr, xmlChildren, type XmlElement } from "./xml-lite";

/** Where an SDC comes from. */
export const SDC_SOURCES = ["intake", "implement", "web", "draft"] as const;
export type SdcSource = (typeof SDC_SOURCES)[number];

/** The `sd-meta` block of an SDC file. */
export const sdcMetaSchema = z.object({
  title: z.string().min(1).max(200),
  source: z.enum(SDC_SOURCES),
  req: z.array(z.string().max(64)).max(50).default([]),
  /** The task-id group it belongs to (`TSK-<gggg>`) — "" when none. */
  group: z.string().max(64).default(""),
  task: z.string().max(64).optional(),
  team: z.string().max(32).optional(),
  /** The module new cells go to (when the XML does not name one). */
  module: z.string().regex(DIAGRAM_MODULE_RE),
  /** The page new cells go to ("" = the module's first page). */
  page: z.string().max(100).default(""),
  /** The diagram version the delta was written against (filled by the cli). */
  baseVersion: z.number().int().min(0).optional(),
  /** `{cellId: version}` of every existing cell it touches (filled by the cli). */
  base: z.record(z.string(), z.number().int().min(0)).default({}),
  remove: z.object({ cells: z.array(z.string().max(200)).default([]) }).default({ cells: [] }),
  depends: z.array(z.string()).optional(),
});
export type SdcMeta = z.infer<typeof sdcMetaSchema>;

/** One cell of a delta with the module it is meant for (absent ⇒ `meta.module`). */
export interface SdcCell {
  cell: DiagramCell;
  module?: string;
}

/** A parsed SDC file. */
export interface SdcDoc {
  id: string | null;
  meta: SdcMeta;
  cells: SdcCell[];
  rationale: string;
}

/** The text of the first fenced block whose info string starts with `lang`, with its line range. */
function fencedBlock(lines: string[], from: number, test: (info: string) => boolean): { start: number; end: number; text: string } | null {
  for (let i = from; i < lines.length; i++) {
    const m = /^\s*```+\s*(.*)$/.exec(lines[i]!);
    if (!m) continue;
    let j = i + 1;
    while (j < lines.length && !/^\s*```+\s*$/.test(lines[j]!)) j++;
    if (test(m[1]!.trim())) return { start: i, end: j, text: lines.slice(i + 1, j).join("\n") };
    i = j;
  }
  return null;
}

/** Read the delta XML: `<mxGraphModel>` (all cells → meta location) or `<mxfile>` with `<diagram name="module/page">`. */
function parseDeltaXml(xml: string, meta: SdcMeta): { cells: SdcCell[]; errors: DiagramParseError[] } {
  let doc: XmlElement;
  try {
    doc = parseXml(xml);
  } catch (err) {
    return { cells: [], errors: [{ message: `invalid delta XML: ${err instanceof Error ? err.message : String(err)}` }] };
  }
  const sections: { module?: string; page: string; xml: string }[] = [];
  if (doc.name === "mxfile") {
    for (const d of xmlChildren(doc, "diagram")) {
      const name = xmlAttr(d, "name") ?? "";
      const slash = name.indexOf("/");
      const module = slash > 0 ? name.slice(0, slash) : undefined;
      const page = slash > 0 ? name.slice(slash + 1) : name;
      const model = xmlChildren(d, "mxGraphModel")[0];
      if (model) sections.push({ ...(module ? { module } : {}), page: page || meta.page, xml: serializeXml(model) });
    }
  } else if (doc.name === "mxGraphModel") sections.push({ page: meta.page, xml });
  else return { cells: [], errors: [{ message: `delta must be <mxGraphModel> or <mxfile>, got <${doc.name}>` }] };
  const cells: SdcCell[] = [];
  const errors: DiagramParseError[] = [];
  for (const s of sections) {
    if (s.module && !DIAGRAM_MODULE_RE.test(s.module)) {
      errors.push({ message: `invalid module "${s.module}"` });
      continue;
    }
    const parsed = parseDiagramModule(s.xml);
    errors.push(...parsed.errors);
    for (const c of parsed.module.cells) cells.push({ cell: { ...c, page: s.page }, ...(s.module ? { module: s.module } : {}) });
  }
  return { cells, errors };
}

/** Parse an SDC file; `doc` is null when the meta block is missing / invalid or the XML has errors. */
export function parseSdcFile(md: string): { doc: SdcDoc | null; errors: DiagramParseError[] } {
  const lines = md.split(/\r?\n/);
  const id = /^#\s+(SDC-[1-9]\d{0,5})\b/.exec(lines.find((l) => l.startsWith("#")) ?? "")?.[1] ?? null;
  const metaBlock = fencedBlock(lines, 0, (info) => /^json\s+sd-meta\b/.test(info));
  if (!metaBlock) return { doc: null, errors: [{ message: "missing ```json sd-meta block" }] };
  let raw: unknown;
  try {
    raw = JSON.parse(metaBlock.text);
  } catch {
    return { doc: null, errors: [{ message: "sd-meta is not valid JSON" }] };
  }
  const meta = sdcMetaSchema.safeParse(raw);
  if (!meta.success) return { doc: null, errors: [{ message: `sd-meta: ${meta.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}` }] };
  const xmlBlock = fencedBlock(lines, metaBlock.end + 1, (info) => /^xml\b/.test(info));
  const delta = xmlBlock ? parseDeltaXml(xmlBlock.text, meta.data) : { cells: [], errors: [] };
  if (delta.errors.length) return { doc: null, errors: delta.errors };
  const rationale = lines.slice((xmlBlock ?? metaBlock).end + 1).join("\n").trim();
  return { doc: { id, meta: meta.data, cells: delta.cells, rationale }, errors: [] };
}

/** The delta XML of a list of cells — `<mxGraphModel>` when they all go to the meta location, else `<mxfile>` sections. */
export function serializeDeltaXml(meta: Pick<SdcMeta, "module" | "page">, cells: readonly SdcCell[]): string {
  const where = (c: SdcCell): string => `${c.module ?? meta.module}/${c.cell.page || meta.page}`;
  const home = `${meta.module}/${meta.page}`;
  const model = (list: readonly SdcCell[]): XmlElement => ({ name: "mxGraphModel", attrs: [], children: [{ name: "root", attrs: [], children: list.map((c) => c.cell.el) }] });
  if (cells.every((c) => where(c) === home)) return serializeXml(model(cells), 2);
  const groups = new Map<string, SdcCell[]>();
  for (const c of cells) groups.set(where(c), [...(groups.get(where(c)) ?? []), c]);
  return serializeXml({ name: "mxfile", attrs: [], children: [...groups.entries()].map(([name, list]) => ({ name: "diagram", attrs: [["name", name]], children: [model(list)] })) }, 2);
}

/** Render an SDC file (heading, sd-meta, delta XML, rationale). */
export function serializeSdcFile(id: string, doc: Pick<SdcDoc, "meta" | "cells" | "rationale">): string {
  const meta = JSON.stringify(doc.meta, null, 2);
  const xml = doc.cells.length ? `\n\`\`\`xml\n${serializeDeltaXml(doc.meta, doc.cells)}\n\`\`\`\n` : "";
  return `# ${id} — ${doc.meta.title}\n\n\`\`\`json sd-meta\n${meta}\n\`\`\`\n${xml}\n${doc.rationale.trim()}\n`;
}

// ── Effective patch ─────────────────────────────────────────────────────────────────────────────────

/** What an SDC really changes against the master it was written on. */
export interface DiagramPatch {
  /** New cells, with the module they go to. */
  add: { cell: DiagramCell; module: string }[];
  /** Existing cells whose content and / or geometry change. */
  update: { cell: DiagramCell; content: boolean; geometry: boolean }[];
  /** Existing cells removed (attached edges and children go with them on apply). */
  remove: string[];
}

/** The effective patch of an SDC against `base` (the master it was written on): no-op cells dropped. */
export function sdcPatch(base: Pick<DiagramMaster, "byId">, doc: Pick<SdcDoc, "meta" | "cells">): DiagramPatch {
  const patch: DiagramPatch = { add: [], update: [], remove: [] };
  const removed = new Set(doc.meta.remove.cells);
  for (const { cell, module } of doc.cells) {
    if (removed.has(cell.id)) continue;
    const cur = base.byId.get(cell.id);
    if (!cur) {
      patch.add.push({ cell, module: module ?? doc.meta.module });
      continue;
    }
    const content = cellContentKey(cell) !== cellContentKey(cur);
    const geometry = Boolean(geometryOf(cell)) && cellGeometryKey(cell) !== cellGeometryKey(cur);
    if (content || geometry) patch.update.push({ cell, content, geometry });
  }
  patch.remove = [...removed].filter((id) => base.byId.has(id));
  return patch;
}

/** Every cell id a patch touches. */
export function diagramPatchCells(p: DiagramPatch): string[] {
  return [...new Set([...p.add.map((a) => a.cell.id), ...p.update.map((u) => u.cell.id), ...p.remove])];
}

/** True when the patch changes nothing. */
export function diagramPatchIsEmpty(p: DiagramPatch): boolean {
  return diagramPatchCells(p).length === 0;
}

/** One conflicting cell field. */
export interface DiagramConflict {
  cell: string;
  field: "content" | "geometry" | "cell" | "link";
}

/**
 * The cell fields of `patch` (written on `base`) that someone else also changed in `current` (three-way): the
 * same field of a cell changed to another value, a cell this patch changes that is gone (or one it removes that
 * was changed), a cell added under an id that now exists differently, a link of this patch whose end is gone, or
 * a cell added since `base` that hangs on a cell this patch removes. Empty ⇒ it merges.
 */
export function diagramConflicts(base: Pick<DiagramMaster, "byId">, current: Pick<DiagramMaster, "byId" | "cells" | "structural">, patch: DiagramPatch): DiagramConflict[] {
  const out: DiagramConflict[] = [];
  for (const { cell } of patch.add) {
    const now = current.byId.get(cell.id);
    if (now && (cellContentKey(now) !== cellContentKey(cell) || (geometryOf(cell) && cellGeometryKey(now) !== cellGeometryKey(cell)))) out.push({ cell: cell.id, field: "cell" });
  }
  for (const u of patch.update) {
    const was = base.byId.get(u.cell.id);
    const now = current.byId.get(u.cell.id);
    if (!now) {
      out.push({ cell: u.cell.id, field: "cell" });
      continue;
    }
    if (u.content && was && cellContentKey(was) !== cellContentKey(now) && cellContentKey(now) !== cellContentKey(u.cell)) out.push({ cell: u.cell.id, field: "content" });
    if (u.geometry && was && cellGeometryKey(was) !== cellGeometryKey(now) && cellGeometryKey(now) !== cellGeometryKey(u.cell)) out.push({ cell: u.cell.id, field: "geometry" });
  }
  const removed = new Set(patch.remove);
  for (const id of patch.remove) {
    const was = base.byId.get(id);
    const now = current.byId.get(id);
    if (now && was && (cellContentKey(was) !== cellContentKey(now) || cellGeometryKey(was) !== cellGeometryKey(now))) out.push({ cell: id, field: "cell" });
  }
  // Links of this patch must keep both ends.
  const added = new Set(patch.add.map((a) => a.cell.id));
  const exists = (id: string | undefined): boolean => !id || ((current.byId.has(id) || added.has(id)) && !removed.has(id));
  for (const c of [...patch.add.map((a) => a.cell), ...patch.update.map((u) => u.cell)]) {
    if (c.type === "edge" && (!exists(c.source) || !exists(c.target))) out.push({ cell: c.id, field: "link" });
  }
  // Cells others added since `base` that hang on a cell this patch removes.
  for (const c of current.cells) {
    if (base.byId.has(c.id) || removed.has(c.id)) continue;
    if ([c.source, c.target, c.parent].some((x) => x && removed.has(x))) out.push({ cell: c.id, field: "link" });
  }
  return out;
}

// ── Apply ───────────────────────────────────────────────────────────────────────────────────────────

/** The default size of a new vertex by kind. */
function defaultSize(c: DiagramCell): { w: number; h: number } {
  if (c.ref) return { w: 120, h: 40 };
  if (c.kind === "actor") return { w: 30, h: 60 };
  if (c.kind === "store") return { w: 120, h: 80 };
  if (c.kind === "group") return { w: 320, h: 200 };
  return { w: 160, h: 60 };
}

/** The default draw.io style of a new cell by kind. */
export function defaultDiagramStyle(c: Pick<DiagramCell, "type" | "kind" | "ref">): string {
  if (c.type === "edge") return c.kind === "event" ? "endArrow=classic;html=1;dashed=1;" : "endArrow=classic;html=1;";
  if (c.ref) return "rounded=1;whiteSpace=wrap;html=1;dashed=1;fillColor=#f5f5f5;fontColor=#666666;";
  switch (c.kind) {
    case "store":
      return "shape=cylinder3;whiteSpace=wrap;html=1;boundedLbl=1;size=12;";
    case "queue":
      return "shape=process;whiteSpace=wrap;html=1;";
    case "external":
      return "rounded=1;whiteSpace=wrap;html=1;dashed=1;";
    case "actor":
      return "shape=umlActor;verticalLabelPosition=bottom;verticalAlign=top;html=1;";
    case "group":
      return "swimlane;whiteSpace=wrap;html=1;";
    case "app":
      return "rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;";
    default:
      return "rounded=1;whiteSpace=wrap;html=1;";
  }
}

/** Give a cell element a geometry child. */
function setGeometry(c: DiagramCell, g: XmlElement): void {
  const mx = innerMxCell(c.el);
  if (!mx) return;
  mx.children = mx.children.filter((x) => typeof x === "string" || x.name !== "mxGeometry");
  mx.children.push(g);
}

/** Do two boxes overlap (with a margin)? */
function overlaps(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }, m = 20): boolean {
  return a.x < b.x + b.w + m && b.x < a.x + a.w + m && a.y < b.y + b.h + m && b.y < a.y + a.h + m;
}

/**
 * Place a new vertex without geometry on its page: below its first linked neighbour that has a box, else in a
 * new column right of the page's cells; moved down until it overlaps nothing.
 */
function placeVertex(c: DiagramCell, pageCells: DiagramCell[], links: DiagramCell[]): void {
  const { w, h } = defaultSize(c);
  const boxes = pageCells.filter((x) => x.type === "vertex" && x.id !== c.id && x.parent === c.parent).map((x) => ({ id: x.id, box: geometryBox(geometryOf(x)) })).filter((x) => x.box) as { id: string; box: { x: number; y: number; w: number; h: number } }[];
  const nb = links.map((e) => (e.source === c.id ? e.target : e.target === c.id ? e.source : undefined)).map((id) => boxes.find((b) => b.id === id)).find(Boolean);
  const box = nb
    ? { x: nb.box.x, y: nb.box.y + nb.box.h + 60, w, h }
    : { x: boxes.length ? Math.max(...boxes.map((b) => b.box.x + b.box.w)) + 80 : 40, y: boxes.length ? Math.min(...boxes.map((b) => b.box.y)) : 40, w, h };
  for (let guard = 0; guard < 500 && boxes.some((b) => overlaps(box, b.box)); guard++) box.y += h + 40;
  setGeometry(c, { name: "mxGeometry", attrs: [["x", String(box.x)], ["y", String(box.y)], ["width", String(w)], ["height", String(h)], ["as", "geometry"]], children: [] });
}

/** Copy modules deeply enough to edit their cell lists and pages. */
function copyModules(modules: Record<string, DiagramModule>): Record<string, DiagramModule> {
  return Object.fromEntries(Object.entries(modules).map(([m, mod]) => [m, { fileAttrs: mod.fileAttrs, pages: mod.pages.map((p) => ({ ...p })), cells: [...mod.cells] }]));
}

/**
 * Apply a patch to the module models (copies — the input is not mutated): removals cascade to the edges and
 * children of a removed cell; an update keeps the cell's module / page and takes content and geometry from the
 * patch only for the fields it changes; a new cell goes to its module / page (both created when absent), its
 * parent defaults to the page's first layer, and a vertex without geometry is placed. Returns the new modules,
 * the modules whose content changed and every cell the apply removed (cascade included).
 */
export function applyDiagramPatch(
  modules: Record<string, DiagramModule>,
  patch: DiagramPatch,
  fallback: { module: string; page: string },
): { modules: Record<string, DiagramModule>; changed: string[]; removed: string[] } {
  const next = copyModules(modules);
  const changed = new Set<string>();
  // Removals (with cascade).
  const gone = new Set(patch.remove);
  for (let grew = true; grew; ) {
    grew = false;
    for (const mod of Object.values(next)) {
      for (const c of mod.cells) {
        if (gone.has(c.id)) continue;
        if ([c.source, c.target, c.parent].some((x) => x && gone.has(x))) {
          gone.add(c.id);
          grew = true;
        }
      }
    }
  }
  for (const [m, mod] of Object.entries(next)) {
    const before = mod.cells.length;
    mod.cells = mod.cells.filter((c) => !gone.has(c.id));
    if (mod.cells.length !== before) changed.add(m);
  }
  // Updates in place.
  const owner = diagramMasterOf(next).owner;
  for (const u of patch.update) {
    const o = owner[u.cell.id];
    if (!o) continue;
    const mod = next[o.module]!;
    const i = mod.cells.findIndex((c) => c.id === u.cell.id);
    if (i < 0) continue;
    const cur = mod.cells[i]!;
    mod.cells[i] = composeCell(u.content ? u.cell : cur, u.geometry ? u.cell : cur, cur.page);
    changed.add(o.module);
  }
  // Additions: vertices first so links find their neighbours.
  const adds = [...patch.add].sort((a, b) => (a.cell.type === b.cell.type ? 0 : a.cell.type === "vertex" ? -1 : 1));
  const links = [...Object.values(next).flatMap((m) => m.cells), ...adds.map((a) => a.cell)].filter((c) => c.type === "edge");
  for (const a of adds) {
    const m = a.module || fallback.module;
    const mod = (next[m] ??= emptyDiagramModule());
    const pageName = a.cell.page || fallback.page || mod.pages[0]?.name || DIAGRAM_DEFAULT_PAGE;
    let page = mod.pages.find((p) => p.name === pageName);
    if (!page) {
      page = { name: pageName, id: `page-${mod.pages.length + 1}`, modelAttrs: [], structural: defaultStructural() };
      mod.pages.push(page);
    }
    const cell = cloneDiagramCell(a.cell, pageName);
    const mx = innerMxCell(cell.el);
    const ids = new Set([...mod.cells.map((c) => c.id), ...page.structural.map((s) => xmlAttr(s, "id") ?? "")]);
    if (mx && !ids.has(cell.parent) && !adds.some((x) => x.cell.id === cell.parent)) setXmlAttr(mx, "parent", firstLayerOf(page));
    if (!cellStyleOf(cell.el)) setCellStyle(cell.el, defaultDiagramStyle(cell));
    const placed = diagramCellFromElementSafe(cell);
    if (!geometryOf(placed)) {
      if (placed.type === "edge") setGeometry(placed, { name: "mxGeometry", attrs: [["relative", "1"], ["as", "geometry"]], children: [] });
      else placeVertex(placed, mod.cells.filter((c) => c.page === pageName), links);
    }
    const i = mod.cells.findIndex((c) => c.id === placed.id);
    if (i >= 0) mod.cells[i] = placed;
    else mod.cells.push(placed);
    changed.add(m);
  }
  return { modules: next, changed: [...changed].sort(), removed: [...gone] };
}

/** Re-read a cell after its element was edited (parent / style), keeping it when the element no longer reads. */
function diagramCellFromElementSafe(c: DiagramCell): DiagramCell {
  const mx = innerMxCell(c.el);
  return { ...c, parent: (mx && xmlAttr(mx, "parent")) ?? c.parent };
}

// ── Change table ────────────────────────────────────────────────────────────────────────────────────

/** One row of the change table. */
export interface DiagramChange {
  id: string;
  kind: "added" | "changed" | "removed";
  type: "vertex" | "edge";
  label: string;
  /** For a change: which fields. */
  fields: ("content" | "geometry")[];
  module: string;
  page: string;
  before?: DiagramCell;
  after?: DiagramCell;
}

/** The change table of `patch` against `master` (removals list the named cells only). */
export function diagramChangesOf(master: Pick<DiagramMaster, "byId" | "owner">, patch: DiagramPatch, fallback: { module: string; page: string }): DiagramChange[] {
  const out: DiagramChange[] = [];
  for (const a of patch.add) out.push({ id: a.cell.id, kind: "added", type: a.cell.type, label: a.cell.label, fields: [], module: a.module || fallback.module, page: a.cell.page || fallback.page, after: a.cell });
  for (const u of patch.update) {
    const before = master.byId.get(u.cell.id);
    const o = master.owner[u.cell.id];
    out.push({
      id: u.cell.id,
      kind: "changed",
      type: u.cell.type,
      label: u.cell.label || before?.label || "",
      fields: [...(u.content ? (["content"] as const) : []), ...(u.geometry ? (["geometry"] as const) : [])],
      module: o?.module ?? fallback.module,
      page: o?.page ?? fallback.page,
      ...(before ? { before } : {}),
      after: u.cell,
    });
  }
  for (const id of patch.remove) {
    const before = master.byId.get(id);
    const o = master.owner[id];
    out.push({ id, kind: "removed", type: before?.type ?? "vertex", label: before?.label ?? "", fields: [], module: o?.module ?? "", page: o?.page ?? "", ...(before ? { before } : {}) });
  }
  return out;
}

// ── Web edit → delta ────────────────────────────────────────────────────────────────────────────────

/**
 * Turn edited module files into an SDC delta against the modules they started from: every added or changed cell
 * in full (with its module and page), and the removed cell ids. Cells used in two modules come back as
 * `duplicates`.
 */
export function diagramDeltaFromEdit(
  baseModules: Record<string, DiagramModule>,
  edited: Record<string, DiagramModule>,
): { cells: SdcCell[]; remove: string[]; duplicates: string[] } {
  const before = diagramMasterOf(baseModules);
  const after = diagramMasterOf({ ...baseModules, ...edited });
  const cells: SdcCell[] = [];
  for (const c of after.cells) {
    const was = before.byId.get(c.id);
    if (!was || cellContentKey(was) !== cellContentKey(c) || cellGeometryKey(was) !== cellGeometryKey(c)) cells.push({ cell: c, module: after.owner[c.id]!.module });
  }
  const remove = before.cells.filter((c) => !after.byId.has(c.id)).map((c) => c.id);
  return { cells, remove, duplicates: after.duplicates.map((d) => d[0]) };
}

// ── Sidecar ─────────────────────────────────────────────────────────────────────────────────────────

/** SDC lifecycle states — the ERC ones. */
export const SDC_STATES = ERC_STATES;
export type SdcState = ErcState;

/** The sidecar record of one SDC (same shape as an ERC record). */
export type DiagramChangeRecord = ErChangeRecord;

/** The `approvedBy` of an apply made by the project's auto-approve. */
export const AUTO_APPROVER = "auto";

/** One applied version. */
export interface DiagramHistoryEntry {
  version: number;
  sdc: string;
  appliedAt: string;
  /** userId, or `auto` (auto-approve). */
  approvedBy: string;
  approvedByLabel?: string;
  /** Cells the apply touched (cascade included). */
  cells: string[];
  commit?: string;
}

/** `.claude/.autonomous.diagram.json` — cli-owned. */
export interface DiagramSidecar {
  version: number;
  cells: Record<string, { v: number; module: string; page: string }>;
  history: DiagramHistoryEntry[];
  changes: Record<string, DiagramChangeRecord>;
}

/** Relative path of the diagram sidecar. */
export const DIAGRAM_SIDECAR_REL = ".claude/.autonomous.diagram.json";

/** An empty sidecar. */
export function emptyDiagramSidecar(): DiagramSidecar {
  return { version: 0, cells: {}, history: [], changes: {} };
}

/** Coerce parsed JSON into a sidecar (missing parts default). */
export function coerceDiagramSidecar(raw: unknown): DiagramSidecar {
  const o = (raw && typeof raw === "object" ? raw : {}) as Partial<DiagramSidecar>;
  return {
    version: typeof o.version === "number" && o.version >= 0 ? Math.floor(o.version) : 0,
    cells: o.cells && typeof o.cells === "object" ? o.cells : {},
    history: Array.isArray(o.history) ? o.history : [],
    changes: o.changes && typeof o.changes === "object" ? o.changes : {},
  };
}

/** A cell's version as of diagram version `at` (the applies that touched it up to then). */
export function diagramCellVersionAt(sidecar: DiagramSidecar, cell: string, at: number): number {
  return sidecar.history.filter((h) => h.version <= at && h.cells.includes(cell)).length;
}

/** Parse every module text of a record; the first problem is returned with its module. */
export function parseDiagramModules(texts: Record<string, string>): { modules: Record<string, DiagramModule>; error?: { module: string; message: string } } {
  const modules: Record<string, DiagramModule> = {};
  for (const [name, text] of Object.entries(texts)) {
    const { module, errors } = parseDiagramModule(text);
    if (errors.length) return { modules, error: { module: name, message: errors[0]!.message } };
    modules[name] = module;
  }
  return { modules };
}
