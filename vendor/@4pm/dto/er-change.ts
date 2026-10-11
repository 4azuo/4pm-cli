/**
 * ER change requests (`ERC-<n>`) — the pure half: the `er-meta` JSON + `erDiagram` delta file format, the
 * effective patch of an ERC against the model it was written on, the field-level three-way merge / conflict
 * check, applying a patch to the module models, the change table (added / changed / removed), a web edit
 * turned into a delta, and the `.autonomous.er.json` sidecar shapes. A delta entity block lists attributes to
 * add or change (by name) — attributes it does not list are untouched unless named in `remove.attributes`.
 * @adr 0453 @arch 0053
 */
import { z } from "zod";
import {
  ER_MODULE_RE,
  emptyErModel,
  erDiagramBlock,
  erMasterOf,
  erRelationKey,
  parseErDiagram,
  sameErAttribute,
  serializeErDiagram,
  type ErAttribute,
  type ErEntity,
  type ErModel,
  type ErParseError,
  type ErRelation,
} from "./er-model";

/** Where an ERC comes from. */
export const ERC_SOURCES = ["intake", "implement", "web"] as const;
export type ErcSource = (typeof ERC_SOURCES)[number];

/** The `er-meta` block of an ERC file. */
export const ercMetaSchema = z.object({
  title: z.string().min(1).max(200),
  source: z.enum(ERC_SOURCES),
  /** The `REQ-…` ids it comes from. */
  req: z.array(z.string().max(64)).max(50).default([]),
  /** The task-id group it belongs to (`TSK-<gggg>`, as in the mockup names) — "" when none. */
  group: z.string().max(64).default(""),
  /** The task an implement ERC comes from. */
  task: z.string().max(64).optional(),
  /** The team code of the source row (display / filter only — ADR-0450). */
  team: z.string().max(32).optional(),
  /** Owner module of the entities it adds. */
  module: z.string().regex(ER_MODULE_RE),
  /** The ER version the delta was written against (filled by the cli). */
  baseVersion: z.number().int().min(0).optional(),
  /** `{ENTITY: version}` of every existing entity it touches (filled by the cli). */
  base: z.record(z.string(), z.number().int().min(0)).default({}),
  remove: z
    .object({
      entities: z.array(z.string()).default([]),
      attributes: z.record(z.string(), z.array(z.string())).default({}),
      relations: z.array(z.tuple([z.string(), z.string(), z.string()])).default([]),
    })
    .default({ entities: [], attributes: {}, relations: [] }),
  /** Open ERCs this one builds on (intake guidance). */
  depends: z.array(z.string()).optional(),
});
export type ErcMeta = z.infer<typeof ercMetaSchema>;

/** A parsed ERC file. */
export interface ErcDoc {
  /** `ERC-<n>` from the `# ERC-<n> — title` heading, when present. */
  id: string | null;
  meta: ErcMeta;
  /** The new form of the entities / relationships it adds or changes. */
  delta: ErModel;
  rationale: string;
}

/** Parse an ERC file; `doc` is null when the meta block is missing / invalid or the diagram has errors. */
export function parseErcFile(md: string): { doc: ErcDoc | null; errors: ErParseError[] } {
  const lines = md.split(/\r?\n/);
  const id = /^#\s+(ERC-[1-9]\d{0,5})\b/.exec(lines.find((l) => l.startsWith("#")) ?? "")?.[1] ?? null;
  const metaStart = lines.findIndex((l) => /^\s*```+\s*json\s+er-meta\b/.test(l));
  if (metaStart < 0) return { doc: null, errors: [{ line: 1, message: "missing ```json er-meta block" }] };
  let metaEnd = metaStart + 1;
  while (metaEnd < lines.length && !/^\s*```+\s*$/.test(lines[metaEnd]!)) metaEnd++;
  let raw: unknown;
  try {
    raw = JSON.parse(lines.slice(metaStart + 1, metaEnd).join("\n"));
  } catch {
    return { doc: null, errors: [{ line: metaStart + 1, message: "er-meta is not valid JSON" }] };
  }
  const meta = ercMetaSchema.safeParse(raw);
  if (!meta.success) {
    return { doc: null, errors: [{ line: metaStart + 1, message: `er-meta: ${meta.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}` }] };
  }
  const rest = lines.slice(metaEnd + 1).join("\n");
  const block = erDiagramBlock(rest);
  const parsed = block ? parseErDiagram(rest) : { model: emptyErModel(), errors: [] };
  const errors = parsed.errors.map((e) => ({ ...e, line: e.line + metaEnd + 1 }));
  // The rationale = everything after the diagram block (or after the meta when there is none).
  let rationale = rest;
  if (block) {
    const after = rest.split(/\r?\n/);
    let end = block.offset + block.text.split(/\r?\n/).length;
    while (end < after.length && !/^\s*```+\s*$/.test(after[end]!)) end++;
    rationale = after.slice(end + 1).join("\n");
  }
  if (errors.length) return { doc: null, errors };
  return { doc: { id, meta: meta.data, delta: parsed.model, rationale: rationale.trim() }, errors: [] };
}

