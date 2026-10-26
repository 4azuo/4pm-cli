/**
 * Marketing scenes on `4pm/marketing/<base>` (`marketing.read` / `.write` / `.approve` / `.copy`) — a photo set's
 * `SHOTS.md` and a video's `SCENES.md` alike: the overview of a base
 * (with the bases to copy from when it has no branch yet), a new base's branch copied from another (sidecars reset), and one
 * set's `SHOTS.md` with its sidecars, a file write (only `run.yaml` or `photos/<set>/SHOTS.md`, checked against the
 * blob read before the edit; a `SHOTS.md` write records the writer of every shot it changes in `authors.json`), and
 * per-shot approvals bound to the shot hash (`approvals.json`; no self-approval unless allowed). Never throws: a
 * failure is a reply with `code`.
 * @adr 0640 @adr 0646 @arch 0067
 */
import { createHash } from "node:crypto";
import {
  MARKETING_SET_RE,
  MARKETING_VIDEO_RE,
  MarketingScenesError,
  MarketingShotsError,
  marketingSceneHashInput,
  parseMarketingScenes,
  marketingShotHashInput,
  parseMarketingShots,
  type ParsedMarketingShots,
} from "@4pm/dto";
import type {
  MarketingApproveReply,
  MarketingApproveRequest,
  MarketingCopyReply,
  MarketingCopyRequest,
  MarketingReadReply,
  MarketingReadRequest,
  MarketingWriteReply,
  MarketingWriteRequest,
  MarketingWsStamp,
} from "@4pm/ws";
import {
  MarketingGitError,
  commitMarketing,
  copyMarketingBranch,
  listBases,
  listMarketingBases,
  listPhotoSets,
  listVideos,
  marketingRef,
  readMarketingFile,
  resolveMarketingBase,
  type MarketingEdit,
} from "./marketing-git";

/** A sidecar entry: who + when + the shot hash it applies to. */
type SidecarEntry = MarketingWsStamp & { hash: string };
/** A sidecar file: key `<set>/<SHOT-id>` → entry. */
type Sidecar = Record<string, SidecarEntry>;

const APPROVALS = "approvals.json";
const AUTHORS = "authors.json";
const RECIPE = "run.yaml";

/** SHA-256 hex. */
function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** The approval hash of every shot of a parsed set. */
export function shotHashes(parsed: ParsedMarketingShots): Map<string, string> {
  return new Map(parsed.shots.map((s) => [s.id, sha256(marketingShotHashInput(parsed.frontMatter, s.section))]));
}

/** A sidecar from its JSON text (bad / missing ⇒ empty). */
function readSidecar(text: string | undefined): Sidecar {
  if (!text) return {};
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Sidecar) : {};
  } catch {
    return {};
  }
}

/** A sidecar as stable JSON (sorted keys). */
function writeSidecar(s: Sidecar): string {
  return `${JSON.stringify(Object.fromEntries(Object.entries(s).sort(([a], [b]) => a.localeCompare(b))), null, 2)}\n`;
}

/** The sidecar keys of one document (a set's `<set>/<SHOT-id>`, a video's `videos/<video>/<SCENE-id>`). */
function ownKey(k: string, prefix: string): boolean {
  return k.startsWith(prefix) && !k.slice(prefix.length).includes("/");
}

/** The sidecar entries of one document, keyed by row id. */
function ofPrefix(s: Sidecar, prefix: string): Sidecar {
  return Object.fromEntries(Object.entries(s).filter(([k]) => ownKey(k, prefix)).map(([k, v]) => [k.slice(prefix.length), v]));
}

/** The approval hash of every scene of a parsed video. */
export function sceneHashes(content: string): Map<string, string> {
  const parsed = parseMarketingScenes(content);
  return new Map(parsed.scenes.map((s) => [s.id, sha256(marketingSceneHashInput(parsed.frontMatter, s.section))]));
}

/** A scene document: a photo set's `SHOTS.md` or a video's `SCENES.md`. */
interface SceneDoc {
  label: string;
  folder: string;
  path: string;
  /** Sidecar key prefix of its rows. */
  prefix: string;
  /** Row id → approval hash (throws when the file doesn't parse). */
  hashes: (content: string) => Map<string, string>;
}

