/**
 * The autonomous DOC phase and the request lineage, shared by web / server / cli: the docs sidecar (one entry per
 * `DOC-…` row — round, state, branch, the files it produced, the review history), the review a person submits
 * after a round, the spec's Docs section (doc types → folders, numbered or not), the `NEW-<n>-<slug>.md` names the
 * agent gives new numbered files before the server numbers them, and the lineage sidecar that keeps which request
 * each book group came from (the `REQ-…` row is removed by intake). Since ADR-0563 an accepted DOC row and a request
 * carry the delivery of their branch into `<base>` (`pr` / `delivery`), which their group's later rows wait for.
 * @adr 0536 @adr 0537 @adr 0563
 */
import { z } from "zod";
import { parseDelivery, type DeliveryRecord } from "./autonomous-books-set";

/** The docs sidecar on the books branch (cli-owned). @adr 0536 */
export const DOCS_SIDECAR_REL = ".4pm/.autonomous.docs.json";
/** The lineage sidecar on the books branch (cli-owned, written at intake). @adr 0537 */
export const LINEAGE_SIDECAR_REL = ".4pm/.autonomous.lineage.json";

/** Doc type (spec `docs_types` key) → its folder under the repo, or a root file (`CHANGELOG.md`). */
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

/** The spec's built-in doc types, in the order the spec form lists them. */
export const SPEC_DOC_TYPES = Object.keys(DOC_TYPE_DIRS);

/** A doc type key — a built-in one, or a project's own type added with a spec doc template. @adr 0564 */
export const DOC_TYPE_KEY_PATTERN = /^[a-z][a-z0-9-]{1,39}$/;

/** The folder (or root file) of a doc type: the built-in one, else `docs/<type>`. @adr 0564 */
export function docTypeDir(type: string): string {
  return DOC_TYPE_DIRS[type] ?? `docs/${type}`;
}

/** Doc types whose files are `NNNN-slug.md` with a server-allocated number. @adr 0536 */
export const DOC_NUMBERED_TYPES: readonly string[] = ["page", "window", "adr", "sad", "api", "cache", "component", "biz-flow", "data-model"];

/** Digits of a doc number (`0012`). */
export const DOC_NUMBER_DIGITS = 4;

/** The file name the agent gives a new numbered doc: `NEW-<n>-<slug>.md` (groups: n, slug). */
export const NEW_DOC_FILE_RE = /^NEW-(\d{1,3})-([a-z0-9][a-z0-9-]{0,80})\.md$/;

/** A numbered doc file name `NNNN-<slug>.md` (groups: number, slug). */
export const NUMBERED_DOC_FILE_RE = /^(\d{1,6})-([A-Za-z0-9][A-Za-z0-9._-]*)\.md$/;

/** The 4-digit code of a doc number. */
export function docNumberCode(n: number): string {
  return String(n).padStart(DOC_NUMBER_DIGITS, "0");
}

/** The spec's Docs section: the selected doc types and the organization text; `numbered` = the numbered ones. */
export interface SpecDocs {
  types: string[];
  org: string;
  /** The types whose files are `NNNN-slug.md` (the built-in defaults, overridden by a doc template's `numbered`). */
  numbered?: string[];
}

/**
 * Read the Docs section of a `project.spec.json` object — `fields: [{id, value}]` or top-level keys; a
 * multiselect value is an array or a comma list. Keys that are not valid doc type keys are dropped; a project's own
 * types are kept. `numbered` starts from the built-in defaults.
 * @adr 0564
 */
export function readSpecDocs(spec: unknown): SpecDocs {
  const o = (spec && typeof spec === "object" ? spec : {}) as Record<string, unknown>;
  const field = (key: string): unknown => {
    if (Array.isArray(o.fields)) {
      const f = (o.fields as unknown[]).find((x) => !!x && typeof x === "object" && (x as { id?: unknown }).id === key) as { value?: unknown } | undefined;
      if (f) return f.value;
    }
    return o[key];
  };
  const raw = field("docs_types");
  const list = Array.isArray(raw) ? raw.map(String) : typeof raw === "string" ? raw.split(",") : [];
  const types = [...new Set(list.map((t) => t.trim()).filter((t) => t in DOC_TYPE_DIRS || DOC_TYPE_KEY_PATTERN.test(t)))];
  const org = field("docs_org");
  return { types, org: typeof org === "string" ? org : "", numbered: types.filter((t) => DOC_NUMBERED_TYPES.includes(t)) };
}

/** The doc type a repo path belongs to (by folder / root file; `docs/<type>/…` for a project's own type), or null. @adr 0564 */
export function docTypeOfPath(path: string): string | null {
  for (const [type, dir] of Object.entries(DOC_TYPE_DIRS)) {
    if (dir.endsWith(".md") ? path === dir : path.startsWith(`${dir}/`)) return type;
  }
  const own = /^docs\/([a-z][a-z0-9-]{1,39})\//.exec(path)?.[1];
  return own ?? null;
}

