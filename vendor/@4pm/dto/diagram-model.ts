/**
 * Vendored from @4pm/dto (diagram-model.ts) by scripts/vendor-shared.mjs — do not edit.
 */
import { ER_MODULE_RE } from "./er-model";
import { XmlParseError, canonicalXml, cloneXml, parseXml, serializeXml, setXmlAttr, xmlAttr, xmlChildren, type XmlElement } from "./xml-lite";
export const DIAGRAM_ROOT = ".4pm/diagrams";
export const DIAGRAM_MODULE_RE = ER_MODULE_RE;
export const SDC_ID_RE = /^SDC-[1-9]\d{0,5}$/;
export const SDC_NEW_FILE_RE = /^SDC-NEW-[A-Za-z0-9_-]{1,40}\.md$/;
export const DIAGRAM_COMPONENT_KINDS = ["app", "service", "store", "queue", "external", "actor", "group"] as const;
export const DIAGRAM_LINK_KINDS = ["http", "ws", "event", "db", "file", "call"] as const;
export const DIAGRAM_REF_ATTR = "4pm-ref";
export const DIAGRAM_DEFAULT_PAGE = "Page-1";
export interface DiagramCell {
    id: string;
    page: string;
    type: "vertex" | "edge";
    parent: string;
    source?: string;
    target?: string;
    kind: string;
    label: string;
    ref?: string;
    attrs: Record<string, string>;
    el: XmlElement;
}
export interface DiagramPage {
    name: string;
    id: string;
    modelAttrs: [
        string,
        string
    ][];
    structural: XmlElement[];
}
export interface DiagramModule {
    fileAttrs: [
        string,
        string
    ][];
    pages: DiagramPage[];
    cells: DiagramCell[];
}
export interface DiagramParseError {
    message: string;
    cell?: string;
}
export function emptyDiagramModule(): DiagramModule {
    return { fileAttrs: [], pages: [], cells: [] };
}
export function innerMxCell(el: XmlElement): XmlElement | undefined {
    return el.name === "mxCell" ? el : xmlChildren(el, "mxCell")[0];
}
function cellOf(el: XmlElement, page: string): DiagramCell | null {
    const mx = innerMxCell(el);
    const id = xmlAttr(el, "id") ?? "";
    if (!mx || !id)
        return null;
    const type = xmlAttr(mx, "edge") === "1" ? "edge" : xmlAttr(mx, "vertex") === "1" ? "vertex" : null;
    if (!type)
        return null;
    const attrs: Record<string, string> = el.name === "mxCell" ? {} : Object.fromEntries(el.attrs.filter(([k]) => k !== "id"));
    const source = xmlAttr(mx, "source");
    const target = xmlAttr(mx, "target");
    const ref = attrs[DIAGRAM_REF_ATTR];
    return {
        id,
        page,
        type,
        parent: xmlAttr(mx, "parent") ?? "",
        ...(source ? { source } : {}),
        ...(target ? { target } : {}),
        kind: attrs.kind ?? "",
        label: attrs.label ?? xmlAttr(mx, "value") ?? "",
        ...(ref ? { ref } : {}),
        attrs,
        el,
    };
}
function readModel(model: XmlElement, name: string, id: string): {
    page: DiagramPage;
    cells: DiagramCell[];
} {
    const root = xmlChildren(model, "root")[0];
    const page: DiagramPage = { name, id, modelAttrs: model.attrs.map(([k, v]) => [k, v]), structural: [] };
    const cells: DiagramCell[] = [];
    for (const el of root ? xmlChildren(root) : []) {
        const c = cellOf(el, name);
        if (c)
            cells.push(c);
        else
            page.structural.push(el);
    }
    return { page, cells };
}
export function parseDiagramModule(xml: string): {
    module: DiagramModule;
    errors: DiagramParseError[];
} {
    const module = emptyDiagramModule();
    if (!xml.trim())
        return { module, errors: [] };
    let doc: XmlElement;
    try {
        doc = parseXml(xml);
    }
    catch (err) {
        return { module, errors: [{ message: err instanceof XmlParseError ? `invalid XML: ${err.message} (at ${err.offset})` : "invalid XML" }] };
    }
    const errors: DiagramParseError[] = [];
    if (doc.name === "mxGraphModel") {
        const { page, cells } = readModel(doc, DIAGRAM_DEFAULT_PAGE, "page-1");
        module.pages.push(page);
        module.cells.push(...cells);
    }
    else if (doc.name === "mxfile") {
        module.fileAttrs = doc.attrs.map(([k, v]) => [k, v]);
        xmlChildren(doc, "diagram").forEach((d, i) => {
            const name = xmlAttr(d, "name") || `Page-${i + 1}`;
            const model = xmlChildren(d, "mxGraphModel")[0];
            if (!model) {
                if (d.children.some((c) => typeof c === "string" && c.trim()))
                    errors.push({ message: `page "${name}" is compressed — save the diagram uncompressed` });
                module.pages.push({ name, id: xmlAttr(d, "id") ?? `page-${i + 1}`, modelAttrs: [], structural: [] });
                return;
            }
            const { page, cells } = readModel(model, name, xmlAttr(d, "id") ?? `page-${i + 1}`);
            module.pages.push(page);
            module.cells.push(...cells);
        });
    }
    else {
        return { module, errors: [{ message: `expected <mxfile> or <mxGraphModel>, got <${doc.name}>` }] };
    }
    const seen = new Set<string>();
    for (const c of module.cells) {
        if (seen.has(c.id))
            errors.push({ message: `duplicate cell id "${c.id}"`, cell: c.id });
        seen.add(c.id);
    }
    return { module, errors };
}
export function defaultStructural(): XmlElement[] {
    return [
        { name: "mxCell", attrs: [["id", "0"]], children: [] },
        { name: "mxCell", attrs: [["id", "1"], ["parent", "0"]], children: [] },
    ];
}
export function firstLayerOf(page: DiagramPage | undefined): string {
    if (!page)
        return "1";
    const root = page.structural.find((s) => !xmlAttr(s, "parent"));
    const layer = page.structural.find((s) => xmlAttr(s, "parent") === (root ? xmlAttr(root, "id") : "0"));
    return (layer && xmlAttr(layer, "id")) ?? "1";
}
function parentsFirst(cells: DiagramCell[]): DiagramCell[] {
    const byId = new Map(cells.map((c) => [c.id, c]));
    const out: DiagramCell[] = [];
    const done = new Set<string>();
    const visit = (c: DiagramCell, stack: Set<string>): void => {
        if (done.has(c.id) || stack.has(c.id))
            return;
        stack.add(c.id);
        const p = byId.get(c.parent);
        if (p)
            visit(p, stack);
        done.add(c.id);
        out.push(c);
    };
    for (const c of cells)
        visit(c, new Set());
    return out;
}
export function serializeDiagramModule(module: DiagramModule): string {
    const pages = module.pages.length ? module.pages : [{ name: DIAGRAM_DEFAULT_PAGE, id: "page-1", modelAttrs: [], structural: defaultStructural() }];
    const file: XmlElement = {
        name: "mxfile",
        attrs: module.fileAttrs.length ? module.fileAttrs.filter(([k]) => k !== "compressed").concat([["compressed", "false"]]) : [["host", "4pm"], ["compressed", "false"]],
        children: pages.map((p) => ({
            name: "diagram",
            attrs: [["id", p.id], ["name", p.name]] as [
                string,
                string
            ][],
            children: [
                {
                    name: "mxGraphModel",
                    attrs: p.modelAttrs,
                    children: [{ name: "root", attrs: [], children: [...(p.structural.length ? p.structural : defaultStructural()), ...parentsFirst(module.cells.filter((c) => c.page === p.name)).map((c) => c.el)] }],
                },
            ],
        })),
    };
    return `${serializeXml(file, 2)}\n`;
}
export function diagramCellFromElement(el: XmlElement, page: string): DiagramCell | null {
    return cellOf(el, page);
}
export function cloneDiagramCell(c: DiagramCell, page = c.page): DiagramCell {
    return cellOf(cloneXml(c.el), page) ?? { ...c, page, el: cloneXml(c.el) };
}
export function geometryOf(c: Pick<DiagramCell, "el">): XmlElement | undefined {
    const mx = innerMxCell(c.el);
    return mx ? xmlChildren(mx, "mxGeometry")[0] : undefined;
}
export function cellContentKey(c: Pick<DiagramCell, "el">): string {
    const el = cloneXml(c.el);
    const mx = innerMxCell(el);
    if (mx)
        mx.children = mx.children.filter((x) => typeof x === "string" || x.name !== "mxGeometry");
    return canonicalXml(el);
}
export function cellGeometryKey(c: Pick<DiagramCell, "el">): string {
    const g = geometryOf(c);
    return g ? canonicalXml(g) : "";
}
export function composeCell(content: DiagramCell, geometry: Pick<DiagramCell, "el"> | undefined, page = content.page): DiagramCell {
    const el = cloneXml(content.el);
    const mx = innerMxCell(el);
    if (mx) {
        mx.children = mx.children.filter((x) => typeof x === "string" || x.name !== "mxGeometry");
        const g = geometry ? geometryOf(geometry) : geometryOf(content);
        if (g)
            mx.children.push(cloneXml(g));
    }
    return cellOf(el, page) ?? { ...content, page, el };
}
export interface DiagramCellOwner {
    module: string;
    page: string;
}
export interface DiagramMaster {
    cells: DiagramCell[];
    byId: Map<string, DiagramCell>;
    owner: Record<string, DiagramCellOwner>;
    duplicates: [
        string,
        ...string[]
    ][];
    structural: Record<string, string[]>;
}
export function diagramMasterOf(modules: Record<string, DiagramModule>, order: readonly string[] = []): DiagramMaster {
    const names = [...new Set([...order.filter((m) => modules[m]), ...Object.keys(modules).sort()])];
    const cells: DiagramCell[] = [];
    const byId = new Map<string, DiagramCell>();
    const owner: Record<string, DiagramCellOwner> = {};
    const dupes = new Map<string, string[]>();
    const structural: Record<string, string[]> = {};
    for (const m of names) {
        for (const p of modules[m]!.pages)
            structural[`${m}/${p.name}`] = p.structural.map((s) => xmlAttr(s, "id") ?? "").filter(Boolean);
        for (const c of modules[m]!.cells) {
            if (owner[c.id]) {
                dupes.set(c.id, [...(dupes.get(c.id) ?? [owner[c.id]!.module]), m]);
                continue;
            }
            owner[c.id] = { module: m, page: c.page };
            byId.set(c.id, c);
            cells.push(c);
        }
    }
    return { cells, byId, owner, duplicates: [...dupes.entries()].map(([n, ms]) => [n, ...ms] as [
            string,
            ...string[]
        ]), structural };
}
export function diagramSlice(master: Pick<DiagramMaster, "cells" | "byId">, ids: readonly string[]): {
    cells: DiagramCell[];
    neighbours: string[];
} {
    const keep = new Set(ids.filter((id) => master.byId.has(id)));
    const extra = new Set<string>();
    for (const c of master.cells) {
        if (c.type !== "edge")
            continue;
        const touches = keep.has(c.id) || (c.source && keep.has(c.source)) || (c.target && keep.has(c.target));
        if (!touches)
            continue;
        if (!keep.has(c.id))
            extra.add(c.id);
        for (const end of [c.source, c.target])
            if (end && !keep.has(end) && master.byId.has(end))
                extra.add(end);
    }
    for (const id of [...keep, ...extra]) {
        let p = master.byId.get(id)?.parent;
        while (p && master.byId.has(p) && !keep.has(p) && !extra.has(p)) {
            extra.add(p);
            p = master.byId.get(p)!.parent;
        }
    }
    const all = new Set([...keep, ...extra]);
    return { cells: master.cells.filter((c) => all.has(c.id)), neighbours: [...extra] };
}
function compactLine(c: DiagramCell, byId: Map<string, DiagramCell>): string {
    const name = (id: string | undefined): string => (id ? `${id}${byId.get(id)?.label ? ` "${byId.get(id)!.label}"` : ""}` : "?");
    if (c.type === "edge")
        return `  ${c.id}: ${c.source ?? "?"} -${c.kind || "link"}-> ${c.target ?? "?"}${c.label ? ` "${c.label}"` : ""}`;
    if (c.ref)
        return `  ${c.id}: ref → ${name(c.ref)}`;
    const tech = c.attrs.tech ? `, ${c.attrs.tech}` : "";
    return `  ${c.id} [${c.kind || "shape"}${tech}]${c.label ? ` "${c.label}"` : ""}`;
}
export function diagramCompactText(master: Pick<DiagramMaster, "cells" | "byId" | "owner">, only?: readonly DiagramCell[]): string {
    const cells = only ?? master.cells;
    const groups = new Map<string, DiagramCell[]>();
    for (const c of cells) {
        const o = master.owner[c.id];
        const key = `${o?.module ?? "?"} / ${c.page}`;
        groups.set(key, [...(groups.get(key) ?? []), c]);
    }
    const out: string[] = [];
    for (const [key, list] of groups) {
        out.push(`${key}:`);
        for (const c of [...list.filter((x) => x.type === "vertex"), ...list.filter((x) => x.type === "edge")])
            out.push(compactLine(c, master.byId));
    }
    return out.join("\n");
}
export function geometryBox(g: XmlElement | undefined): {
    x: number;
    y: number;
    w: number;
    h: number;
} | null {
    if (!g)
        return null;
    const n = (k: string): number => {
        const v = Number(xmlAttr(g, k) ?? 0);
        return Number.isFinite(v) ? v : 0;
    };
    return { x: n("x"), y: n("y"), w: n("width"), h: n("height") };
}
export function setCellStyle(el: XmlElement, style: string): void {
    const mx = innerMxCell(el);
    if (mx)
        setXmlAttr(mx, "style", style);
}
export function cellStyleOf(el: XmlElement): string {
    const mx = innerMxCell(el);
    return (mx && xmlAttr(mx, "style")) ?? "";
}
export function sdcIdOfPath(path: string): string | null {
    const m = /(?:^|\/)changes\/(SDC-[1-9]\d{0,5})\.md$/.exec(path);
    return m ? m[1]! : null;
}