/** The document of a photo set. */
function photoDoc(set: string): SceneDoc {
  return { label: `set ${set}`, folder: `photos/${set}`, path: `photos/${set}/SHOTS.md`, prefix: `${set}/`, hashes: (c) => shotHashes(parseMarketingShots(c)) };
}

/** The document of a video. */
function videoDoc(video: string): SceneDoc {
  return { label: `video ${video}`, folder: `videos/${video}`, path: `videos/${video}/SCENES.md`, prefix: `videos/${video}/`, hashes: sceneHashes };
}

/** A refusal reply from an error. */
function refusal(err: unknown): { ok: false; code: string; error: string } {
  if (err instanceof MarketingGitError) return { ok: false, code: err.code, error: err.message };
  if (err instanceof MarketingShotsError) return { ok: false, code: "MARKETING_INVALID_SHOTS", error: err.message };
  if (err instanceof MarketingScenesError) return { ok: false, code: "MARKETING_INVALID_SCENES", error: err.message };
  return { ok: false, code: "MARKETING_WRITE_FAILED", error: err instanceof Error ? err.message : String(err) };
}

/** The overview of a base (+ one set's file when asked). */
export async function readMarketing(root: string, req: MarketingReadRequest): Promise<MarketingReadReply> {
  try {
    const base = await resolveMarketingBase(root, req.base);
    const [commit, bases] = await Promise.all([marketingRef(root, base), listBases(root)]);
    const approvals = readSidecar((await readMarketingFile(root, commit, APPROVALS))?.content);
    const sets: NonNullable<MarketingReadReply["sets"]> = [];
    const shots: NonNullable<MarketingReadReply["shots"]> = [];
    for (const set of await listPhotoSets(root, commit)) {
      if (!MARKETING_SET_RE.test(set)) continue;
      const file = await readMarketingFile(root, commit, `photos/${set}/SHOTS.md`);
      if (!file) continue;
      try {
        const parsed = parseMarketingShots(file.content);
        const hashes = shotHashes(parsed);
        const mine = ofPrefix(approvals, `${set}/`);
        const approved = parsed.shots.filter((s) => mine[s.id]?.hash === hashes.get(s.id)).length;
        sets.push({ set, driver: parsed.settings.driver, shots: parsed.shots.length, approved });
        for (const s of parsed.shots) shots.push({ ref: `${set}/${s.id}`, title: s.title });
      } catch (err) {
        sets.push({ set, driver: null, shots: 0, approved: 0, error: err instanceof Error ? err.message : String(err) });
      }
    }
    const videos: NonNullable<MarketingReadReply["videos"]> = [];
    for (const video of await listVideos(root, commit)) {
      if (!MARKETING_VIDEO_RE.test(video)) continue;
      const doc = videoDoc(video);
      const file = await readMarketingFile(root, commit, doc.path);
      if (!file) continue;
      try {
        const hashes = doc.hashes(file.content);
        const mine = ofPrefix(approvals, doc.prefix);
        videos.push({ video, scenes: hashes.size, approved: [...hashes].filter(([id, h]) => mine[id]?.hash === h).length });
      } catch (err) {
        videos.push({ video, scenes: 0, approved: 0, error: err instanceof Error ? err.message : String(err) });
      }
    }
    const recipe = await readMarketingFile(root, commit, RECIPE);
    let file: MarketingReadReply["file"] = undefined;
    let videoFile: MarketingReadReply["videoFile"] = undefined;
    if (req.video !== undefined) {
      if (!MARKETING_VIDEO_RE.test(req.video)) return { ok: false, code: "MARKETING_SET_NOT_FOUND", error: "Bad video name." };
      const doc = videoDoc(req.video);
      const f = await readMarketingFile(root, commit, doc.path);
      videoFile = f
        ? {
            content: f.content,
            sha: f.sha,
            approvals: ofPrefix(approvals, doc.prefix),
            authors: ofPrefix(readSidecar((await readMarketingFile(root, commit, AUTHORS))?.content), doc.prefix),
          }
        : null;
    }
    if (req.set !== undefined) {
      if (!MARKETING_SET_RE.test(req.set)) return { ok: false, code: "MARKETING_SET_NOT_FOUND", error: "Bad set name." };
      const f = await readMarketingFile(root, commit, `photos/${req.set}/SHOTS.md`);
      file = f
        ? {
            content: f.content,
            sha: f.sha,
            approvals: ofPrefix(approvals, `${req.set}/`),
            authors: ofPrefix(readSidecar((await readMarketingFile(root, commit, AUTHORS))?.content), `${req.set}/`),
          }
        : null;
    }
    // A base without scenes yet: the bases it can start from.
    const copyFrom = commit === null ? (await listMarketingBases(root)).filter((b) => b !== base) : undefined;
    return {
      ok: true,
      base,
      bases,
      branchExists: commit !== null,
      ...(copyFrom ? { copyFrom } : {}),
      sets,
      videos,
      shots,
      recipe: recipe ?? null,
      ...(file !== undefined ? { file } : {}),
      ...(videoFile !== undefined ? { videoFile } : {}),
    };
  } catch (err) {
    return refusal(err);
  }
}