/** Render an ERC file (heading, er-meta, delta diagram, rationale). */
export function serializeErcFile(id: string, doc: Pick<ErcDoc, "meta" | "delta" | "rationale">): string {
  const meta = JSON.stringify(doc.meta, null, 2);
  const diagram = doc.delta.entities.length || doc.delta.relations.length ? `\n\`\`\`mermaid\n${serializeErDiagram(doc.delta)}\n\`\`\`\n` : "";
  return `# ${id} — ${doc.meta.title}\n\n\`\`\`json er-meta\n${meta}\n\`\`\`\n${diagram}\n${doc.rationale.trim()}\n`;
}

// ── Effective patch ─────────────────────────────────────────────────────────────────────────────────

/** What an ERC really changes against the model it was written on. */
export interface ErPatch {
  /** New entities (full). */
  addEntities: ErEntity[];
  /** Attributes added / changed on existing entities. */
  upsertAttrs: Record<string, ErAttribute[]>;
  /** Attributes removed from existing entities. */
  removeAttrs: Record<string, string[]>;
  removeEntities: string[];
  /** Relationships added or whose cardinality changes. */
  upsertRelations: ErRelation[];
  removeRelations: ErRelation[];
}

/** Index a model's entities by name. */
function entityMap(model: ErModel): Map<string, ErEntity> {
  return new Map(model.entities.map((e) => [e.name, e]));
}

/** Index a model's relationships by key. */
function relationMap(model: ErModel): Map<string, ErRelation> {
  return new Map(model.relations.map((r) => [erRelationKey(r), r]));
}

/** The effective patch of an ERC against `base` (the model it was written on): no-op fields dropped. */
export function ercPatch(base: ErModel, doc: Pick<ErcDoc, "meta" | "delta">): ErPatch {
  const ents = entityMap(base);
  const rels = relationMap(base);
  const patch: ErPatch = { addEntities: [], upsertAttrs: {}, removeAttrs: {}, removeEntities: [], upsertRelations: [], removeRelations: [] };
  const removed = new Set(doc.meta.remove.entities);
  for (const e of doc.delta.entities) {
    if (removed.has(e.name)) continue;
    const cur = ents.get(e.name);
    if (!cur) {
      patch.addEntities.push(e);
      continue;
    }
    const attrs = e.attributes.filter((a) => !sameErAttribute(a, cur.attributes.find((x) => x.name === a.name)));
    if (attrs.length) patch.upsertAttrs[e.name] = attrs;
  }
  for (const [name, list] of Object.entries(doc.meta.remove.attributes)) {
    const cur = ents.get(name);
    const gone = list.filter((a) => cur?.attributes.some((x) => x.name === a) && !(patch.upsertAttrs[name] ?? []).some((x) => x.name === a));
    if (gone.length) patch.removeAttrs[name] = gone;
  }
  patch.removeEntities = [...removed].filter((n) => ents.has(n));
  for (const r of doc.delta.relations) {
    const cur = rels.get(erRelationKey(r));
    if (!cur || cur.card !== r.card) patch.upsertRelations.push(r);
  }
  for (const [a, b, label] of doc.meta.remove.relations) {
    const cur = rels.get(erRelationKey({ a, b, label }));
    if (cur) patch.removeRelations.push(cur);
  }
  return patch;
}

/** Every entity a patch touches (changed / added / removed ones + relationship endpoints). */
export function erPatchEntities(p: ErPatch): string[] {
  return [
    ...new Set([
      ...p.addEntities.map((e) => e.name),
      ...Object.keys(p.upsertAttrs),
      ...Object.keys(p.removeAttrs),
      ...p.removeEntities,
      ...p.upsertRelations.flatMap((r) => [r.a, r.b]),
      ...p.removeRelations.flatMap((r) => [r.a, r.b]),
    ]),
  ];
}

