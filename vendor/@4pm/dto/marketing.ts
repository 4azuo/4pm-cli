/**
 * Marketing (Content ▸ Marketing) wire shapes and the pure `SHOTS.md` codec shared by the server, the web and the cli:
 * branch / path names, the set settings front matter, the shot sections, output file names, the run recipe schema and
 * the request / response types of the `marketing-*` API.
 * @adr 0640 @arch 0067
 */
import { z } from "zod";
import { TAG_CODE_RE, TAGS_PER_ITEM_MAX } from "@4pm/constants";
import { baseRequestSchema } from "./base";

/** Root of every marketing file on the marketing branch. */
export const MARKETING_ROOT = ".4pm/marketing";
/** The run recipe path. */
export const MARKETING_RECIPE_PATH = `${MARKETING_ROOT}/run.yaml`;
/** Per-shot approvals sidecar. */
export const MARKETING_APPROVALS_PATH = `${MARKETING_ROOT}/approvals.json`;
/** Per-shot last-writer sidecar. */
export const MARKETING_AUTHORS_PATH = `${MARKETING_ROOT}/authors.json`;

/** Capture drivers of P3a. */
export const MARKETING_DRIVERS = ["web", "electron", "terminal", "api"] as const;
export type MarketingDriver = (typeof MARKETING_DRIVERS)[number];
/** Theme parts an older output file name may carry (themes were replaced by tags — ADR-0648). */
export const MARKETING_THEMES = ["light", "dark"] as const;
export type MarketingTheme = (typeof MARKETING_THEMES)[number];
/** Run kinds. */
export const MARKETING_RUN_KINDS = ["photos", "videos"] as const;
export type MarketingRunKind = (typeof MARKETING_RUN_KINDS)[number];
/** Capture targets. */
export const MARKETING_TARGETS = ["local", "url"] as const;
export type MarketingTarget = (typeof MARKETING_TARGETS)[number];
/** Run states. */
export const MARKETING_RUN_STATUSES = ["queued", "running", "succeeded", "failed"] as const;
export type MarketingRunStatus = (typeof MARKETING_RUN_STATUSES)[number];
/** The shot fields, in `SHOTS.md` order. */
export const MARKETING_SHOT_FIELDS = ["account", "path", "steps", "ready", "expect"] as const;
export type MarketingShotField = (typeof MARKETING_SHOT_FIELDS)[number];

