/**
 * Vendored from @4pm/dto (autonomous-docs.ts) by scripts/vendor-shared.mjs — do not edit.
 */
import { z } from "zod";
import { parseDelivery, type DeliveryRecord } from "./autonomous-books-set";
export const DOCS_SIDECAR_REL = ".4pm/.autonomous.docs.json";
export const LINEAGE_SIDECAR_REL = ".4pm/.autonomous.lineage.json";
export const DOC_TYPE_DIRS: Readonly<Record<string, string>> = {
    page: "docs/pages",
    window: "docs/windows",
    adr: "docs/adr",
    sad: "docs/architecture",
    api: "docs/api",
    cache: "docs/cache",
    component: "docs/components",
    "biz-flow": "docs/biz-flows",
    "data-model": "docs/data-model",
    guide: "docs/guides",
    changelog: "CHANGELOG.md",
};
export const SPEC_DOC_TYPES = Object.keys(DOC_TYPE_DIRS);
export const DOC_TYPE_KEY_PATTERN = /^[a-z][a-z0-9-]{1,39}$/;
export function docTypeDir(type: string): string {
    return DOC_TYPE_DIRS[type] ?? `docs/${type}`;
}
export const DOC_NUMBERED_TYPES: readonly string[] = ["page", "window", "adr", "sad", "api", "cache", "component", "biz-flow", "data-model"];
export const DOC_NUMBER_DIGITS = 4;
export const NEW_DOC_FILE_RE = /^NEW-(\d{1,3})-([a-z0-9][a-z0-9-]{0,80})\.md$/;
export const NUMBERED_DOC_FILE_RE = /^(\d{1,6})-([A-Za-z0-9][A-Za-z0-9._-]*)\.md$/;
export function docNumberCode(n: number): string {
    return String(n).padStart(DOC_NUMBER_DIGITS, "0");
}
export interface SpecDocs {
    types: string[];
    org: string;
    numbered?: string[];
}
export function readSpecDocs(spec: unknown): SpecDocs {
    const o = (spec && typeof spec === "object" ? spec : {}) as Record<string, unknown>;
    const field = (key: string): unknown => {
        if (Array.isArray(o.fields)) {
            const f = (o.fields as unknown[]).find((x) => !!x && typeof x === "object" && (x as {
                id?: unknown;
            }).id === key) as {
                value?: unknown;
            } | undefined;
            if (f)
                return f.value;
        }
        return o[key];
    };
    const raw = field("docs_types");
    const list = Array.isArray(raw) ? raw.map(String) : typeof raw === "string" ? raw.split(",") : [];
    const types = [...new Set(list.map((t) => t.trim()).filter((t) => t in DOC_TYPE_DIRS || DOC_TYPE_KEY_PATTERN.test(t)))];
    const org = field("docs_org");
    return { types, org: typeof org === "string" ? org : "", numbered: types.filter((t) => DOC_NUMBERED_TYPES.includes(t)) };
}
export const DEFAULT_ASSET_DIR = "assets/generated";
export function readSpecAssetDir(spec: unknown): string {
    const o = (spec && typeof spec === "object" ? spec : {}) as Record<string, unknown>;
    let raw: unknown = o.asset_dir;
    if (Array.isArray(o.fields)) {
        const f = (o.fields as unknown[]).find((x) => !!x && typeof x === "object" && (x as {
            id?: unknown;
        }).id === "asset_dir") as {
            value?: unknown;
        } | undefined;
        if (f)
            raw = f.value;
    }
    const dir = typeof raw === "string" ? raw.trim().replace(/^\/+|\/+$/g, "") : "";
    return dir && !dir.split("/").includes("..") && /^[A-Za-z0-9._/-]+$/.test(dir) ? dir : DEFAULT_ASSET_DIR;
}
export function assetGuideSection(guide: string): string {
    const m = /^##\s+Assets\s*$([\s\S]*?)(?=^##\s|(?![\s\S]))/m.exec(guide);
    return (m?.[1] ?? "").trim().slice(0, 2000);
}
export function docTypeOfPath(path: string): string | null {
    for (const [type, dir] of Object.entries(DOC_TYPE_DIRS)) {
        if (dir.endsWith(".md") ? path === dir : path.startsWith(`${dir}/`))
            return type;
    }
    const own = /^docs\/([a-z][a-z0-9-]{1,39})\//.exec(path)?.[1];
    return own ?? null;
}
export const DOC_TEMPLATES_DIR = ".4pm/doc-templates";
export interface DocTemplateMeta {
    name: string;
    description: string;
    numbered: boolean;
    version: number;
    templateFile?: string;
}
export interface DocManifestFile {
    path: string;
    type: string;
    action: "created" | "updated";
    number?: number;
}
export interface DocReviewRecord {
    round: number;
    at: string;
    by: string;
    byLabel?: string;
    decision: DocReviewDecision;
    opinion: string;
    final: boolean;
}
export type DocReviewDecision = "proceed" | "revise";
export interface DocEntry {
    round: number;
    state: "pending" | "review" | "accepted";
    branch: string;
    head?: string;
    files: DocManifestFile[];
    history: DocReviewRecord[];
    overlaps?: Record<string, string[]>;
    pr?: DeliveryRecord;
    repos?: DocRepoHead[];
    assets?: AssetItem[];
}
export interface AssetItem {
    key: string;
    capability: "image.pixel" | "character.directions" | "animation.frames" | "tileset";
    description: string;
    width: number;
    height: number;
    path: string;
    directions?: number;
    frames?: number;
    from?: string;
    view?: string;
    lower?: string;
    upper?: string;
    files: string[];
    round?: number;
    regenerate?: string;
}
const ASSET_CAPABILITIES = ["image.pixel", "character.directions", "animation.frames", "tileset"] as const;
export function parseAssetItems(raw: unknown): AssetItem[] {
    if (!Array.isArray(raw))
        return [];
    const out: AssetItem[] = [];
    const seen = new Set<string>();
    for (const v of raw.slice(0, 50)) {
        if (!v || typeof v !== "object")
            continue;
        const o = v as Record<string, unknown>;
        const key = typeof o.key === "string" ? o.key.trim().slice(0, 64) : "";
        const capability = ASSET_CAPABILITIES.find((c) => c === o.capability);
        const path = typeof o.path === "string" ? o.path.trim().replace(/^\/+/, "") : "";
        if (!key || seen.has(key) || !capability || !path || path.includes(".."))
            continue;
        seen.add(key);
        const num = (x: unknown, d: number) => (typeof x === "number" && Number.isFinite(x) ? Math.round(x) : d);
        const str = (x: unknown) => (typeof x === "string" && x.trim() ? x.trim().slice(0, 1000) : undefined);
        out.push({
            key,
            capability,
            description: str(o.description) ?? key,
            width: Math.min(768, Math.max(16, num(o.width, 64))),
            height: Math.min(768, Math.max(16, num(o.height, 64))),
            path,
            ...(typeof o.directions === "number" ? { directions: o.directions === 4 ? 4 : 8 } : {}),
            ...(typeof o.frames === "number" ? { frames: Math.min(16, Math.max(4, Math.round(o.frames))) } : {}),
            ...(str(o.from) ? { from: str(o.from)! } : {}),
            ...(str(o.view) ? { view: str(o.view)! } : {}),
            ...(str(o.lower) ? { lower: str(o.lower)! } : {}),
            ...(str(o.upper) ? { upper: str(o.upper)! } : {}),
            files: Array.isArray(o.files) ? o.files.filter((f): f is string => typeof f === "string") : [],
            ...(typeof o.round === "number" ? { round: o.round } : {}),
            ...(str(o.regenerate) ? { regenerate: str(o.regenerate)! } : {}),
        });
    }
    return out;
}
export interface DocRepoHead {
    dir: string;
    branch: string;
    head: string;
}
export type DocsSidecar = Record<string, DocEntry>;
export function parseDocsSidecar(text: string | null | undefined): DocsSidecar {
    try {
        const o = JSON.parse(text || "{}") as unknown;
        if (!o || typeof o !== "object" || Array.isArray(o))
            return {};
        const out: DocsSidecar = {};
        for (const [id, v] of Object.entries(o as Record<string, unknown>)) {
            if (!v || typeof v !== "object")
                continue;
            const e = v as Partial<DocEntry>;
            out[id] = {
                round: typeof e.round === "number" ? e.round : 0,
                state: e.state === "review" || e.state === "accepted" ? e.state : "pending",
                branch: typeof e.branch === "string" ? e.branch : "",
                ...(typeof e.head === "string" ? { head: e.head } : {}),
                files: Array.isArray(e.files) ? e.files.filter((f) => f && typeof f.path === "string") : [],
                history: Array.isArray(e.history) ? e.history.filter((h) => h && typeof h.round === "number") : [],
                ...(e.overlaps && typeof e.overlaps === "object" ? { overlaps: e.overlaps } : {}),
                ...(parseDelivery(e.pr) ? { pr: parseDelivery(e.pr)! } : {}),
                ...(Array.isArray(e.assets) ? { assets: parseAssetItems(e.assets) } : {}),
                ...(Array.isArray(e.repos)
                    ? { repos: e.repos.filter((r): r is DocRepoHead => !!r && typeof r.dir === "string" && typeof r.branch === "string" && typeof r.head === "string") }
                    : {}),
            };
        }
        return out;
    }
    catch {
        return {};
    }
}
export function roundDecision(entry: DocEntry, round: number): DocReviewDecision | null {
    const recs = entry.history.filter((h) => h.round === round);
    if (!recs.some((h) => h.final))
        return null;
    return recs.some((h) => h.decision === "revise") ? "revise" : "proceed";
}
export const DOC_OPINION_MAX = 4000;
export const docReviewSchema = z
    .object({
    id: z.string().regex(/^(?:DOC|AST)-\d{6}-\d{3}$/),
    round: z.number().int().min(1).max(999),
    decision: z.enum(["proceed", "revise"]),
    opinion: z.string().max(DOC_OPINION_MAX).default(""),
    regenerate: z.array(z.object({ key: z.string().min(1).max(64), opinion: z.string().trim().min(1).max(DOC_OPINION_MAX) })).max(50).optional(),
})
    .refine((r) => r.decision === "proceed" || r.opinion.trim().length > 0 || (r.regenerate?.length ?? 0) > 0, { message: "an opinion is required to revise" });
