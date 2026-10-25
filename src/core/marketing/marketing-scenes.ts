/**
 * Marketing scenes on `4pm/marketing/<base>` (`marketing.read` / `.write` / `.approve`): the overview of a base and one
 * set's `SHOTS.md` with its sidecars, a file write (only `run.yaml` or `photos/<set>/SHOTS.md`, checked against the
 * blob read before the edit; a `SHOTS.md` write records the writer of every shot it changes in `authors.json`), and
 * per-shot approvals bound to the shot hash (`approvals.json`; no self-approval unless allowed). Never throws: a
 * failure is a reply with `code`.
 * @adr 0640 @arch 0067
 */
import { createHash } from "node:crypto";
import {
  MARKETING_SET_RE,
  MarketingShotsError,
  marketingShotHashInput,
  marketingShotKey,
  parseMarketingShots,
  type ParsedMarketingShots,
} from "@4pm/dto";
import type {
  MarketingApproveReply,
  MarketingApproveRequest,
  MarketingReadReply,
  MarketingReadRequest,
  MarketingWriteReply,
  MarketingWriteRequest,
  MarketingWsStamp,
} from "@4pm/ws";
import {
  MarketingGitError,
  commitMarketing,
  listBases,
  listPhotoSets,
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

/** The sidecar entries of one set, keyed by shot id. */
function ofSet(s: Sidecar, set: string): Sidecar {
  const prefix = `${set}/`;
  return Object.fromEntries(Object.entries(s).filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k.slice(prefix.length), v]));
}

/** A refusal reply from an error. */
function refusal(err: unknown): { ok: false; code: string; error: string } {
  if (err instanceof MarketingGitError) return { ok: false, code: err.code, error: err.message };
  if (err instanceof MarketingShotsError) return { ok: false, code: "MARKETING_INVALID_SHOTS", error: err.message };
  return { ok: false, code: "MARKETING_WRITE_FAILED", error: err instanceof Error ? err.message : String(err) };
}

/** Parse a set file, or null when it doesn't parse. */
function tryParse(content: string): ParsedMarketingShots | null {
  try {
    return parseMarketingShots(content);
  } catch {
    return null;
  }
}

/** The overview of a base (+ one set's file when asked). */
export async function readMarketing(root: string, req: MarketingReadRequest): Promise<MarketingReadReply> {
  try {
    const base = await resolveMarketingBase(root, req.base);
    const [commit, bases] = await Promise.all([marketingRef(root, base), listBases(root)]);
    const approvals = readSidecar((await readMarketingFile(root, commit, APPROVALS))?.content);
    const sets: NonNullable<MarketingReadReply["sets"]> = [];
    for (const set of await listPhotoSets(root, commit)) {
      if (!MARKETING_SET_RE.test(set)) continue;
      const file = await readMarketingFile(root, commit, `photos/${set}/SHOTS.md`);
      if (!file) continue;
      try {
        const parsed = parseMarketingShots(file.content);
        const hashes = shotHashes(parsed);
        const mine = ofSet(approvals, set);
        const approved = parsed.shots.filter((s) => mine[s.id]?.hash === hashes.get(s.id)).length;
        sets.push({ set, driver: parsed.settings.driver, shots: parsed.shots.length, approved });
      } catch (err) {
        sets.push({ set, driver: null, shots: 0, approved: 0, error: err instanceof Error ? err.message : String(err) });
      }
    }
    const recipe = await readMarketingFile(root, commit, RECIPE);
    let file: MarketingReadReply["file"] = undefined;
    if (req.set !== undefined) {
      if (!MARKETING_SET_RE.test(req.set)) return { ok: false, code: "MARKETING_SET_NOT_FOUND", error: "Bad set name." };
      const f = await readMarketingFile(root, commit, `photos/${req.set}/SHOTS.md`);
      file = f
        ? {
            content: f.content,
            sha: f.sha,
            approvals: ofSet(approvals, req.set),
            authors: ofSet(readSidecar((await readMarketingFile(root, commit, AUTHORS))?.content), req.set),
          }
        : null;
    }
    return { ok: true, base, bases, branchExists: commit !== null, sets, recipe: recipe ?? null, ...(file !== undefined ? { file } : {}) };
  } catch (err) {
    return refusal(err);
  }
}

/** The set of a `photos/<set>/SHOTS.md` path, or null. */
function setOfPath(path: string): string | null {
  const m = /^photos\/([^/]+)\/SHOTS\.md$/.exec(path);
  return m && MARKETING_SET_RE.test(m[1]!) ? m[1]! : null;
}

