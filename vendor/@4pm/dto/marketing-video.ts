/**
 * Marketing videos (Content ▸ Marketing ▸ Videos) — the pure `SCENES.md` codec shared by the server, the web and the
 * cli (front matter: size, fps, locales, soundtrack, audio, the photo run chosen per set; one `## SCENE-NNN` section per
 * scene; `tags:` = marketing tag codes for the AI), video output file names, caps, the project's Remotion state and the
 * request / response types of the video API.
 * @adr 0646 @adr 0648 @arch 0067
 */
import { z } from "zod";
import { TAG_CODE_RE, TAGS_PER_ITEM_MAX } from "@4pm/constants";
import { MARKETING_LOCALE_RE, MARKETING_ROOT, MARKETING_SET_RE, MARKETING_SIZE_RE, MARKETING_SHOT_ID_RE, type MarketingStamp } from "./marketing";

/** A video name: kebab-case, ≤ 40 (the same rule as a photo set). */
export const MARKETING_VIDEO_RE = MARKETING_SET_RE;
/** A scene id. */
export const MARKETING_SCENE_ID_RE = /^SCENE-\d{3,4}$/;
/** A shot reference of a scene: `<set>/<SHOT-id>`. */
export const MARKETING_SHOT_REF_RE = /^([a-z0-9][a-z0-9-]{0,39})\/(SHOT-\d{3,4})$/;
/** Scene transitions. */
export const MARKETING_TRANSITIONS = ["fade", "slide", "zoom", "cut"] as const;
export type MarketingTransition = (typeof MARKETING_TRANSITIONS)[number];
/** Soundtrack modes. */
export const MARKETING_SOUNDTRACKS = ["synth", "uploaded", "none"] as const;
export type MarketingSoundtrack = (typeof MARKETING_SOUNDTRACKS)[number];
/** Music cues the synthesized soundtrack knows. */
export const MARKETING_CUES = ["intro", "build", "drop", "calm", "outro"] as const;
/** An uploaded audio id. */
export const MARKETING_AUDIO_ID_RE = /^AUD-[0-9a-f]{12}$/;
/** The compose answer tag of video scenes. */
export const MARKETING_SCENES_TAG = "marketing-scenes";
/** A video output file: `<video>.<locale>.mp4` or `<video>.<locale>.poster.jpg`. */
export const MARKETING_VIDEO_FILE_RE = /^([a-z0-9][a-z0-9-]{0,39})\.([a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?)\.(mp4|poster\.jpg)$/;

/** Caps. */
export const MARKETING_SCENES_MAX = 60;
export const MARKETING_SCENES_MAX_BYTES = 256 * 1024;
export const MARKETING_VIDEO_MAX_BYTES = 500 * 1024 * 1024;
export const MARKETING_POSTER_MAX_BYTES = 20 * 1024 * 1024;
export const MARKETING_VIDEO_RUN_MAX_FILES = 50;
export const MARKETING_SCENE_MIN_SEC = 1;
export const MARKETING_SCENE_MAX_SEC = 60;
/** The official 4pm-public item the cli scaffolds a video's Remotion project from. */
export const MARKETING_VIDEO_TEMPLATE = { kind: "script", slug: "marketing-video-template" } as const;

/** The `SCENES.md` path of a video. */
export function marketingScenesPath(video: string): string {
  return `${MARKETING_ROOT}/videos/${video}/SCENES.md`;
}

/** The approval / author key of a scene (never clashes with a shot key `<set>/<SHOT-id>`). */
export function marketingSceneKey(video: string, sceneId: string): string {
  return `videos/${video}/${sceneId}`;
}

/** A video's settings (the `SCENES.md` front matter). */
export interface MarketingVideoSettings {
  /** Output frame, `WxH`. */
  size: string;
  fps: number;
  locales: string[];
  soundtrack: MarketingSoundtrack;
  /** Uploaded audio ids (soundtrack `uploaded`). */
  audio: string[];
  /** The photo run chosen per set (`set → runId`); a set absent here uses its newest succeeded run. */
  photos: Record<string, string>;
  /** Marketing tag codes — instructions for the AI. @adr 0648 */
  tags: string[];
}

/** One scene of a video. */
export interface MarketingScene {
  id: string;
  title: string;
  /** Seconds. */
  duration: number;
  /** `<set>/<SHOT-id>` references. */
  shots: string[];
  /** Caption per locale. */
  captions: Record<string, string>;
  transition: MarketingTransition;
  cue: string | null;
}

/** A parsed `SCENES.md`. */
export interface ParsedMarketingScenes {
  settings: MarketingVideoSettings;
  scenes: (MarketingScene & { section: string })[];
  /** The front matter as written. */
  frontMatter: string;
}

/** A `SCENES.md` that doesn't parse. */
export class MarketingScenesError extends Error {
  constructor(
    readonly line: number,
    readonly reason: string,
  ) {
    super(`SCENES.md line ${line}: ${reason}`);
    this.name = "MarketingScenesError";
  }
}

/** Default settings of a new video. */
export const DEFAULT_MARKETING_VIDEO_SETTINGS: MarketingVideoSettings = {
  size: "1920x1080",
  fps: 30,
  locales: ["en"],
  soundtrack: "synth",
  audio: [],
  photos: {},
  tags: [],
};

/** Strip a ` #` comment and trim. */
function uncomment(v: string): string {
  const i = v.indexOf(" #");
  return (i >= 0 ? v.slice(0, i) : v.startsWith("#") ? "" : v).trim();
}

/** A front-matter value as a list (`[a, b]`, `a, b` or `a`). */
function listOf(v: string): string[] {
  const inner = v.startsWith("[") && v.endsWith("]") ? v.slice(1, -1) : v;
  return inner
    .split(",")
    .map((x) => x.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

/** A front-matter value as a flat map (`{ a: b, c: d }`). */
function mapOf(v: string, line: number): Record<string, string> {
  const inner = v.trim();
  if (inner === "" || inner === "{}") return {};
  if (!inner.startsWith("{") || !inner.endsWith("}")) throw new MarketingScenesError(line, "photos must be { set: runId, … }");
  const out: Record<string, string> = {};
  for (const pair of inner.slice(1, -1).split(",")) {
    if (!pair.trim()) continue;
    const m = /^\s*([a-z0-9][a-z0-9-]{0,39})\s*:\s*([0-9a-f-]{36})\s*$/.exec(pair);
    if (!m) throw new MarketingScenesError(line, `bad photos entry "${pair.trim()}"`);
    out[m[1]!] = m[2]!;
  }
  return out;
}

/** Parse the front matter lines. */
function parseSettings(lines: string[], firstLine: number): MarketingVideoSettings {
  const out: MarketingVideoSettings = { ...DEFAULT_MARKETING_VIDEO_SETTINGS, audio: [], photos: {}, tags: [] };
  lines.forEach((raw, k) => {
    const line = firstLine + k;
    const text = uncomment(raw);
    if (!text) return;
    const m = /^([a-z]+)\s*:\s*(.*)$/.exec(text);
    if (!m) throw new MarketingScenesError(line, "expected `key: value`");
    const key = m[1]!;
    const value = m[2]!.trim();
    if (key === "size") {
      if (!MARKETING_SIZE_RE.test(value)) throw new MarketingScenesError(line, "size must be WxH");
      out.size = value;
    } else if (key === "fps") {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 12 || n > 60) throw new MarketingScenesError(line, "fps must be 12–60");
      out.fps = n;
    } else if (key === "locales") {
      const v = listOf(value);
      if (v.length === 0 || v.some((x) => !MARKETING_LOCALE_RE.test(x))) throw new MarketingScenesError(line, "locales must be language tags");
      out.locales = v;
    } else if (key === "soundtrack") {
      if (!(MARKETING_SOUNDTRACKS as readonly string[]).includes(value)) throw new MarketingScenesError(line, "soundtrack must be synth / uploaded / none");
      out.soundtrack = value as MarketingSoundtrack;
    } else if (key === "audio") {
      const v = listOf(value);
      if (v.some((x) => !MARKETING_AUDIO_ID_RE.test(x))) throw new MarketingScenesError(line, "audio must be AUD-… ids");
      out.audio = v;
    } else if (key === "tags") {
      const v = listOf(value);
      if (v.length > TAGS_PER_ITEM_MAX || v.some((x) => !TAG_CODE_RE.test(x))) throw new MarketingScenesError(line, "tags must be tag codes");
      out.tags = v;
    } else if (key === "photos") {
      out.photos = mapOf(value, line);
    } else {
      throw new MarketingScenesError(line, `unknown setting "${key}"`);
    }
  });
  return out;
}

/** Seconds from `4`, `4s` or `4.5s`. */
function seconds(v: string, line: number): number {
  const m = /^(\d+(?:\.\d+)?)\s*s?$/.exec(v);
  const n = m ? Number(m[1]) : NaN;
  if (!(n >= MARKETING_SCENE_MIN_SEC && n <= MARKETING_SCENE_MAX_SEC)) {
    throw new MarketingScenesError(line, `duration must be ${MARKETING_SCENE_MIN_SEC}–${MARKETING_SCENE_MAX_SEC} s`);
  }
  return n;
}

/**
 * Parse a `SCENES.md`: an optional `---` front matter, then one `## SCENE-NNN — Title` section per scene with
 * `- duration:` / `- shots:` / `- caption.<locale>:` / `- transition:` / `- cue:` lines. Other text in a section is kept
 * (and hashed) but ignored. Throws `MarketingScenesError` on a malformed file.
 */
export function parseMarketingScenes(content: string): ParsedMarketingScenes {
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  let frontMatter = "";
  let settings: MarketingVideoSettings = { ...DEFAULT_MARKETING_VIDEO_SETTINGS, audio: [], photos: {}, tags: [] };
  while (i < lines.length && !lines[i]!.trim()) i++;
  if (lines[i]?.trim() === "---") {
    const start = i + 1;
    let end = start;
    while (end < lines.length && lines[end]!.trim() !== "---") end++;
    if (end >= lines.length) throw new MarketingScenesError(start, "front matter is not closed with ---");
    frontMatter = lines.slice(start, end).join("\n");
    settings = parseSettings(lines.slice(start, end), start + 1);
    i = end + 1;
  }
  const scenes: ParsedMarketingScenes["scenes"] = [];
  const seen = new Set<string>();
  let current: (MarketingScene & { start: number }) | null = null;
  /** Close the open section. */
  const close = (endExclusive: number): void => {
    if (!current) return;
    const { start, ...scene } = current;
    scenes.push({ ...scene, section: lines.slice(start, endExclusive).join("\n").trim() });
    current = null;
  };
  for (; i < lines.length; i++) {
    const raw = lines[i]!;
    const heading = /^##\s+(\S+)\s*(?:[—–-]\s*)?(.*)$/.exec(raw.trim());
    if (heading) {
      close(i);
      const id = heading[1]!;
      if (!MARKETING_SCENE_ID_RE.test(id)) throw new MarketingScenesError(i + 1, `"${id}" is not a scene id (SCENE-NNN)`);
      if (seen.has(id)) throw new MarketingScenesError(i + 1, `duplicate scene id ${id}`);
      seen.add(id);
      current = { id, title: (heading[2] ?? "").trim(), duration: 4, shots: [], captions: {}, transition: "fade", cue: null, start: i };
      continue;
    }
    if (!current) {
      if (raw.trim() && !raw.trim().startsWith("#") && !raw.trim().startsWith("<!--")) {
        throw new MarketingScenesError(i + 1, "text before the first scene heading");
      }
      continue;
    }
    const field = /^\s*[-*]\s+([a-z]+(?:\.[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?)?)\s*:\s*(.*)$/.exec(raw);
    if (!field) continue;
    const key = field[1]!;
    const value = uncomment(field[2]!);
    const scene: MarketingScene = current;
    if (key === "duration") scene.duration = seconds(value, i + 1);
    else if (key === "shots") {
      const refs = listOf(value);
      const bad = refs.find((r) => !MARKETING_SHOT_REF_RE.test(r) || !MARKETING_SHOT_ID_RE.test(r.split("/")[1] ?? ""));
      if (bad) throw new MarketingScenesError(i + 1, `"${bad}" is not a shot reference (<set>/SHOT-NNN)`);
      scene.shots = refs;
    } else if (key.startsWith("caption.")) {
      if (value) scene.captions[key.slice("caption.".length)] = value;
    } else if (key === "transition") {
      if (!(MARKETING_TRANSITIONS as readonly string[]).includes(value)) throw new MarketingScenesError(i + 1, "transition must be fade / slide / zoom / cut");
      scene.transition = value as MarketingTransition;
    } else if (key === "cue") scene.cue = value || null;
  }
  close(lines.length);
  if (scenes.length > MARKETING_SCENES_MAX) throw new MarketingScenesError(1, `more than ${MARKETING_SCENES_MAX} scenes`);
  return { settings, scenes, frontMatter };
}

/** One-line value. */
function oneLine(v: string): string {
  return v.replace(/\s*\n\s*/g, " ").trim();
}

/** The front matter lines of settings (the `photos` line only when a run is chosen). */
function settingsLines(s: MarketingVideoSettings): string[] {
  const photos = Object.entries(s.photos).sort(([a], [b]) => a.localeCompare(b));
  return [
    `size: ${s.size}`,
    `fps: ${s.fps}`,
    `locales: [${s.locales.join(", ")}]`,
    `soundtrack: ${s.soundtrack}`,
    ...(s.audio.length ? [`audio: [${s.audio.join(", ")}]`] : []),
    ...(s.tags.length ? [`tags: [${s.tags.join(", ")}]`] : []),
    ...(photos.length ? [`photos: { ${photos.map(([k, v]) => `${k}: ${v}`).join(", ")} }`] : []),
  ];
}

/** Write a `SCENES.md` from settings + scenes (the grid's save). */
export function serializeMarketingScenes(settings: MarketingVideoSettings, scenes: MarketingScene[]): string {
  const out = ["---", ...settingsLines(settings), "---", ""];
  for (const s of scenes) {
    out.push(`## ${s.id}${s.title.trim() ? ` — ${oneLine(s.title)}` : ""}`);
    out.push(`- duration: ${s.duration}s`);
    if (s.shots.length) out.push(`- shots: ${s.shots.join(", ")}`);
    for (const [locale, text] of Object.entries(s.captions)) if (text.trim()) out.push(`- caption.${locale}: ${oneLine(text)}`);
    out.push(`- transition: ${s.transition}`);
    if (s.cue) out.push(`- cue: ${oneLine(s.cue)}`);
    out.push("");
  }
  return out.join("\n");
}

/**
 * The text a scene's approval hash covers: the front matter **without** the `photos:` line (picking another photo run
 * keeps the approvals) + the scene's section. The hash is SHA-256 hex of it.
 */
export function marketingSceneHashInput(frontMatter: string, section: string): string {
  const fm = frontMatter
    .split("\n")
    .filter((l) => !/^\s*photos\s*:/.test(l))
    .join("\n");
  return `${fm.trim()}\n---\n${section.trim()}`;
}

/** The next free scene id. */
export function nextMarketingSceneId(scenes: readonly { id: string }[]): string {
  const max = scenes.reduce((m, s) => Math.max(m, Number(/^SCENE-(\d+)$/.exec(s.id)?.[1] ?? 0)), 0);
  return `SCENE-${String(max + 1).padStart(3, "0")}`;
}

/** Facts read from a video output file name, or null. */
export function parseMarketingVideoFileName(name: string): { video: string; locale: string; poster: boolean } | null {
  const m = MARKETING_VIDEO_FILE_RE.exec(name);
  if (!m) return null;
  return { video: m[1]!, locale: m[2]!, poster: m[3] === "poster.jpg" };
}

// ---------- API ----------

const baseField = z.string().regex(/^(?!.*\.\.)(?![-/])[A-Za-z0-9._/-]{1,200}$/).optional();
const shaField = z.string().regex(/^[0-9a-f]{40,64}$/);

/** Save a video's `SCENES.md`. @api marketing-0020 */
export const marketingPutScenesSchema = z.object({
  base: baseField,
  content: z.string().min(1).max(MARKETING_SCENES_MAX_BYTES),
  baseSha: shaField.nullable(),
});
export type MarketingPutScenesRequest = z.infer<typeof marketingPutScenesSchema>;

/** Delete a video. @api marketing-0021 */
export const marketingDeleteVideoSchema = z.object({ base: baseField, baseSha: shaField });

/** Approve / unapprove scenes. @api marketing-0022 */
export const marketingApproveScenesSchema = z.object({
  base: baseField,
  approve: z.array(z.object({ id: z.string().regex(MARKETING_SCENE_ID_RE), hash: z.string().regex(/^[0-9a-f]{64}$/) })).max(MARKETING_SCENES_MAX).default([]),
  unapprove: z.array(z.string().regex(MARKETING_SCENE_ID_RE)).max(MARKETING_SCENES_MAX).default([]),
});
export type MarketingApproveScenesRequest = z.infer<typeof marketingApproveScenesSchema>;

/** AI compose of scenes. @api marketing-0023 */
export const marketingComposeScenesSchema = z.object({
  base: baseField,
  brief: z.string().trim().min(1).max(4000),
  /** The video's tags as in the editor (may be unsaved). @adr 0648 */
  tags: z.array(z.string().regex(TAG_CODE_RE)).max(TAGS_PER_ITEM_MAX).default([]),
});
export type MarketingComposeScenesRequest = z.infer<typeof marketingComposeScenesSchema>;

/** Generate a video. @api marketing-0024 */
export const marketingGenerateVideoSchema = z.object({
  base: baseField,
  /** Re-scaffold the Remotion project from the newest template version (a reviewable commit). */
  updateTemplate: z.boolean().default(false),
});
export type MarketingGenerateVideoRequest = z.infer<typeof marketingGenerateVideoSchema>;

/**
 * The project's Remotion state for video Generate: switched on, terms accepted and current, key set, key required on
 * the plan (`remotionLicenseRequired`). `ready` = Generate may render. @adr 0662
 */
export interface MarketingRemotionState {
  enabled: boolean;
  termsOk: boolean;
  keySet: boolean;
  keyRequired: boolean;
  ready: boolean;
}

/** An uploaded audio file. @api marketing-0027 */
export interface MarketingAudioItemResponse {
  id: string;
  name: string;
  mime: string;
  bytes: number;
  acceptedByLabel: string | null;
  acceptedAt: string;
}

/** A video in the overview. */
export interface MarketingVideoSummary {
  video: string;
  scenes: number;
  approved: number;
}

/** A scene as the grid shows it. */
export interface MarketingSceneView extends MarketingScene {
  hash: string;
  approved: MarketingStamp | null;
  writtenBy: MarketingStamp | null;
}

/** One photo run a set can feed a video from. */
export interface MarketingVideoRunOption {
  runId: string;
  finishedAt: string | null;
  sourceRef: string | null;
  sourceSha: string | null;
  pinned: boolean;
  files: number;
}

/** Where a referenced set's pictures come from, and what is missing. */
export interface MarketingVideoPhotoSource {
  set: string;
  /** The run used (chosen, else pinned newest, else newest succeeded); null = the set has no succeeded run. */
  runId: string | null;
  /** True when the run was chosen in the front matter. */
  chosen: boolean;
  /** Newest succeeded runs of the set (≤ 20). */
  options: MarketingVideoRunOption[];
}

/** A picture an approved scene needs that the chosen run lacks. */
export interface MarketingVideoMissing {
  scene: string;
  shot: string;
  locale: string | null;
  /** `no-run`: the set has no succeeded run · `no-file`: the run has no file of that shot (for that locale). */
  reason: "no-run" | "no-file";
}

/** `GET /projects/:id/marketing/videos/:video`. @api marketing-0019 */
export interface MarketingVideoResponse {
  video: string;
  content: string;
  sha: string;
  settings: MarketingVideoSettings;
  scenes: MarketingSceneView[];
  photos: MarketingVideoPhotoSource[];
  missing: MarketingVideoMissing[];
  /** The project's Remotion external service state. */
  remotion: MarketingRemotionState;
  /** Every shot of the base's sets the scenes can use. */
  availableShots: { ref: string; title: string }[];
}

/** One picture a video run downloads (the spec the cli gets). */
export interface MarketingVideoInput {
  assetId: string;
  /** `<set>/<SHOT-id>`. */
  shot: string;
  file: string;
  theme: string | null;
  locale: string | null;
  size: string | null;
}