export type DocReview = z.infer<typeof docReviewSchema>;
export interface LineageEntry {
    source: string;
    request: string;
    team?: string;
    at: string;
    root?: string;
    delivery?: DeliveryRecord;
}
export type LineageSidecar = Record<string, LineageEntry>;
export const LINEAGE_REQUEST_MAX = 500;
export function parseLineage(text: string | null | undefined): LineageSidecar {
    try {
        const o = JSON.parse(text || "{}") as unknown;
        if (!o || typeof o !== "object" || Array.isArray(o))
            return {};
        const out: LineageSidecar = {};
        for (const [g, v] of Object.entries(o as Record<string, unknown>)) {
            if (!/^\d{6}$/.test(g) || !v || typeof v !== "object")
                continue;
            const e = v as Partial<LineageEntry>;
            if (typeof e.source !== "string")
                continue;
            out[g] = {
                source: e.source,
                request: typeof e.request === "string" ? e.request : "",
                at: typeof e.at === "string" ? e.at : "",
                ...(typeof e.team === "string" && e.team ? { team: e.team } : {}),
                ...(typeof e.root === "string" && e.root ? { root: e.root } : {}),
                ...(parseDelivery(e.delivery) ? { delivery: parseDelivery(e.delivery)! } : {}),
            };
        }
        return out;
    }
    catch {
        return {};
    }
}
export const DOC_NUMBERS_PER_TYPE = 50;