/** The spec doc template mirror of one type in the repo: `.4pm/doc-templates/<type>/`. @adr 0564 */
export const DOC_TEMPLATES_DIR = ".4pm/doc-templates";

/** `meta.json` of a mirrored spec doc template. @adr 0564 */
export interface DocTemplateMeta {
  name: string;
  description: string;
  numbered: boolean;
  version: number;
  /** File name of the template file in the folder (absent when the template has none). */
  templateFile?: string;
}

/** One file a DOC row produced. */
export interface DocManifestFile {
  path: string;
  /** Spec doc type, or "" for a file outside the declared folders. */
  type: string;
  action: "created" | "updated";
  /** The server-allocated number of a numbered file. */
  number?: number;
}

/** A person's review of one round. */
export interface DocReviewRecord {
  round: number;
  at: string;
  by: string;
  byLabel?: string;
  decision: DocReviewDecision;
  opinion: string;
  /** True when the review decided the round (every review does — the reviewer's decision stands alone). */
  final: boolean;
}

/** The decision of a review. */
export type DocReviewDecision = "proceed" | "revise";

/**
 * One DOC row's state: `pending` (waiting for its next run), `review` (round `round` is done and waits for a
 * person), `accepted` (moved to AI Done; its tasks may run).
 */
export interface DocEntry {
  round: number;
  state: "pending" | "review" | "accepted";
  branch: string;
  /** The DOC branch head at the end of the last round. */
  head?: string;
  files: DocManifestFile[];
  history: DocReviewRecord[];
  /** Files this DOC shares with other open DOC rows (path → their ids), computed at the end of each round. */
  overlaps?: Record<string, string[]>;
  /** The DOC branch's PR into `<base>`, opened once the row is accepted; its group's tasks wait for it. @adr 0563 */
  pr?: DeliveryRecord;
}

/** The docs sidecar: DOC id → entry. */
export type DocsSidecar = Record<string, DocEntry>;

/** Parse the docs sidecar text (`{}` on anything invalid). */
export function parseDocsSidecar(text: string | null | undefined): DocsSidecar {
  try {
    const o = JSON.parse(text || "{}") as unknown;
    if (!o || typeof o !== "object" || Array.isArray(o)) return {};
    const out: DocsSidecar = {};
    for (const [id, v] of Object.entries(o as Record<string, unknown>)) {
      if (!v || typeof v !== "object") continue;
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
      };
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * The decision a round ends with once its last required approval lands: any `revise` among the round's reviews
 * wins over `proceed` (parties of a multi-party approval).
 */
export function roundDecision(entry: DocEntry, round: number): DocReviewDecision | null {
  const recs = entry.history.filter((h) => h.round === round);
  if (!recs.some((h) => h.final)) return null;
  return recs.some((h) => h.decision === "revise") ? "revise" : "proceed";
}

/** Longest review opinion kept. */
export const DOC_OPINION_MAX = 4000;

/**
 * A review submitted with an AI Todo save: the DOC id, the round it reviews (must be the entry's current round in
 * `review`), the decision and the opinion (required when revising).
 * @adr 0536
 */
export const docReviewSchema = z
  .object({
    id: z.string().regex(/^DOC-\d{6}-\d{3}$/),
    round: z.number().int().min(1).max(999),
    decision: z.enum(["proceed", "revise"]),
    opinion: z.string().max(DOC_OPINION_MAX).default(""),
  })
  .refine((r) => r.decision === "proceed" || r.opinion.trim().length > 0, { message: "an opinion is required to revise" });
export type DocReview = z.infer<typeof docReviewSchema>;

/** One request's lineage: where a book group came from. @adr 0537 */
export interface LineageEntry {
  /** The `REQ-…` or intake `QA-…` the group was created from. */
  source: string;
  /** The request text (≤ 500 chars). */
  request: string;
  team?: string;
  at: string;
  /** For a `QA-…` source: the request it came from (resolved through that QA's own group). */
  root?: string;
  /** The request branch's PR (mockups / sequences) into `<base>`; the group's DOC / tasks wait for it. @adr 0563 */
  delivery?: DeliveryRecord;
}

/** The lineage sidecar: group code (`GGGGGG`) → entry. */
export type LineageSidecar = Record<string, LineageEntry>;

/** Longest request text kept in the lineage. */
export const LINEAGE_REQUEST_MAX = 500;

/** Parse the lineage sidecar text (`{}` on anything invalid). */
export function parseLineage(text: string | null | undefined): LineageSidecar {
  try {
    const o = JSON.parse(text || "{}") as unknown;
    if (!o || typeof o !== "object" || Array.isArray(o)) return {};
    const out: LineageSidecar = {};
    for (const [g, v] of Object.entries(o as Record<string, unknown>)) {
      if (!/^\d{6}$/.test(g) || !v || typeof v !== "object") continue;
      const e = v as Partial<LineageEntry>;
      if (typeof e.source !== "string") continue;
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
  } catch {
    return {};
  }
}

/** Most doc numbers one allocation may ask for, per type. */
export const DOC_NUMBERS_PER_TYPE = 50;