/** Write one marketing file (or delete a set). */
export async function writeMarketing(root: string, req: MarketingWriteRequest): Promise<MarketingWriteReply> {
  const set = setOfPath(req.path);
  if (req.path !== RECIPE && !set) return { ok: false, code: "MARKETING_WRITE_FAILED", error: `Not a marketing file: ${req.path}` };
  if (req.content === null && !set) return { ok: false, code: "MARKETING_WRITE_FAILED", error: "Only a set can be deleted." };
  try {
    const base = await resolveMarketingBase(root, req.base);
    const parsedNew = set && req.content !== null ? parseMarketingShots(req.content) : null;
    const stamp = { by: req.by, byLabel: req.byLabel, at: new Date().toISOString() };
    const commit = await commitMarketing(
      root,
      base,
      `chore(marketing): ${req.content === null ? `delete set ${set}` : `update ${req.path}`} (4PM)\n\n4PM-Requested-By: ${req.byLabel.replace(/\s+/g, " ").slice(0, 200)}`,
      async (parent) => {
        const cur = await readMarketingFile(root, parent, req.path);
        if ((cur?.sha ?? null) !== req.baseSha) {
          throw new MarketingGitError(req.baseSha && !cur ? "MARKETING_SET_NOT_FOUND" : "MARKETING_FILE_CHANGED", `${req.path} changed on the branch.`);
        }
        if (!set) return [{ path: RECIPE, content: req.content }];
        const authors = readSidecar((await readMarketingFile(root, parent, AUTHORS))?.content);
        const approvals = readSidecar((await readMarketingFile(root, parent, APPROVALS))?.content);
        const prefix = `${set}/`;
        if (req.content === null) {
          // The whole set goes, with its sidecar entries.
          for (const k of Object.keys(authors)) if (k.startsWith(prefix)) delete authors[k];
          for (const k of Object.keys(approvals)) if (k.startsWith(prefix)) delete approvals[k];
          return [
            { path: `photos/${set}`, content: null },
            { path: AUTHORS, content: writeSidecar(authors) },
            { path: APPROVALS, content: writeSidecar(approvals) },
          ];
        }
        const before = cur ? tryParse(cur.content) : null;
        const oldHashes = before ? shotHashes(before) : new Map<string, string>();
        const newHashes = shotHashes(parsedNew!);
        for (const [id, hash] of newHashes) {
          if (oldHashes.get(id) !== hash) authors[marketingShotKey(set, id)] = { ...stamp, hash };
        }
        // Drop the entries of removed shots (approvals of changed shots stay but no longer match their hash).
        for (const k of Object.keys(authors)) if (k.startsWith(prefix) && !newHashes.has(k.slice(prefix.length))) delete authors[k];
        for (const k of Object.keys(approvals)) if (k.startsWith(prefix) && !newHashes.has(k.slice(prefix.length))) delete approvals[k];
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

/** Approve / unapprove shots of a set. */
export async function approveMarketing(root: string, req: MarketingApproveRequest): Promise<MarketingApproveReply> {
  if (!MARKETING_SET_RE.test(req.set)) return { ok: false, code: "MARKETING_SET_NOT_FOUND", error: "Bad set name." };
  try {
    const base = await resolveMarketingBase(root, req.base);
    let result: Sidecar = {};
    await commitMarketing(
      root,
      base,
      `chore(marketing): approvals of ${req.set} (4PM)\n\n4PM-Requested-By: ${req.byLabel.replace(/\s+/g, " ").slice(0, 200)}`,
      async (parent) => {
        const file = await readMarketingFile(root, parent, `photos/${req.set}/SHOTS.md`);
        if (!file) throw new MarketingGitError("MARKETING_SET_NOT_FOUND", "No such photo set.");
        const hashes = shotHashes(parseMarketingShots(file.content));
        const approvals = readSidecar((await readMarketingFile(root, parent, APPROVALS))?.content);
        const authors = readSidecar((await readMarketingFile(root, parent, AUTHORS))?.content);
        const at = new Date().toISOString();
        for (const a of req.approve) {
          const key = marketingShotKey(req.set, a.id);
          if (hashes.get(a.id) !== a.hash) throw new MarketingGitError("MARKETING_FILE_CHANGED", `${a.id} changed since it was read.`);
          if (!req.allowSelf && authors[key]?.by === req.by) throw new MarketingGitError("APPROVAL_SELF", `You wrote ${a.id}; someone else must approve it.`);
          approvals[key] = { by: req.by, byLabel: req.byLabel, at, hash: a.hash };
        }
        for (const id of req.unapprove) delete approvals[marketingShotKey(req.set, id)];
        result = ofSet(approvals, req.set);
        return [{ path: APPROVALS, content: writeSidecar(approvals) }];
      },
    );
    return { ok: true, approvals: Object.fromEntries(Object.entries(result).map(([id, e]) => [id, { by: e.by, byLabel: e.byLabel, at: e.at }])) };
  } catch (err) {
    return refusal(err);
  }
}