/** A set name: kebab-case, ≤ 40. */
export const MARKETING_SET_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** A shot id. */
export const MARKETING_SHOT_ID_RE = /^SHOT-\d{3,4}$/;
/** A base branch name the API accepts (no `..`, no leading `-` / `/`). */
export const MARKETING_BASE_RE = /^(?!.*\.\.)(?![-/])[A-Za-z0-9._/-]{1,200}$/;
/** A source ref (tag / commit / branch) the API accepts. */
export const MARKETING_REF_RE = /^(?!.*\.\.)(?!-)[A-Za-z0-9._/-]{1,200}$/;
/** A viewport / terminal size, `WxH`. */
export const MARKETING_SIZE_RE = /^\d{2,5}x\d{2,5}$/;
/** A locale tag. */
export const MARKETING_LOCALE_RE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/;
/** An output file name: `<SHOT-id>[.<theme>][.<locale>][.<WxH>].<ext>`. */
export const MARKETING_FILE_RE =
  /^(SHOT-\d{3,4})(?:\.(light|dark))?(?:\.([a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?))?(?:\.(\d{2,5}x\d{2,5}))?\.(png|webp|jpg|jpeg|gif)$/;

/** Size caps. */
export const MARKETING_SHOTS_MAX_BYTES = 256 * 1024;
export const MARKETING_RECIPE_MAX_BYTES = 32 * 1024;
export const MARKETING_ASSET_MAX_BYTES = 20 * 1024 * 1024;
export const MARKETING_RUN_MAX_FILES = 200;
export const MARKETING_SHOTS_MAX = 200;

/** The marketing branch of a base. */
export function marketingBranch(base: string): string {
  return `4pm/marketing/${base}`;
}

/** The `SHOTS.md` path of a photo set. */
export function marketingShotsPath(set: string): string {
  return `${MARKETING_ROOT}/photos/${set}/SHOTS.md`;
}

/** The approval / author key of a shot. */
export function marketingShotKey(set: string, shotId: string): string {
  return `${set}/${shotId}`;
}

/** A photo set's settings (the `SHOTS.md` front matter). */
export interface MarketingSetSettings {
  driver: MarketingDriver;
  viewports: string[];
  locales: string[];
  /** Marketing tag codes — instructions for the AI. @adr 0648 */
  tags: string[];
}

/** One shot of a set. */
export interface MarketingShot {
  id: string;
  title: string;
  fields: Partial<Record<MarketingShotField, string>>;
}

/** A parsed `SHOTS.md`: settings, shots, and the raw text the approval hash covers. */
export interface ParsedMarketingShots {
  settings: MarketingSetSettings;
  shots: (MarketingShot & { section: string })[];
  /** The front matter block as written (between the `---` lines). */
  frontMatter: string;
}

/** A `SHOTS.md` that doesn't parse. */
export class MarketingShotsError extends Error {
  constructor(
    readonly line: number,
    readonly reason: string,
  ) {
    super(`SHOTS.md line ${line}: ${reason}`);
    this.name = "MarketingShotsError";
  }
}

/** Default settings of a new set. */
export const DEFAULT_MARKETING_SET_SETTINGS: MarketingSetSettings = {
  driver: "web",
  viewports: ["1440x900"],
  locales: ["en"],
  tags: [],
};

/** Strip a `#` comment and trim. */
function uncomment(v: string): string {
  const i = v.indexOf(" #");
  return (i >= 0 ? v.slice(0, i) : v.startsWith("#") ? "" : v).trim();
}

/** A front-matter value as a list (`[a, b]` or `a, b` or `a`). */
function listOf(v: string): string[] {
  const inner = v.startsWith("[") && v.endsWith("]") ? v.slice(1, -1) : v;
  return inner
    .split(",")
    .map((x) => x.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

/** Parse the front matter lines into settings. */
function parseSettings(lines: string[], firstLine: number): MarketingSetSettings {
  const out: MarketingSetSettings = { ...DEFAULT_MARKETING_SET_SETTINGS };
  lines.forEach((raw, k) => {
    const line = firstLine + k;
    const text = uncomment(raw);
    if (!text) return;
    const m = /^([a-z]+)\s*:\s*(.*)$/.exec(text);
    if (!m) throw new MarketingShotsError(line, "expected `key: value`");
    const key = m[1]!;
    const value = m[2]!.trim();
    if (key === "driver") {
      if (!(MARKETING_DRIVERS as readonly string[]).includes(value)) throw new MarketingShotsError(line, `unknown driver "${value}"`);
      out.driver = value as MarketingDriver;
    } else if (key === "viewports") {
      const v = listOf(value);
      if (v.length === 0 || v.some((x) => !MARKETING_SIZE_RE.test(x))) throw new MarketingShotsError(line, "viewports must be WxH values");
      out.viewports = v;
    } else if (key === "themes") {
      // Replaced by tags (ADR-0648): an older file's line is read and ignored.
    } else if (key === "tags") {
      const v = listOf(value);
      if (v.length > TAGS_PER_ITEM_MAX || v.some((x) => !TAG_CODE_RE.test(x))) throw new MarketingShotsError(line, "tags must be tag codes");
      out.tags = v;
    } else if (key === "locales") {
      const v = listOf(value);
      if (v.length === 0 || v.some((x) => !MARKETING_LOCALE_RE.test(x))) throw new MarketingShotsError(line, "locales must be language tags");
      out.locales = v;
    } else {
      throw new MarketingShotsError(line, `unknown setting "${key}"`);
    }
  });
  return out;
}

/**
 * Parse a `SHOTS.md`: an optional `---` front matter (driver / viewports / locales / tags), then one
 * `## SHOT-NNN — Title` section per shot with `- field: value` lines. Text that is not a field line is kept in the
 * section (and the hash) but ignored. Throws `MarketingShotsError` on a malformed file.
 */
export function parseMarketingShots(content: string): ParsedMarketingShots {
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  let frontMatter = "";
  let settings = { ...DEFAULT_MARKETING_SET_SETTINGS };
  while (i < lines.length && !lines[i]!.trim()) i++;
  if (lines[i]?.trim() === "---") {
    const start = i + 1;
    let end = start;
    while (end < lines.length && lines[end]!.trim() !== "---") end++;
    if (end >= lines.length) throw new MarketingShotsError(start, "front matter is not closed with ---");
    frontMatter = lines.slice(start, end).join("\n");
    settings = parseSettings(lines.slice(start, end), start + 1);
    i = end + 1;
  }
  const shots: ParsedMarketingShots["shots"] = [];
  const seen = new Set<string>();
  let current: (MarketingShot & { start: number }) | null = null;
  /** Close the open section. */
  const close = (endExclusive: number): void => {
    if (!current) return;
    const section = lines.slice(current.start, endExclusive).join("\n").trim();
    shots.push({ id: current.id, title: current.title, fields: current.fields, section });
    current = null;
  };
  for (; i < lines.length; i++) {
    const raw = lines[i]!;
    const heading = /^##\s+(\S+)\s*(?:[—–-]\s*)?(.*)$/.exec(raw.trim());
    if (heading) {
      close(i);
      const id = heading[1]!;
      if (!MARKETING_SHOT_ID_RE.test(id)) throw new MarketingShotsError(i + 1, `"${id}" is not a shot id (SHOT-NNN)`);
      if (seen.has(id)) throw new MarketingShotsError(i + 1, `duplicate shot id ${id}`);
      seen.add(id);
      current = { id, title: (heading[2] ?? "").trim(), fields: {}, start: i };
      continue;
    }
    if (!current) {
      if (raw.trim() && !raw.trim().startsWith("#") && !raw.trim().startsWith("<!--")) {
        throw new MarketingShotsError(i + 1, "text before the first shot heading");
      }
      continue;
    }
    const field = /^\s*[-*]\s+([a-z]+)\s*:\s*(.*)$/.exec(raw);
    if (field && (MARKETING_SHOT_FIELDS as readonly string[]).includes(field[1]!)) {
      const value = uncomment(field[2]!);
      if (value) (current as MarketingShot).fields[field[1] as MarketingShotField] = value;
    }
  }
  close(lines.length);
  if (shots.length > MARKETING_SHOTS_MAX) throw new MarketingShotsError(1, `more than ${MARKETING_SHOTS_MAX} shots`);
  return { settings, shots, frontMatter };
}

/** One-line field value (a newline would end the field). */
function oneLine(v: string): string {
  return v.replace(/\s*\n\s*/g, " ").trim();
}

/** Write a `SHOTS.md` from settings + shots (the grid's save). */
export function serializeMarketingShots(settings: MarketingSetSettings, shots: MarketingShot[]): string {
  const out = [
    "---",
    `driver: ${settings.driver}`,
    `viewports: [${settings.viewports.join(", ")}]`,
    `locales: [${settings.locales.join(", ")}]`,
    ...(settings.tags.length ? [`tags: [${settings.tags.join(", ")}]`] : []),
    "---",
    "",
  ];
  for (const s of shots) {
    out.push(`## ${s.id}${s.title.trim() ? ` — ${oneLine(s.title)}` : ""}`);
    for (const f of MARKETING_SHOT_FIELDS) {
      const v = s.fields[f];
      if (v && v.trim()) out.push(`- ${f}: ${oneLine(v)}`);
    }
    out.push("");
  }
  return out.join("\n");
}

/** The text an approval hash covers: the set settings + the shot's section. The hash is SHA-256 hex of it. */
export function marketingShotHashInput(frontMatter: string, section: string): string {
  return `${frontMatter.trim()}\n---\n${section.trim()}`;
}

/** The next free shot id of a set. */
export function nextMarketingShotId(shots: readonly { id: string }[]): string {
  const max = shots.reduce((m, s) => Math.max(m, Number(/^SHOT-(\d+)$/.exec(s.id)?.[1] ?? 0)), 0);
  return `SHOT-${String(max + 1).padStart(3, "0")}`;
}

/** Facts read from an output file name, or null when it doesn't follow the rule. */
export function parseMarketingFileName(
  name: string,
): { shotId: string; theme: MarketingTheme | null; locale: string | null; size: string | null; ext: string } | null {
  const m = MARKETING_FILE_RE.exec(name);
  if (!m) return null;
  return { shotId: m[1]!, theme: (m[2] as MarketingTheme | undefined) ?? null, locale: m[3] ?? null, size: m[4] ?? null, ext: m[5]! };
}

/** The run recipe (`run.yaml`), after YAML parsing. */
export const marketingRecipeSchema = z
  .object({
    workdir: z.string().max(300).regex(/^(?!\/)(?!.*\.\.)[^\0]*$/, "relative path without ..").default("."),
    install: z.string().max(2000).optional(),
    build: z.string().max(2000).optional(),
    start: z.string().min(1).max(2000),
    url: z.string().url().max(500),
    ready: z
      .object({
        url: z.string().url().max(500).optional(),
        log: z.string().min(1).max(200).optional(),
        timeoutSec: z.number().int().min(10).max(1800).default(180),
      })
      .refine((r) => Boolean(r.url) !== Boolean(r.log), "ready needs exactly one of url / log"),
    seed: z.string().max(2000).optional(),
    env: z.record(z.string().regex(/^[A-Z_][A-Z0-9_]{0,63}$/), z.string().max(2000)).default({}),
  })
  .strict();
export type MarketingRecipe = z.infer<typeof marketingRecipeSchema>;

/** A starter recipe the settings editor offers. */
export const MARKETING_RECIPE_TEMPLATE = `workdir: .
install: npm ci
build: npm run build
start: npm start
url: http://127.0.0.1:3000
ready:
  url: http://127.0.0.1:3000
  timeoutSec: 180
# seed: npm run db:seed
env:
  NODE_ENV: production
  # DATABASE_URL: secret:MARKETING_DATABASE_URL
`;

const baseField = z.string().regex(MARKETING_BASE_RE).optional();

/** `?base=` of the marketing reads. @api marketing-0001 */
export const marketingBaseQuerySchema = z.object({ base: baseField });
export type MarketingBaseQuery = z.infer<typeof marketingBaseQuerySchema>;

/** Save a set's `SHOTS.md`. @api marketing-0003 */
export const marketingPutShotsSchema = z.object({
  base: baseField,
  content: z.string().min(1).max(MARKETING_SHOTS_MAX_BYTES),
  baseSha: z.string().regex(/^[0-9a-f]{40,64}$/).nullable(),
});
export type MarketingPutShotsRequest = z.infer<typeof marketingPutShotsSchema>;

/** Delete a set. @api marketing-0004 */
export const marketingDeleteSetSchema = z.object({ base: baseField, baseSha: z.string().regex(/^[0-9a-f]{40,64}$/) });

/** Approve / unapprove shots. @api marketing-0005 */
export const marketingApproveSchema = z.object({
  base: baseField,
  approve: z.array(z.object({ id: z.string().regex(MARKETING_SHOT_ID_RE), hash: z.string().regex(/^[0-9a-f]{64}$/) })).max(MARKETING_SHOTS_MAX).default([]),
  unapprove: z.array(z.string().regex(MARKETING_SHOT_ID_RE)).max(MARKETING_SHOTS_MAX).default([]),
});
export type MarketingApproveRequest = z.infer<typeof marketingApproveSchema>;

/** Save the run recipe. @api marketing-0006 */
export const marketingPutRecipeSchema = z.object({
  base: baseField,
  content: z.string().min(1).max(MARKETING_RECIPE_MAX_BYTES),
  baseSha: z.string().regex(/^[0-9a-f]{40,64}$/).nullable(),
});
export type MarketingPutRecipeRequest = z.infer<typeof marketingPutRecipeSchema>;

/** AI compose of shots. @api marketing-0007 */
export const marketingComposeSchema = z.object({
  base: baseField,
  brief: z.string().trim().min(1).max(4000),
  driver: z.enum(MARKETING_DRIVERS),
  /** The set's tags as in the editor (may be unsaved). @adr 0648 */
  tags: z.array(z.string().regex(TAG_CODE_RE)).max(TAGS_PER_ITEM_MAX).default([]),
});
export type MarketingComposeRequest = z.infer<typeof marketingComposeSchema>;

/** Generate photos. @api marketing-0008 */
export const marketingGenerateSchema = z.object({
  base: baseField,
  sourceRef: z.string().regex(MARKETING_REF_RE).optional(),
});
export type MarketingGenerateRequest = z.infer<typeof marketingGenerateSchema>;

/** List runs. @api marketing-0009 */
export const marketingRunsQuerySchema = baseRequestSchema.extend({
  kind: z.enum(MARKETING_RUN_KINDS).optional(),
  base: baseField,
  set: z.string().regex(MARKETING_SET_RE).optional(),
});
export type MarketingRunsQuery = z.infer<typeof marketingRunsQuerySchema>;

/** Pin / unpin a run. @api marketing-0013 */
export const marketingRunPatchSchema = z.object({ pinned: z.boolean() });

/** Languages suggested in the "languages the app supports" picker (any language tag is accepted). @adr 0645 */
export const MARKETING_LOCALE_SUGGESTIONS = ["en", "vi", "ja", "zh", "ko", "fr", "de", "es", "pt-BR", "zh-TW", "th", "id"] as const;
/** Most languages a project can declare. */
export const MARKETING_LOCALES_MAX = 20;

/** Marketing settings; `locales` = the video subtitle languages (photos are taken in each). @api marketing-0015 @adr 0645 @adr 0648 */
export const marketingSettingsSchema = z
  .object({
    keepRuns: z.number().int().min(1).max(20),
    captureTarget: z.enum(MARKETING_TARGETS),
    targetUrl: z.string().url().max(500).regex(/^https?:\/\//).nullable().default(null),
    locales: z.array(z.string().regex(MARKETING_LOCALE_RE)).min(1).max(MARKETING_LOCALES_MAX).default(["en"]),
  });
export type MarketingSettings = z.infer<typeof marketingSettingsSchema>;

/** Settings when a project never saved any. */
export const DEFAULT_MARKETING_SETTINGS: MarketingSettings = {
  keepRuns: 3,
  captureTarget: "local",
  targetUrl: null,
  locales: ["en"],
};

/** Who did something to a shot. */
export interface MarketingStamp {
  by: string;
  byLabel: string;
  at: string;
}

/** A set in the overview. */
export interface MarketingSetSummary {
  set: string;
  driver: MarketingDriver;
  shots: number;
  approved: number;
}

/** `GET /projects/:id/marketing`. @api marketing-0001 */
export interface MarketingOverviewResponse {
  base: string;
  bases: string[];
  branchExists: boolean;
  sets: MarketingSetSummary[];
  recipe: { content: string; sha: string } | null;
  settings: MarketingSettings;
  photosEnabled: boolean;
  /** Plan `marketingVideo`. @adr 0646 */
  videosEnabled: boolean;
  /** The base's videos. @adr 0646 */
  videos: { video: string; scenes: number; approved: number }[];
  /** When the base has no scene branch: the bases whose scenes it can copy. @adr 0646 */
  copyFrom: string[];
}

/** Create a base's scenes from another base's. @api marketing-0018 @adr 0646 */
export const marketingCopySchema = z.object({
  from: z.string().regex(MARKETING_BASE_RE),
  to: z.string().regex(MARKETING_BASE_RE),
});
export type MarketingCopyRequest = z.infer<typeof marketingCopySchema>;

/**
 * Feature tools a capture driver needs that a worker can't install itself (only detected): Xvfb for Electron on Linux,
 * the terminal tools when no prebuilt binary exists there. @adr 0646
 */
export const MARKETING_DRIVER_TOOLS: Record<MarketingDriver, readonly string[]> = {
  web: [],
  api: [],
  electron: ["xvfb"],
  terminal: ["vhs", "ttyd", "ffmpeg"],
};

/**
 * The tools a worker misses for a driver, from its reported feature tools: rows that are not installed and can only be
 * detected (`source: "detect"`). `null` when the worker reports no feature tools (an older cli — unknown).
 */
export function marketingMissingTools(
  driver: MarketingDriver,
  features: readonly { id: string; installed: boolean; source: string }[] | undefined,
): string[] | null {
  if (!features) return null;
  const need = MARKETING_DRIVER_TOOLS[driver];
  return features.filter((f) => need.includes(f.id) && !f.installed && f.source === "detect").map((f) => f.id);
}

/** A shot as the grid shows it. */
export interface MarketingShotView extends MarketingShot {
  hash: string;
  approved: MarketingStamp | null;
  writtenBy: MarketingStamp | null;
}

/** `GET /projects/:id/marketing/photos/:set`. @api marketing-0002 */
export interface MarketingSetResponse {
  set: string;
  content: string;
  sha: string;
  settings: MarketingSetSettings;
  shots: MarketingShotView[];
}

/** A run. @api marketing-0009 */
export interface MarketingRunResponse {
  id: string;
  kind: MarketingRunKind;
  base: string;
  /** The photo set, or the video of a video run. */
  set: string;
  /** The capture driver; `video` on a video run. */
  driver: MarketingDriver | "video";
  target: MarketingTarget;
  sourceRef: string | null;
  sourceSha: string | null;
  commitSha: string | null;
  status: MarketingRunStatus;
  errorCode: string | null;
  error: string | null;
  commandId: string | null;
  pinned: boolean;
  files: number;
  bytes: number;
  requestedBy: string;
  requestedByLabel: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

/** One output file. @api marketing-0010 */
export interface MarketingAssetResponse {
  id: string;
  file: string;
  shotId: string;
  theme: MarketingTheme | null;
  locale: string | null;
  size: string | null;
  mime: string;
  bytes: number;
  width: number | null;
  height: number | null;
  /** Video length (mp4 only). @adr 0646 */
  durationMs: number | null;
}

/** A run with its files. @api marketing-0010 */
export interface MarketingRunDetailResponse extends MarketingRunResponse {
  assets: MarketingAssetResponse[];
}

/** `POST …/generate`. @api marketing-0008 */
export interface MarketingGenerateResponse {
  runId: string;
  commandId: string;
}

/** `POST /machine-links/marketing/uploads/:runId`. @api marketing-0016 */
export interface MarketingUploadResponse {
  assetId: string;
}

/** The worker's final report line of a run: `<marketing-run>{json}</marketing-run>`. */
export interface MarketingRunReport {
  ok: boolean;
  shots: number;
  files: number;
  sourceSha: string | null;
  commitSha: string | null;
  code?: string;
  error?: string;
}

/** The worker's report body. @api marketing-0017 */
export const marketingRunReportSchema = z.object({
  ok: z.boolean(),
  shots: z.number().int().min(0).max(10_000),
  files: z.number().int().min(0).max(10_000),
  sourceSha: z.string().regex(/^[0-9a-f]{7,64}$/).nullable(),
  commitSha: z.string().regex(/^[0-9a-f]{7,64}$/).nullable(),
  code: z.string().max(64).optional(),
  error: z.string().max(4000).optional(),
});

/** The report tag the worker prints and the result sink reads. */
export const MARKETING_RUN_TAG = "marketing-run";
/** The compose answer tag. */
export const MARKETING_SHOTS_TAG = "marketing-shots";

/** Read the last `<marketing-run>` report in a run's output, or null. */
export function readMarketingRunReport(output: string): MarketingRunReport | null {
  const re = new RegExp(`<${MARKETING_RUN_TAG}>([\\s\\S]*?)</${MARKETING_RUN_TAG}>`, "g");
  let last: string | null = null;
  for (let m = re.exec(output); m; m = re.exec(output)) last = m[1] ?? null;
  if (!last) return null;
  try {
    const v = JSON.parse(last) as MarketingRunReport;
    return typeof v.ok === "boolean" ? v : null;
  } catch {
    return null;
  }
}