/** Create a base's scene branch from another base's: scenes, recipe and capture code; approvals / authors reset. */
export async function copyMarketing(root: string, req: MarketingCopyRequest): Promise<MarketingCopyReply> {
  try {
    const from = await resolveMarketingBase(root, req.from);
    const to = await resolveMarketingBase(root, req.to);
    if (from === to) return { ok: false, code: "MARKETING_BRANCH_EXISTS", error: "Pick another base to copy from." };
    const sha = await copyMarketingBranch(root, from, to, `chore(marketing): copy scenes from ${from} (by ${req.byLabel})`, [APPROVALS, AUTHORS]);
    return { ok: true, sha };
  } catch (err) {
    return refusal(err);
  }
}

/** The document of a `photos/<set>/SHOTS.md` / `videos/<video>/SCENES.md` path, or null. */
function docOfPath(path: string): SceneDoc | null {
  const photo = /^photos\/([^/]+)\/SHOTS\.md$/.exec(path);
  if (photo && MARKETING_SET_RE.test(photo[1]!)) return photoDoc(photo[1]!);
  const video = /^videos\/([^/]+)\/SCENES\.md$/.exec(path);
  if (video && MARKETING_VIDEO_RE.test(video[1]!)) return videoDoc(video[1]!);
  return null;
}