/** True when the patch changes nothing. */
export function erPatchIsEmpty(p: ErPatch): boolean {
  return erPatchEntities(p).length === 0;
}

/** One conflicting field: an entity, an attribute of it, or a relationship. */
export interface ErConflict {
  entity: string;
  attribute?: string;
  relation?: string;
}

/**
 * The fields of `patch` (written on `base`) that someone else also changed in `current` (three-way):
 * the same attribute / relationship changed to a different value, an entity this patch changes that is gone
 * (or the reverse), or an entity added under a name that now exists differently. Empty ⇒ it merges.
 */
export function erConflicts(base: ErModel, current: ErModel, patch: ErPatch): ErConflict[] {
  const b = entityMap(base);
  const c = entityMap(current);
  const out: ErConflict[] = [];
  const attrOf = (m: Map<string, ErEntity>, e: string, a: string): ErAttribute | undefined => m.get(e)?.attributes.find((x) => x.name === a);
  for (const e of patch.addEntities) {
    const now = c.get(e.name);
    if (now && JSON.stringify(now.attributes) !== JSON.stringify(e.attributes)) out.push({ entity: e.name });
  }
  for (const [e, attrs] of Object.entries(patch.upsertAttrs)) {
    if (!c.has(e)) {
      out.push({ entity: e });
      continue;
    }
    for (const a of attrs) {
      const was = attrOf(b, e, a.name);
      const now = attrOf(c, e, a.name);
      if (!sameErAttribute(was, now) && !sameErAttribute(now, a)) out.push({ entity: e, attribute: a.name });
    }
  }
  for (const [e, names] of Object.entries(patch.removeAttrs)) {
    for (const n of names) {
      const now = attrOf(c, e, n);
      if (now && !sameErAttribute(attrOf(b, e, n), now)) out.push({ entity: e, attribute: n });
    }
  }
  for (const e of patch.removeEntities) {
    const was = b.get(e);
    const now = c.get(e);
    if (now && JSON.stringify(was?.attributes) !== JSON.stringify(now.attributes)) out.push({ entity: e });
  }
  const br = relationMap(base);
  const cr = relationMap(current);
  for (const r of patch.upsertRelations) {
    const k = erRelationKey(r);
    const was = br.get(k);
    const now = cr.get(k);
    if (was?.card !== now?.card && now?.card !== r.card) out.push({ entity: r.a, relation: k });
    if (!c.has(r.a) && !patch.addEntities.some((e) => e.name === r.a)) out.push({ entity: r.a, relation: k });
    if (!c.has(r.b) && !patch.addEntities.some((e) => e.name === r.b)) out.push({ entity: r.b, relation: k });
  }
  for (const r of patch.removeRelations) {
    const k = erRelationKey(r);
    const now = cr.get(k);
    if (now && now.card !== br.get(k)?.card) out.push({ entity: r.a, relation: k });
  }
  return out;
}

/**
 * Apply a patch to the module models (copies — the input is not mutated): new entities go to `module`
 * (created when absent), attribute changes to the owning module, a removed entity takes its relationships
 * with it, a new relationship goes to the owner module of its first entity. Returns the new modules and the
 * modules whose content changed.
 */
