/**
 * Vendored from @4pm/dto (marketing.ts) by scripts/vendor-shared.mjs — do not edit.
 */
import { z } from "zod";
import { TAG_CODE_RE, TAGS_PER_ITEM_MAX } from "@4pm/shared-constants";
import { baseRequestSchema } from "./base";
export const MARKETING_ROOT = ".4pm/marketing";
export const MARKETING_RECIPE_PATH = `${MARKETING_ROOT}/run.yaml`;
export const MARKETING_APPROVALS_PATH = `${MARKETING_ROOT}/approvals.json`;
export const MARKETING_AUTHORS_PATH = `${MARKETING_ROOT}/authors.json`;
export const MARKETING_DRIVERS = ["web", "electron", "terminal", "api"] as const;
export type MarketingDriver = (typeof MARKETING_DRIVERS)[number];
export const MARKETING_THEMES = ["light", "dark"] as const;
export type MarketingTheme = (typeof MARKETING_THEMES)[number];
export const MARKETING_RUN_KINDS = ["photos", "videos"] as const;
export type MarketingRunKind = (typeof MARKETING_RUN_KINDS)[number];
export const MARKETING_TARGETS = ["local", "url"] as const;
export type MarketingTarget = (typeof MARKETING_TARGETS)[number];
export const MARKETING_RUN_STATUSES = ["queued", "running", "succeeded", "failed"] as const;
export type MarketingRunStatus = (typeof MARKETING_RUN_STATUSES)[number];
export const MARKETING_SHOT_FIELDS = ["account", "path", "steps", "ready", "expect"] as const;
export type MarketingShotField = (typeof MARKETING_SHOT_FIELDS)[number];
export const MARKETING_SET_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const MARKETING_SHOT_ID_RE = /^SHOT-\d{3,4}$/;
export const MARKETING_BASE_RE = /^(?!.*\.\.)(?![-/])[A-Za-z0-9._/-]{1,200}$/;
export const MARKETING_REF_RE = /^(?!.*\.\.)(?!-)[A-Za-z0-9._/-]{1,200}$/;
export const MARKETING_SIZE_RE = /^\d{2,5}x\d{2,5}$/;
export const MARKETING_LOCALE_RE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/;
export const MARKETING_FILE_RE = /^(SHOT-\d{3,4})(?:\.(light|dark))?(?:\.([a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?))?(?:\.(\d{2,5}x\d{2,5}))?\.(png|webp|jpg|jpeg|gif)$/;
export const MARKETING_SHOTS_MAX_BYTES = 256 * 1024;
export const MARKETING_RECIPE_MAX_BYTES = 32 * 1024;
export const MARKETING_ASSET_MAX_BYTES = 20 * 1024 * 1024;
export const MARKETING_RUN_MAX_FILES = 200;
export const MARKETING_SHOTS_MAX = 200;
export function marketingBranch(base: string): string {
    return `4pm/marketing/${base}`;
}
export function marketingShotsPath(set: string): string {
    return `${MARKETING_ROOT}/photos/${set}/SHOTS.md`;
}
export function marketingShotKey(set: string, shotId: string): string {
    return `${set}/${shotId}`;
}
export interface MarketingSetSettings {
    driver: MarketingDriver;
    viewports: string[];
    locales: string[];
    tags: string[];
}
export interface MarketingShot {
    id: string;
    title: string;
    fields: Partial<Record<MarketingShotField, string>>;
}
export interface ParsedMarketingShots {
    settings: MarketingSetSettings;
    shots: (MarketingShot & {
        section: string;
    })[];
    frontMatter: string;
}
export class MarketingShotsError extends Error {
    constructor(readonly line: number, readonly reason: string) {
        super(`SHOTS.md line ${line}: ${reason}`);
        this.name = "MarketingShotsError";
    }
}
export const DEFAULT_MARKETING_SET_SETTINGS: MarketingSetSettings = {
    driver: "web",
    viewports: ["1440x900"],
    locales: ["en"],
    tags: [],
};
function uncomment(v: string): string {
    const i = v.indexOf(" #");
    return (i >= 0 ? v.slice(0, i) : v.startsWith("#") ? "" : v).trim();
}
function listOf(v: string): string[] {
    const inner = v.startsWith("[") && v.endsWith("]") ? v.slice(1, -1) : v;
    return inner
        .split(",")
        .map((x) => x.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
}
function parseSettings(lines: string[], firstLine: number): MarketingSetSettings {
    const out: MarketingSetSettings = { ...DEFAULT_MARKETING_SET_SETTINGS };
    lines.forEach((raw, k) => {
        const line = firstLine + k;
        const text = uncomment(raw);
        if (!text)
            return;
        const m = /^([a-z]+)\s*:\s*(.*)$/.exec(text);
        if (!m)
            throw new MarketingShotsError(line, "expected `key: value`");
        const key = m[1]!;
        const value = m[2]!.trim();
        if (key === "driver") {
            if (!(MARKETING_DRIVERS as readonly string[]).includes(value))
                throw new MarketingShotsError(line, `unknown driver "${value}"`);
            out.driver = value as MarketingDriver;
        }
        else if (key === "viewports") {
            const v = listOf(value);
            if (v.length === 0 || v.some((x) => !MARKETING_SIZE_RE.test(x)))
                throw new MarketingShotsError(line, "viewports must be WxH values");
            out.viewports = v;
        }
        else if (key === "themes") {
        }
        else if (key === "tags") {
            const v = listOf(value);
            if (v.length > TAGS_PER_ITEM_MAX || v.some((x) => !TAG_CODE_RE.test(x)))
                throw new MarketingShotsError(line, "tags must be tag codes");
            out.tags = v;
        }
        else if (key === "locales") {
            const v = listOf(value);
            if (v.length === 0 || v.some((x) => !MARKETING_LOCALE_RE.test(x)))
                throw new MarketingShotsError(line, "locales must be language tags");
            out.locales = v;
        }
        else {
            throw new MarketingShotsError(line, `unknown setting "${key}"`);
        }
    });
    return out;
}
export function parseMarketingShots(content: string): ParsedMarketingShots {
    const lines = content.replace(/\r\n?/g, "\n").split("\n");
    let i = 0;
    let frontMatter = "";
    let settings = { ...DEFAULT_MARKETING_SET_SETTINGS };
    while (i < lines.length && !lines[i]!.trim())
        i++;
    if (lines[i]?.trim() === "---") {
        const start = i + 1;
        let end = start;
        while (end < lines.length && lines[end]!.trim() !== "---")
            end++;
        if (end >= lines.length)
            throw new MarketingShotsError(start, "front matter is not closed with ---");
        frontMatter = lines.slice(start, end).join("\n");
        settings = parseSettings(lines.slice(start, end), start + 1);
        i = end + 1;
    }
    const shots: ParsedMarketingShots["shots"] = [];
    const seen = new Set<string>();
    let current: (MarketingShot & {
        start: number;
    }) | null = null;
    const close = (endExclusive: number): void => {
        if (!current)
            return;
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
            if (!MARKETING_SHOT_ID_RE.test(id))
                throw new MarketingShotsError(i + 1, `"${id}" is not a shot id (SHOT-NNN)`);
            if (seen.has(id))
                throw new MarketingShotsError(i + 1, `duplicate shot id ${id}`);
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
            if (value)
                (current as MarketingShot).fields[field[1] as MarketingShotField] = value;
        }
    }
    close(lines.length);
    if (shots.length > MARKETING_SHOTS_MAX)
        throw new MarketingShotsError(1, `more than ${MARKETING_SHOTS_MAX} shots`);
    return { settings, shots, frontMatter };
}
function oneLine(v: string): string {
    return v.replace(/\s*\n\s*/g, " ").trim();
}
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
            if (v && v.trim())
                out.push(`- ${f}: ${oneLine(v)}`);
        }
        out.push("");
    }
    return out.join("\n");
}
export function marketingShotHashInput(frontMatter: string, section: string): string {
    return `${frontMatter.trim()}\n---\n${section.trim()}`;
}
export function nextMarketingShotId(shots: readonly {
    id: string;
}[]): string {
    const max = shots.reduce((m, s) => Math.max(m, Number(/^SHOT-(\d+)$/.exec(s.id)?.[1] ?? 0)), 0);
    return `SHOT-${String(max + 1).padStart(3, "0")}`;
}
export function parseMarketingFileName(name: string): {
    shotId: string;
    theme: MarketingTheme | null;
    locale: string | null;
    size: string | null;
    ext: string;
} | null {
    const m = MARKETING_FILE_RE.exec(name);
    if (!m)
        return null;
    return { shotId: m[1]!, theme: (m[2] as MarketingTheme | undefined) ?? null, locale: m[3] ?? null, size: m[4] ?? null, ext: m[5]! };
}
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
export const marketingBaseQuerySchema = z.object({ base: baseField });
export type MarketingBaseQuery = z.infer<typeof marketingBaseQuerySchema>;
export const marketingPutShotsSchema = z.object({
    base: baseField,
    content: z.string().min(1).max(MARKETING_SHOTS_MAX_BYTES),
    baseSha: z.string().regex(/^[0-9a-f]{40,64}$/).nullable(),
});
export type MarketingPutShotsRequest = z.infer<typeof marketingPutShotsSchema>;
export const marketingDeleteSetSchema = z.object({ base: baseField, baseSha: z.string().regex(/^[0-9a-f]{40,64}$/) });
export const marketingApproveSchema = z.object({
    base: baseField,
    approve: z.array(z.object({ id: z.string().regex(MARKETING_SHOT_ID_RE), hash: z.string().regex(/^[0-9a-f]{64}$/) })).max(MARKETING_SHOTS_MAX).default([]),
    unapprove: z.array(z.string().regex(MARKETING_SHOT_ID_RE)).max(MARKETING_SHOTS_MAX).default([]),
});
export type MarketingApproveRequest = z.infer<typeof marketingApproveSchema>;
export const marketingPutRecipeSchema = z.object({
    base: baseField,
    content: z.string().min(1).max(MARKETING_RECIPE_MAX_BYTES),
    baseSha: z.string().regex(/^[0-9a-f]{40,64}$/).nullable(),
});
export type MarketingPutRecipeRequest = z.infer<typeof marketingPutRecipeSchema>;
export const marketingComposeSchema = z.object({
    base: baseField,
    brief: z.string().trim().min(1).max(4000),
    driver: z.enum(MARKETING_DRIVERS),
    tags: z.array(z.string().regex(TAG_CODE_RE)).max(TAGS_PER_ITEM_MAX).default([]),
});
export type MarketingComposeRequest = z.infer<typeof marketingComposeSchema>;
export const marketingGenerateSchema = z.object({
    base: baseField,
    sourceRef: z.string().regex(MARKETING_REF_RE).optional(),
});
export type MarketingGenerateRequest = z.infer<typeof marketingGenerateSchema>;
export const marketingRunsQuerySchema = baseRequestSchema.extend({
    kind: z.enum(MARKETING_RUN_KINDS).optional(),
    base: baseField,
    set: z.string().regex(MARKETING_SET_RE).optional(),
});
export type MarketingRunsQuery = z.infer<typeof marketingRunsQuerySchema>;
export const marketingRunPatchSchema = z.object({ pinned: z.boolean() });
export const MARKETING_LOCALE_SUGGESTIONS = ["en", "vi", "ja", "zh", "ko", "fr", "de", "es", "pt-BR", "zh-TW", "th", "id"] as const;
export const MARKETING_LOCALES_MAX = 20;
export const marketingSettingsSchema = z
    .object({
    keepRuns: z.number().int().min(1).max(20),
    captureTarget: z.enum(MARKETING_TARGETS),
    targetUrl: z.string().url().max(500).regex(/^https?:\/\//).nullable().default(null),
    locales: z.array(z.string().regex(MARKETING_LOCALE_RE)).min(1).max(MARKETING_LOCALES_MAX).default(["en"]),
});
export type MarketingSettings = z.infer<typeof marketingSettingsSchema>;
export const DEFAULT_MARKETING_SETTINGS: MarketingSettings = {
    keepRuns: 3,
    captureTarget: "local",
    targetUrl: null,
    locales: ["en"],
};
export interface MarketingStamp {
    by: string;
    byLabel: string;
    at: string;
}
export interface MarketingSetSummary {
    set: string;
    driver: MarketingDriver;
    shots: number;
    approved: number;
}
export interface MarketingOverviewResponse {
    base: string;
    bases: string[];
    branchExists: boolean;
    sets: MarketingSetSummary[];
    recipe: {
        content: string;
        sha: string;
    } | null;
    settings: MarketingSettings;
    photosEnabled: boolean;
    videosEnabled: boolean;
    videos: {
        video: string;
        scenes: number;
        approved: number;
    }[];
    copyFrom: string[];
}
export const marketingCopySchema = z.object({
    from: z.string().regex(MARKETING_BASE_RE),
    to: z.string().regex(MARKETING_BASE_RE),
});
export type MarketingCopyRequest = z.infer<typeof marketingCopySchema>;
export const MARKETING_DRIVER_TOOLS: Record<MarketingDriver, readonly string[]> = {
    web: [],
    api: [],
    electron: ["xvfb"],
    terminal: ["vhs", "ttyd", "ffmpeg"],
};
export function marketingMissingTools(driver: MarketingDriver, features: readonly {
    id: string;
    installed: boolean;
    source: string;
}[] | undefined): string[] | null {
    if (!features)
        return null;
    const need = MARKETING_DRIVER_TOOLS[driver];
    return features.filter((f) => need.includes(f.id) && !f.installed && f.source === "detect").map((f) => f.id);
}
export interface MarketingShotView extends MarketingShot {
    hash: string;
    approved: MarketingStamp | null;
    writtenBy: MarketingStamp | null;
}
export interface MarketingSetResponse {
    set: string;
    content: string;
    sha: string;
    settings: MarketingSetSettings;
    shots: MarketingShotView[];
}
export interface MarketingRunResponse {
    id: string;
    kind: MarketingRunKind;
    base: string;
    set: string;
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
    durationMs: number | null;
}
export interface MarketingRunDetailResponse extends MarketingRunResponse {
    assets: MarketingAssetResponse[];
}
export interface MarketingGenerateResponse {
    runId: string;
    commandId: string;
}
export interface MarketingUploadResponse {
    assetId: string;
}
export interface MarketingRunReport {
    ok: boolean;
    shots: number;
    files: number;
    sourceSha: string | null;
    commitSha: string | null;
    code?: string;
    error?: string;
}
export const marketingRunReportSchema = z.object({
    ok: z.boolean(),
    shots: z.number().int().min(0).max(10000),
    files: z.number().int().min(0).max(10000),
    sourceSha: z.string().regex(/^[0-9a-f]{7,64}$/).nullable(),
    commitSha: z.string().regex(/^[0-9a-f]{7,64}$/).nullable(),
    code: z.string().max(64).optional(),
    error: z.string().max(4000).optional(),
});
export const MARKETING_RUN_TAG = "marketing-run";
export const MARKETING_SHOTS_TAG = "marketing-shots";
export function readMarketingRunReport(output: string): MarketingRunReport | null {
    const re = new RegExp(`<${MARKETING_RUN_TAG}>([\\s\\S]*?)</${MARKETING_RUN_TAG}>`, "g");
    let last: string | null = null;
    for (let m = re.exec(output); m; m = re.exec(output))
        last = m[1] ?? null;
    if (!last)
        return null;
    try {
        const v = JSON.parse(last) as MarketingRunReport;
        return typeof v.ok === "boolean" ? v : null;
    }
    catch {
        return null;
    }
}
