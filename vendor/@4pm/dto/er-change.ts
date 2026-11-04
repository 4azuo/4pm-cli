/**
 * Vendored from @4pm/dto (er-change.ts) by scripts/vendor-shared.mjs — do not edit.
 */
import { z } from "zod";
import { ER_MODULE_RE, emptyErModel, erDiagramBlock, erMasterOf, erRelationKey, parseErDiagram, sameErAttribute, serializeErDiagram, type ErAttribute, type ErEntity, type ErModel, type ErParseError, type ErRelation, } from "./er-model";
export const ERC_SOURCES = ["intake", "implement", "web"] as const;
export type ErcSource = (typeof ERC_SOURCES)[number];
export const ercMetaSchema = z.object({
    title: z.string().min(1).max(200),
    source: z.enum(ERC_SOURCES),
    req: z.array(z.string().max(64)).max(50).default([]),
    group: z.string().max(64).default(""),
    task: z.string().max(64).optional(),
    team: z.string().max(32).optional(),
    module: z.string().regex(ER_MODULE_RE),
    baseVersion: z.number().int().min(0).optional(),
    base: z.record(z.string(), z.number().int().min(0)).default({}),
    remove: z
        .object({
        entities: z.array(z.string()).default([]),
        attributes: z.record(z.string(), z.array(z.string())).default({}),
        relations: z.array(z.tuple([z.string(), z.string(), z.string()])).default([]),
    })
        .default({ entities: [], attributes: {}, relations: [] }),
    depends: z.array(z.string()).optional(),
});
export type ErcMeta = z.infer<typeof ercMetaSchema>;
export interface ErcDoc {
    id: string | null;
    meta: ErcMeta;
    delta: ErModel;
    rationale: string;
}
export function parseErcFile(md: string): {
    doc: ErcDoc | null;
    errors: ErParseError[];
} {
    const lines = md.split(/\r?\n/);
    const id = /^#\s+(ERC-[1-9]\d{0,5})\b/.exec(lines.find((l) => l.startsWith("#")) ?? "")?.[1] ?? null;
    const metaStart = lines.findIndex((l) => /^\s*```+\s*json\s+er-meta\b/.test(l));
    if (metaStart < 0)
        return { doc: null, errors: [{ line: 1, message: "missing ```json er-meta block" }] };
    let metaEnd = metaStart + 1;
    while (metaEnd < lines.length && !/^\s*```+\s*$/.test(lines[metaEnd]!))
        metaEnd++;
    let raw: unknown;
    try {
        raw = JSON.parse(lines.slice(metaStart + 1, metaEnd).join("\n"));
    }
    catch {
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
    let rationale = rest;
    if (block) {
        const after = rest.split(/\r?\n/);
        let end = block.offset + block.text.split(/\r?\n/).length;
        while (end < after.length && !/^\s*```+\s*$/.test(after[end]!))
            end++;
        rationale = after.slice(end + 1).join("\n");
    }
    if (errors.length)
        return { doc: null, errors };
    return { doc: { id, meta: meta.data, delta: parsed.model, rationale: rationale.trim() }, errors: [] };
}
export function serializeErcFile(id: string, doc: Pick<ErcDoc, "meta" | "delta" | "rationale">): string {
    const meta = JSON.stringify(doc.meta, null, 2);
    const diagram = doc.delta.entities.length || doc.delta.relations.length ? `\n\`\`\`mermaid\n${serializeErDiagram(doc.delta)}\n\`\`\`\n` : "";
    return `# ${id} — ${doc.meta.title}\n\n\`\`\`json er-meta\n${meta}\n\`\`\`\n${diagram}\n${doc.rationale.trim()}\n`;
}
export interface ErPatch {
    addEntities: ErEntity[];
    upsertAttrs: Record<string, ErAttribute[]>;
    removeAttrs: Record<string, string[]>;
    removeEntities: string[];
    upsertRelations: ErRelation[];
    removeRelations: ErRelation[];
}
function entityMap(model: ErModel): Map<string, ErEntity> {
    return new Map(model.entities.map((e) => [e.name, e]));
}
function relationMap(model: ErModel): Map<string, ErRelation> {
    return new Map(model.relations.map((r) => [erRelationKey(r), r]));
}
export function ercPatch(base: ErModel, doc: Pick<ErcDoc, "meta" | "delta">): ErPatch {
    const ents = entityMap(base);
    const rels = relationMap(base);
    const patch: ErPatch = { addEntities: [], upsertAttrs: {}, removeAttrs: {}, removeEntities: [], upsertRelations: [], removeRelations: [] };
    const removed = new Set(doc.meta.remove.entities);
    for (const e of doc.delta.entities) {
        if (removed.has(e.name))
            continue;
        const cur = ents.get(e.name);
        if (!cur) {
            patch.addEntities.push(e);
            continue;
        }
        const attrs = e.attributes.filter((a) => !sameErAttribute(a, cur.attributes.find((x) => x.name === a.name)));
        if (attrs.length)
            patch.upsertAttrs[e.name] = attrs;
    }
    for (const [name, list] of Object.entries(doc.meta.remove.attributes)) {
        const cur = ents.get(name);
        const gone = list.filter((a) => cur?.attributes.some((x) => x.name === a) && !(patch.upsertAttrs[name] ?? []).some((x) => x.name === a));
        if (gone.length)
            patch.removeAttrs[name] = gone;
    }
    patch.removeEntities = [...removed].filter((n) => ents.has(n));
    for (const r of doc.delta.relations) {
        const cur = rels.get(erRelationKey(r));
        if (!cur || cur.card !== r.card)
            patch.upsertRelations.push(r);
    }
    for (const [a, b, label] of doc.meta.remove.relations) {
        const cur = rels.get(erRelationKey({ a, b, label }));
        if (cur)
            patch.removeRelations.push(cur);
    }
    return patch;
}
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
export function erPatchIsEmpty(p: ErPatch): boolean {
    return erPatchEntities(p).length === 0;
}
export interface ErConflict {
    entity: string;
    attribute?: string;
    relation?: string;
}
export function erConflicts(base: ErModel, current: ErModel, patch: ErPatch): ErConflict[] {
    const b = entityMap(base);
    const c = entityMap(current);
    const out: ErConflict[] = [];
    const attrOf = (m: Map<string, ErEntity>, e: string, a: string): ErAttribute | undefined => m.get(e)?.attributes.find((x) => x.name === a);
    for (const e of patch.addEntities) {
        const now = c.get(e.name);
        if (now && JSON.stringify(now.attributes) !== JSON.stringify(e.attributes))
            out.push({ entity: e.name });
    }
    for (const [e, attrs] of Object.entries(patch.upsertAttrs)) {
        if (!c.has(e)) {
            out.push({ entity: e });
            continue;
        }
        for (const a of attrs) {
            const was = attrOf(b, e, a.name);
            const now = attrOf(c, e, a.name);
            if (!sameErAttribute(was, now) && !sameErAttribute(now, a))
                out.push({ entity: e, attribute: a.name });
        }
    }
    for (const [e, names] of Object.entries(patch.removeAttrs)) {
        for (const n of names) {
            const now = attrOf(c, e, n);
            if (now && !sameErAttribute(attrOf(b, e, n), now))
                out.push({ entity: e, attribute: n });
        }
    }
    for (const e of patch.removeEntities) {
        const was = b.get(e);
        const now = c.get(e);
        if (now && JSON.stringify(was?.attributes) !== JSON.stringify(now.attributes))
            out.push({ entity: e });
    }
    const br = relationMap(base);
    const cr = relationMap(current);
    for (const r of patch.upsertRelations) {
        const k = erRelationKey(r);
        const was = br.get(k);
        const now = cr.get(k);
        if (was?.card !== now?.card && now?.card !== r.card)
            out.push({ entity: r.a, relation: k });
        if (!c.has(r.a) && !patch.addEntities.some((e) => e.name === r.a))
            out.push({ entity: r.a, relation: k });
        if (!c.has(r.b) && !patch.addEntities.some((e) => e.name === r.b))
            out.push({ entity: r.b, relation: k });
    }
    for (const r of patch.removeRelations) {
        const k = erRelationKey(r);
        const now = cr.get(k);
        if (now && now.card !== br.get(k)?.card)
            out.push({ entity: r.a, relation: k });
    }
    return out;
}
export function applyErPatch(modules: Record<string, ErModel>, patch: ErPatch, module: string): {
    modules: Record<string, ErModel>;
    changed: string[];
} {
    const next: Record<string, ErModel> = Object.fromEntries(Object.entries(modules).map(([m, model]) => [m, { entities: model.entities.map((e) => ({ ...e, attributes: [...e.attributes] })), relations: [...model.relations] }]));
    const changed = new Set<string>();
    const owner = erMasterOf(next).owner;
    const ensure = (m: string): ErModel => (next[m] ??= emptyErModel());
    for (const e of patch.addEntities) {
        const m = owner[e.name] ?? module;
        const target = ensure(m);
        const i = target.entities.findIndex((x) => x.name === e.name);
        if (i >= 0)
            target.entities[i] = { ...e, attributes: [...e.attributes] };
        else
            target.entities.push({ ...e, attributes: [...e.attributes] });
        owner[e.name] = m;
        changed.add(m);
    }
    for (const [name, attrs] of Object.entries(patch.upsertAttrs)) {
        const m = owner[name];
        const ent = m ? next[m]!.entities.find((e) => e.name === name) : undefined;
        if (!ent)
            continue;
        for (const a of attrs) {
            const i = ent.attributes.findIndex((x) => x.name === a.name);
            if (i >= 0)
                ent.attributes[i] = a;
            else
                ent.attributes.push(a);
        }
        changed.add(m!);
    }
    for (const [name, names] of Object.entries(patch.removeAttrs)) {
        const m = owner[name];
        const ent = m ? next[m]!.entities.find((e) => e.name === name) : undefined;
        if (!ent)
            continue;
        ent.attributes = ent.attributes.filter((a) => !names.includes(a.name));
        changed.add(m!);
    }
    const gone = new Set(patch.removeEntities);
    const dropRel = new Set(patch.removeRelations.map(erRelationKey));
    for (const [m, model] of Object.entries(next)) {
        const before = model.entities.length + model.relations.length;
        model.entities = model.entities.filter((e) => !gone.has(e.name));
        model.relations = model.relations.filter((r) => !gone.has(r.a) && !gone.has(r.b) && !dropRel.has(erRelationKey(r)));
        if (model.entities.length + model.relations.length !== before)
            changed.add(m);
    }
    for (const r of patch.upsertRelations) {
        const k = erRelationKey(r);
        const home = Object.entries(next).find(([, model]) => model.relations.some((x) => erRelationKey(x) === k))?.[0];
        const m = home ?? owner[r.a] ?? owner[r.b] ?? module;
        const target = ensure(m);
        const i = target.relations.findIndex((x) => erRelationKey(x) === k);
        if (i >= 0)
            target.relations[i] = r;
        else
            target.relations.push(r);
        changed.add(m);
    }
    return { modules: next, changed: [...changed].sort() };
}
export type ErChangeKind = "added" | "changed" | "removed";
export interface ErAttributeChange {
    name: string;
    kind: ErChangeKind;
    before?: ErAttribute;
    after?: ErAttribute;
}
export interface ErEntityChange {
    name: string;
    kind: ErChangeKind;
    attributes: ErAttributeChange[];
}
export interface ErRelationChange {
    key: string;
    kind: ErChangeKind;
    before?: ErRelation;
    after?: ErRelation;
}
export interface ErChanges {
    entities: ErEntityChange[];
    relations: ErRelationChange[];
}
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
export function erDeltaFromEdit(baseModules: Record<string, ErModel>, edited: Record<string, ErModel>): {
    delta: ErModel;
    remove: ErcMeta["remove"];
    duplicates: string[];
} {
    const before = erMasterOf(baseModules).model;
    const merged = erMasterOf({ ...baseModules, ...edited });
    const after = merged.model;
    const b = entityMap(before);
    const a = entityMap(after);
    const delta = emptyErModel();
    const remove: ErcMeta["remove"] = { entities: [], attributes: {}, relations: [] };
    for (const e of after.entities) {
        const was = b.get(e.name);
        if (!was || JSON.stringify(was.attributes) !== JSON.stringify(e.attributes))
            delta.entities.push(e);
        if (was) {
            const lost = was.attributes.filter((x) => !e.attributes.some((y) => y.name === x.name)).map((x) => x.name);
            if (lost.length)
                remove.attributes[e.name] = lost;
        }
    }
    for (const e of before.entities)
        if (!a.has(e.name))
            remove.entities.push(e.name);
    const br = relationMap(before);
    const ar = relationMap(after);
    for (const [k, r] of ar)
        if (br.get(k)?.card !== r.card)
            delta.relations.push(r);
    for (const [k, r] of br)
        if (!ar.has(k) && !remove.entities.includes(r.a) && !remove.entities.includes(r.b))
            remove.relations.push([r.a, r.b, r.label]);
    return { delta, remove, duplicates: merged.duplicates.map((d) => d[0]) };
}
export const ERC_STATES = ["pending", "applied", "rejected", "conflict", "withdrawn"] as const;
export type ErcState = (typeof ERC_STATES)[number];
export function ercBlocks(state: ErcState | undefined): boolean {
    return state === "pending" || state === "conflict" || state === "rejected";
}
export interface ErChangeRecord {
    state: ErcState;
    reason?: string;
    conflictsWith?: string[];
    appliedVersion?: number;
    at?: string;
    by?: string;
    byLabel?: string;
}
export interface ErHistoryEntry {
    version: number;
    erc: string;
    appliedAt: string;
    approvedBy: string;
    approvedByLabel?: string;
    entities: string[];
    commit?: string;
}
export interface ErSidecar {
    version: number;
    entities: Record<string, {
        v: number;
        module: string;
    }>;
    history: ErHistoryEntry[];
    changes: Record<string, ErChangeRecord>;
}
export const ER_SIDECAR_REL = ".4pm/.autonomous.er.json";
export function emptyErSidecar(): ErSidecar {
    return { version: 0, entities: {}, history: [], changes: {} };
}
export function coerceErSidecar(raw: unknown): ErSidecar {
    const o = (raw && typeof raw === "object" ? raw : {}) as Partial<ErSidecar>;
    return {
        version: typeof o.version === "number" && o.version >= 0 ? Math.floor(o.version) : 0,
        entities: o.entities && typeof o.entities === "object" ? o.entities : {},
        history: Array.isArray(o.history) ? o.history : [],
        changes: o.changes && typeof o.changes === "object" ? o.changes : {},
    };
}
export function ercCanonical(text: string): string {
    return text.replace(/\r\n/g, "\n");
}