export function applyErPatch(
  modules: Record<string, ErModel>,
  patch: ErPatch,
  module: string,
): { modules: Record<string, ErModel>; changed: string[] } {
  const next: Record<string, ErModel> = Object.fromEntries(
    Object.entries(modules).map(([m, model]) => [m, { entities: model.entities.map((e) => ({ ...e, attributes: [...e.attributes] })), relations: [...model.relations] }]),
  );
  const changed = new Set<string>();
  const owner = erMasterOf(next).owner;
  const ensure = (m: string): ErModel => (next[m] ??= emptyErModel());
  for (const e of patch.addEntities) {
    const m = owner[e.name] ?? module;
    const target = ensure(m);
    const i = target.entities.findIndex((x) => x.name === e.name);
    if (i >= 0) target.entities[i] = { ...e, attributes: [...e.attributes] };
    else target.entities.push({ ...e, attributes: [...e.attributes] });
    owner[e.name] = m;
    changed.add(m);
  }
  for (const [name, attrs] of Object.entries(patch.upsertAttrs)) {
    const m = owner[name];
    const ent = m ? next[m]!.entities.find((e) => e.name === name) : undefined;
    if (!ent) continue;
    for (const a of attrs) {
      const i = ent.attributes.findIndex((x) => x.name === a.name);
      if (i >= 0) ent.attributes[i] = a;
      else ent.attributes.push(a);
    }
    changed.add(m!);
  }
  for (const [name, names] of Object.entries(patch.removeAttrs)) {
    const m = owner[name];
    const ent = m ? next[m]!.entities.find((e) => e.name === name) : undefined;
    if (!ent) continue;
    ent.attributes = ent.attributes.filter((a) => !names.includes(a.name));
    changed.add(m!);
  }
  const gone = new Set(patch.removeEntities);
  const dropRel = new Set(patch.removeRelations.map(erRelationKey));
  for (const [m, model] of Object.entries(next)) {
    const before = model.entities.length + model.relations.length;
    model.entities = model.entities.filter((e) => !gone.has(e.name));
    model.relations = model.relations.filter((r) => !gone.has(r.a) && !gone.has(r.b) && !dropRel.has(erRelationKey(r)));
    if (model.entities.length + model.relations.length !== before) changed.add(m);
  }
  for (const r of patch.upsertRelations) {
    const k = erRelationKey(r);
    const home = Object.entries(next).find(([, model]) => model.relations.some((x) => erRelationKey(x) === k))?.[0];
    const m = home ?? owner[r.a] ?? owner[r.b] ?? module;
    const target = ensure(m);
    const i = target.relations.findIndex((x) => erRelationKey(x) === k);
    if (i >= 0) target.relations[i] = r;
    else target.relations.push(r);
    changed.add(m);
  }
  return { modules: next, changed: [...changed].sort() };
}

// ── Change table ────────────────────────────────────────────────────────────────────────────────────

/** Kind of one change. */
export type ErChangeKind = "added" | "changed" | "removed";

/** One attribute change. */
export interface ErAttributeChange {
  name: string;
  kind: ErChangeKind;
  before?: ErAttribute;
  after?: ErAttribute;
}

/** One entity change with its attribute changes. */
export interface ErEntityChange {
  name: string;
  kind: ErChangeKind;
  attributes: ErAttributeChange[];
}

/** One relationship change. */
export interface ErRelationChange {
  key: string;
  kind: ErChangeKind;
  before?: ErRelation;
  after?: ErRelation;
}

/** What a patch does to a model, entity by entity. */
export interface ErChanges {
  entities: ErEntityChange[];
  relations: ErRelationChange[];
}

/** The change table of `patch` applied to `model`. */
export function erChangesOf(model: ErModel, patch: ErPatch): ErChanges {
  const ents = entityMap(model);
  const rels = relationMap(model);
  const entities: ErEntityChange[] = [];
  for (const e of patch.addEntities) {
    const was = ents.get(e.name);
    entities.push({
      name: e.name,
      kind: was ? "changed" : "added",
      attributes: e.attributes.map((a) => ({ name: a.name, kind: "added" as const, after: a })),
    });
  }
  const names = new Set([...Object.keys(patch.upsertAttrs), ...Object.keys(patch.removeAttrs)]);
  for (const name of names) {
    const cur = ents.get(name);
    const attrs: ErAttributeChange[] = [];
    for (const a of patch.upsertAttrs[name] ?? []) {
      const was = cur?.attributes.find((x) => x.name === a.name);
      attrs.push({ name: a.name, kind: was ? "changed" : "added", ...(was ? { before: was } : {}), after: a });
    }
    for (const n of patch.removeAttrs[name] ?? []) {
      const was = cur?.attributes.find((x) => x.name === n);
      attrs.push({ name: n, kind: "removed", ...(was ? { before: was } : {}) });
    }
    entities.push({ name, kind: "changed", attributes: attrs });
  }
  for (const name of patch.removeEntities) {
    entities.push({ name, kind: "removed", attributes: (ents.get(name)?.attributes ?? []).map((a) => ({ name: a.name, kind: "removed" as const, before: a })) });
  }
  const relations: ErRelationChange[] = [
    ...patch.upsertRelations.map((r) => {
      const was = rels.get(erRelationKey(r));
      return { key: erRelationKey(r), kind: (was ? "changed" : "added") as ErChangeKind, ...(was ? { before: was } : {}), after: r };
    }),
    ...patch.removeRelations.map((r) => ({ key: erRelationKey(r), kind: "removed" as const, before: r })),
  ];
  return { entities, relations };
}