/** Write one marketing file (or delete a set / video). */
export async function writeMarketing(root: string, req: MarketingWriteRequest): Promise<MarketingWriteReply> {
  const doc = docOfPath(req.path);
  if (req.path !== RECIPE && !doc) return { ok: false, code: "MARKETING_WRITE_FAILED", error: `Not a marketing file: ${req.path}` };
  if (req.content === null && !doc) return { ok: false, code: "MARKETING_WRITE_FAILED", error: "Only a set or a video can be deleted." };
  try {
    const base = await resolveMarketingBase(root, req.base);
    const newHashes = doc && req.content !== null ? doc.hashes(req.content) : null;
    const stamp = { by: req.by, byLabel: req.byLabel, at: new Date().toISOString() };
    const commit = await commitMarketing(
      root,
      base,
      `chore(marketing): ${req.content === null ? `delete ${doc!.label}` : `update ${req.path}`} (4PM)\n\n4PM-Requested-By: ${req.byLabel.replace(/\s+/g, " ").slice(0, 200)}`,
      async (parent) => {
        const cur = await readMarketingFile(root, parent, req.path);
        if ((cur?.sha ?? null) !== req.baseSha) {
          throw new MarketingGitError(req.baseSha && !cur ? "MARKETING_SET_NOT_FOUND" : "MARKETING_FILE_CHANGED", `${req.path} changed on the branch.`);
        }
        if (!doc) return [{ path: RECIPE, content: req.content }];
        const authors = readSidecar((await readMarketingFile(root, parent, AUTHORS))?.content);
        const approvals = readSidecar((await readMarketingFile(root, parent, APPROVALS))?.content);
        if (req.content === null) {
          // The whole folder goes, with its sidecar entries.
          for (const k of Object.keys(authors)) if (ownKey(k, doc.prefix)) delete authors[k];
          for (const k of Object.keys(approvals)) if (ownKey(k, doc.prefix)) delete approvals[k];
          return [
            { path: doc.folder, content: null },
            { path: AUTHORS, content: writeSidecar(authors) },
            { path: APPROVALS, content: writeSidecar(approvals) },
          ];
        }
        let oldHashes = new Map<string, string>();
        try {
          if (cur) oldHashes = doc.hashes(cur.content);
        } catch {
          /* the old file didn't parse: every row counts as changed */
        }
        for (const [id, hash] of newHashes!) {
          if (oldHashes.get(id) !== hash) authors[`${doc.prefix}${id}`] = { ...stamp, hash };
        }
        // Drop the entries of removed rows (approvals of changed rows stay but no longer match their hash).
        for (const k of Object.keys(authors)) if (ownKey(k, doc.prefix) && !newHashes!.has(k.slice(doc.prefix.length))) delete authors[k];
        for (const k of Object.keys(approvals)) if (ownKey(k, doc.prefix) && !newHashes!.has(k.slice(doc.prefix.length))) delete approvals[k];
        return [
          { path: req.path, content: req.content! },
          { path: AUTHORS, content: writeSidecar(authors) },
          { path: APPROVALS, content: writeSidecar(approvals) },
        ] satisfies MarketingEdit[];
      },
    );
    const after = await readMarketingFile(root, commit ?? (await marketingRef(root, base)), req.path);
    return { ok: true, sha: after?.sha ?? null };
  } catch (err) {
    return refusal(err);
  }
}

/** Approve / unapprove the shots of a set or the scenes of a video. */
export async function approveMarketing(root: string, req: MarketingApproveRequest): Promise<MarketingApproveReply> {
  const doc = req.video !== undefined ? (MARKETING_VIDEO_RE.test(req.video) ? videoDoc(req.video) : null) : req.set && MARKETING_SET_RE.test(req.set) ? photoDoc(req.set) : null;
  if (!doc) return { ok: false, code: "MARKETING_SET_NOT_FOUND", error: "Bad set / video name." };
  try {
    const base = await resolveMarketingBase(root, req.base);
    let result: Sidecar = {};
    await commitMarketing(
      root,
      base,
      `chore(marketing): approvals of ${doc.label} (4PM)\n\n4PM-Requested-By: ${req.byLabel.replace(/\s+/g, " ").slice(0, 200)}`,
      async (parent) => {
        const file = await readMarketingFile(root, parent, doc.path);
        if (!file) throw new MarketingGitError("MARKETING_SET_NOT_FOUND", `No such ${doc.label}.`);
        const hashes = doc.hashes(file.content);
        const approvals = readSidecar((await readMarketingFile(root, parent, APPROVALS))?.content);
        const authors = readSidecar((await readMarketingFile(root, parent, AUTHORS))?.content);
        const at = new Date().toISOString();
        for (const a of req.approve) {
          const key = `${doc.prefix}${a.id}`;
          if (hashes.get(a.id) !== a.hash) throw new MarketingGitError("MARKETING_FILE_CHANGED", `${a.id} changed since it was read.`);
          if (!req.allowSelf && authors[key]?.by === req.by) throw new MarketingGitError("APPROVAL_SELF", `You wrote ${a.id}; someone else must approve it.`);
          approvals[key] = { by: req.by, byLabel: req.byLabel, at, hash: a.hash };
        }
        for (const id of req.unapprove) delete approvals[`${doc.prefix}${id}`];
        result = ofPrefix(approvals, doc.prefix);
        return [{ path: APPROVALS, content: writeSidecar(approvals) }];
      },
    );
    return { ok: true, approvals: Object.fromEntries(Object.entries(result).map(([id, e]) => [id, { by: e.by, byLabel: e.byLabel, at: e.at }])) };
  } catch (err) {
    return refusal(err);
  }
}