// ── Web edit → delta ────────────────────────────────────────────────────────────────────────────────

/**
 * Turn edited module texts into an ERC delta against the model they started from (`base` modules): the
 * changed / added entities in their full new form, the removed attributes / entities / relationships, and
 * the new relationships. `owner` problems (an entity declared in two modules) come back as `duplicates`.
 */
export function erDeltaFromEdit(
  baseModules: Record<string, ErModel>,
  edited: Record<string, ErModel>,
): { delta: ErModel; remove: ErcMeta["remove"]; duplicates: string[] } {
  const before = erMasterOf(baseModules).model;
  const merged = erMasterOf({ ...baseModules, ...edited });
  const after = merged.model;
  const b = entityMap(before);
  const a = entityMap(after);
  const delta = emptyErModel();
  const remove: ErcMeta["remove"] = { entities: [], attributes: {}, relations: [] };
  for (const e of after.entities) {
    const was = b.get(e.name);
    if (!was || JSON.stringify(was.attributes) !== JSON.stringify(e.attributes)) delta.entities.push(e);
    if (was) {
      const lost = was.attributes.filter((x) => !e.attributes.some((y) => y.name === x.name)).map((x) => x.name);
      if (lost.length) remove.attributes[e.name] = lost;
    }
  }
  for (const e of before.entities) if (!a.has(e.name)) remove.entities.push(e.name);
  const br = relationMap(before);
  const ar = relationMap(after);
  for (const [k, r] of ar) if (br.get(k)?.card !== r.card) delta.relations.push(r);
  for (const [k, r] of br) if (!ar.has(k) && !remove.entities.includes(r.a) && !remove.entities.includes(r.b)) remove.relations.push([r.a, r.b, r.label]);
  return { delta, remove, duplicates: merged.duplicates.map((d) => d[0]) };
}

// ── Sidecar ─────────────────────────────────────────────────────────────────────────────────────────

/** ERC lifecycle states. */
export const ERC_STATES = ["pending", "applied", "rejected", "conflict", "withdrawn"] as const;
export type ErcState = (typeof ERC_STATES)[number];

/** An ERC that still blocks its group's tasks (everything but applied / withdrawn). */
export function ercBlocks(state: ErcState | undefined): boolean {
  return state === "pending" || state === "conflict" || state === "rejected";
}

/** The sidecar record of one ERC. */
export interface ErChangeRecord {
  state: ErcState;
  /** Reject reason / conflict summary. */
  reason?: string;
  /** The applied ERCs it conflicted with. */
  conflictsWith?: string[];
  /** The ER version its apply produced. */
  appliedVersion?: number;
  /** Last state change (ISO) + who made it (userId; absent for the cli). */
  at?: string;
  by?: string;
  byLabel?: string;
}

/** One applied version. */
export interface ErHistoryEntry {
  version: number;
  erc: string;
  appliedAt: string;
  approvedBy: string;
  approvedByLabel?: string;
  /** Entities the apply touched (to name the ERCs a later conflict is with). */
  entities: string[];
  /** The commit holding this version — resolved when read (the commit cannot name itself). */
  commit?: string;
}

/** `.claude/.autonomous.er.json` — cli-owned. */
export interface ErSidecar {
  version: number;
  entities: Record<string, { v: number; module: string }>;
  history: ErHistoryEntry[];
  changes: Record<string, ErChangeRecord>;
}

/** Relative path of the ER sidecar. */
export const ER_SIDECAR_REL = ".claude/.autonomous.er.json";

/** An empty sidecar. */
export function emptyErSidecar(): ErSidecar {
  return { version: 0, entities: {}, history: [], changes: {} };
}

/** Coerce parsed JSON into a sidecar (missing parts default). */
export function coerceErSidecar(raw: unknown): ErSidecar {
  const o = (raw && typeof raw === "object" ? raw : {}) as Partial<ErSidecar>;
  return {
    version: typeof o.version === "number" && o.version >= 0 ? Math.floor(o.version) : 0,
    entities: o.entities && typeof o.entities === "object" ? o.entities : {},
    history: Array.isArray(o.history) ? o.history : [],
    changes: o.changes && typeof o.changes === "object" ? o.changes : {},
  };
}

/** The canonical text an ERC approval binds to (the file, line endings normalized). */
export function ercCanonical(text: string): string {
  return text.replace(/\r\n/g, "\n");
}
