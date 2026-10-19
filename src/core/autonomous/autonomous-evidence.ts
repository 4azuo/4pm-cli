/**
 * Book evidence in the repo. Files attached to book rows live at
 * `<evidenceDir>/<BOOK>/<ROW-ID>/<k>-<name>` (default `.4pm/evidence`; configurable — ADR-0418, links under an
 * earlier root keep working) and are referenced from the cells as plain markdown links.
 * This module stages an uploaded file in the profile dir (outside the repo) until a `bookSave` commits it,
 * moves staged files into the books' worktree, prunes files no book references any more, carries a finished
 * task's evidence from AI_TODO to AI_DONE, lists the agent's own evidence on a task branch, and reads one
 * file for the web (`origin/autonomous-books/<base>` → the task / request / DOC branch → `origin/<base>` → working
 * tree) — an evidence file, an intake mockup, or a sequence diagram / ER file. Mockups and sequences are work output
 *: listed from `<base>` and the open request / DOC branches, restored with a commit on `<base>`.
 * @adr 0404 @adr 0418 @adr 0453 @adr 0563
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, posix } from "node:path";
import {
  EVIDENCE_BOOK_DIR,
  EVIDENCE_MAX_BYTES,
  EVIDENCE_REV_RE,
  EVIDENCE_PATH_RE,
  evidenceLinks,
  isEvidencePath,
  isSafeRepoDir,
  evidenceMarkdown,
  type EvidenceBookKey,
} from "@4pm/dto";
import type { AutonomousEvidenceReply, EvidenceCommit } from "@4pm/ws";
import { parseQa } from "./autonomous-books";
import { mkdirInRoot, readFileInRoot, resolveEntry, resolveForRead, writeFileInRoot } from "../../utils/safe-path";
import { execInProject } from "../agent/agent-spawn";
import { booksBranch } from "./autonomous-tasks";
import { gitQuiet } from "./autonomous-git";
import { commitToBase, locateBase } from "../git/base-edit";

// Project git runs as the agent user when uid separation is on (ADR-0430); unchanged otherwise.
const run = execInProject;

/** Staged uploads live here (per profile), swept after this age. */
const STAGE_DIR = "evidence-stage";
const STAGE_TTL_MS = 24 * 3600_000;
/** Every book a link may sit in (a file is kept while any of them references it). */
const BOOK_FILES = ["USER_TODO.md", "USER_QA.md", "AI_TODO.md", "AI_PROGRESS.md", "AI_DONE.md"];

/** Minimal extension → MIME map for the viewer; unknown ⇒ octet-stream. */
const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".log": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".html": "text/html",
  ".csv": "text/csv",
  ".zip": "application/zip",
};

/** MIME type guessed from a path's extension. */
export function mimeOf(path: string): string {
  return MIME_BY_EXT[extname(path).toLowerCase()] ?? "application/octet-stream";
}

/** A staged id is a bare UUID (never a path). */
function isStageId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

/** Drop staged uploads older than the TTL (best effort). */
async function sweepStage(dir: string): Promise<void> {
  const now = Date.now();
  for (const f of await readdir(dir).catch(() => [] as string[])) {
    const p = join(dir, f);
    const s = await stat(p).catch(() => null);
    if (s && now - s.mtimeMs > STAGE_TTL_MS) await rm(p, { force: true });
  }
}

/** Stage one uploaded evidence file in the profile dir; returns its id. @api machine-0072 */
export async function stageEvidence(profileDir: string, contentBase64: string): Promise<{ ok: boolean; stageId?: string; error?: string }> {
  const bytes = Buffer.from(contentBase64, "base64");
  if (bytes.length === 0) return { ok: false, error: "empty file" };
  if (bytes.length > EVIDENCE_MAX_BYTES) return { ok: false, error: "evidence file too large" };
  const dir = join(profileDir, STAGE_DIR);
  await mkdir(dir, { recursive: true });
  await sweepStage(dir);
  const stageId = randomUUID();
  await writeFile(join(dir, stageId), bytes);
  return { ok: true, stageId };
}

/**
 * Move the staged files of a `bookSave` into the books' worktree `dir`. Each path must be a valid evidence
 * path under the saved book's own folder of the configured evidence root `evRoot`; a missing
 * stage aborts the save (nothing half-committed).
 */
export async function applyStagedEvidence(
  dir: string,
  profileDir: string,
  book: EvidenceBookKey,
  items: { stageId: string; path: string }[],
  evRoot: string,
): Promise<string | null> {
  const folder = `${evRoot}/${EVIDENCE_BOOK_DIR[book]}/`;
  for (const it of items) {
    if (!isStageId(it.stageId) || !isEvidencePath(it.path) || !it.path.startsWith(folder)) return `invalid evidence path ${it.path}`;
    if (!existsSync(join(profileDir, STAGE_DIR, it.stageId))) return `staged evidence expired: ${it.path}`;
  }
  for (const it of items) {
    // Symlink-safe (ADR-0430): a linked evidence folder cannot redirect the write outside the project.
    await writeFileInRoot(dir, join(dir, it.path), await readFile(join(profileDir, STAGE_DIR, it.stageId)));
    await rm(join(profileDir, STAGE_DIR, it.stageId), { force: true });
  }
  return null;
}

/** Every file under `rel` (repo-relative, posix), recursively. */
export async function listFiles(root: string, rel: string): Promise<string[]> {
  const out: string[] = [];
  // Symlink-safe (ADR-0430): only list a folder that really is inside the project.
  const real = resolveForRead(root, join(root, rel));
  for (const e of real ? await readdir(real, { withFileTypes: true }).catch(() => []) : []) {
    const child = posix.join(rel, e.name);
    if (e.isDirectory()) out.push(...(await listFiles(root, child)));
    else out.push(child);
  }
  return out;
}

/** Remove now-empty folders under `rel` (deepest first). */
async function removeEmptyDirs(root: string, rel: string): Promise<void> {
  // Never walk (or rmdir) through a linked folder that leads outside the project (ADR-0430).
  if (!resolveForRead(root, join(root, rel)) || !resolveEntry(root, join(root, rel))) return;
  for (const e of await readdir(join(root, rel), { withFileTypes: true }).catch(() => [])) {
    if (e.isDirectory()) await removeEmptyDirs(root, posix.join(rel, e.name));
  }
  if ((await readdir(join(root, rel)).catch(() => ["x"])).length === 0) await rmdir(join(root, rel)).catch(() => undefined);
}

/**
 * The open request / DOC branches of a base on the remote (`dev/<base>/<GROUP>/REQ-…` / `QA-…` / `DOC-…`), plus the
 * work branches of `alsoIds` (tasks parked on a question keep its sequence diagram on their WIP branch).
 * @adr 0563
 */
export async function openDesignBranches(root: string, base: string, alsoIds: readonly string[] = []): Promise<string[]> {
  const out = await gitQuiet(root, ["for-each-ref", "--format=%(refname:short)", `refs/remotes/origin/dev/${base}/`]);
  const also = new Set(alsoIds);
  return out
    .split("\n")
    .map((l) => l.trim().replace(/^origin\//, ""))
    .filter((b) => /\/(?:REQ|QA|DOC)-\d{6}-\d{3}$/.test(b) || also.has(b.slice(b.lastIndexOf("/") + 1)));
}

/** The tasks / DOC rows that asked the live questions of USER_QA (`Original request` = `<ID>: …`). @adr 0563 */
export function questionAskers(userQa: string): string[] {
  const ids = new Set<string>();
  for (const q of parseQa(userQa).rows) {
    const m = /^((?:TSK|DOC)-\d{6}-\d{3})\b/.exec(q.original.trim());
    if (m) ids.add(m[1]!);
  }
  return [...ids];
}

/**
 * The work-output files under `dir` (mockups / sequences): on `origin/<base>` and on each open request / DOC branch
 * and on the WIP branch of each task in `alsoIds` (a file only on a branch maps to it in `refs`); else the working tree.
 * @adr 0563
 */
export async function listWorkOutput(
  root: string,
  base: string | null,
  dir: string,
  keep: (p: string) => boolean,
  alsoIds: readonly string[] = [],
): Promise<{ paths: string[]; refs: Record<string, string> }> {
  const refs: Record<string, string> = {};
  const seen = new Set<string>();
  const ls = async (ref: string): Promise<string[] | null> => {
    try {
      const { stdout } = await run("git", ["ls-tree", "-r", "--name-only", ref, "--", `${dir}/`], { cwd: root });
      return String(stdout).split("\n").map((l) => l.trim()).filter((p) => p && keep(p));
    } catch {
      return null;
    }
  };
  const onBase = base ? await ls(`origin/${base}`) : null;
  if (!onBase) return { paths: (await listFiles(root, dir)).filter(keep).sort(), refs };
  for (const p of onBase) seen.add(p);
  for (const branch of await openDesignBranches(root, base!, alsoIds)) {
    for (const p of (await ls(`origin/${branch}`)) ?? []) {
      if (seen.has(p)) continue;
      seen.add(p);
      refs[p] = branch;
    }
  }
  return { paths: [...seen].sort(), refs };
}

/** The intake UI mockups: `.html` files under `mockupDir` on `<base>` and the open request / DOC branches. @adr 0418 @adr 0563 */
export async function listMockups(root: string, base: string | null, mockupDir: string): Promise<{ paths: string[]; refs: Record<string, string> }> {
  return listWorkOutput(root, base, mockupDir, (p) => p.startsWith(`${mockupDir}/`) && p.toLowerCase().endsWith(".html") && isSafeRepoDir(p));
}

/** The text of every book in `dir` (missing ⇒ empty), joined — a file is "referenced" when its path appears. */
async function allBooksText(dir: string): Promise<string> {
  const texts = await Promise.all(BOOK_FILES.map((f) => readFileInRoot(dir, join(dir, f), "utf8").catch(() => "")));
  return texts.join("\n");
}

/**
 * Delete the evidence files whose link THIS save removed from the book (`prev` → `next`) and that no book
 * references any more. Only explicit removals are pruned — a row the cycle consumed (an analysed request /
 * folded question) never loses its files, and AI Done (cli-written history) is never pruned here.
 */
export async function pruneEvidence(dir: string, book: EvidenceBookKey, prev: string, next: string): Promise<void> {
  if (book === "aiDone") return;
  const removed = evidenceLinks(prev)
    .map((l) => l.path)
    .filter((p) => isEvidencePath(p) && !next.includes(p));
  if (removed.length === 0) return;
  const text = await allBooksText(dir);
  for (const f of new Set(removed)) {
    if (!text.includes(f)) {
      const target = resolveEntry(dir, join(dir, f));
      if (target) await rm(target, { force: true });
    }
  }
  // Each root a removed file lived under (evidence may sit under an earlier `evidenceDir`).
  for (const root of new Set(removed.map(rootOf))) await removeEmptyDirs(dir, `${root}/${EVIDENCE_BOOK_DIR[book]}`);
}

/** The evidence root of an evidence path (`<root>/<BOOK>/<ID>/<file>` → `<root>`). */
function rootOf(path: string): string {
  return EVIDENCE_PATH_RE.exec(path)?.[1] ?? "";
}

/** Every evidence root a task's AI_TODO files may sit under: the configured one + any linked from the books. */
async function taskRoots(root: string, taskId: string, evRoot: string): Promise<string[]> {
  const text = await allBooksText(root);
  const linked = evidenceLinks(text)
    .map((l) => l.path)
    .filter((p) => isEvidencePath(p) && p.includes(`/AI_TODO/${taskId}/`))
    .map(rootOf);
  return [...new Set([evRoot, ...linked])].filter(isSafeRepoDir);
}

/**
 * Carry a finished (or split) task's attachments from `<root>/AI_TODO/<TSK>/` to `<root>/AI_DONE/<TSK>/` and
 * rewrite the links in every book; returns the moved paths (new locations). Each evidence root the task uses is
 * handled in place. No folder ⇒ nothing to do.
 */
export async function moveTaskEvidence(root: string, taskId: string, evRoot: string): Promise<string[]> {
  const moved: string[] = [];
  for (const evr of await taskRoots(root, taskId, evRoot)) {
    const from = `${evr}/AI_TODO/${taskId}`;
    const to = `${evr}/AI_DONE/${taskId}`;
    const files = await listFiles(root, from);
    if (files.length === 0) continue;
    for (const f of files) {
      const dest = `${to}/${f.slice(from.length + 1)}`;
      const src = resolveEntry(root, join(root, f));
      const dst = resolveEntry(root, join(root, dest));
      if (!src || !dst) continue;
      await mkdirInRoot(root, dirname(dst));
      await rename(src, dst);
      moved.push(dest);
    }
    await removeEmptyDirs(root, `${evr}/AI_TODO`);
    for (const b of BOOK_FILES) {
      const p = join(root, b);
      const text = await readFileInRoot(root, p, "utf8").catch(() => null);
      if (text !== null && text.includes(`${from}/`)) await writeFileInRoot(root, p, text.replaceAll(`${from}/`, `${to}/`));
    }
  }
  return moved;
}

/** Rewrite a task's AI_TODO evidence links (under any root) to their AI_DONE location (in-memory copies of a cell). */
export function rehomeTaskLinks(text: string, taskId: string): string {
  return text.replaceAll(`/AI_TODO/${taskId}/`, `/AI_DONE/${taskId}/`);
}

/** The agent's own evidence committed on the task branch (`<evRoot>/AI_DONE/<TSK>/…` at HEAD of `cwd`). */
export async function agentEvidence(cwd: string, taskId: string, evRoot: string): Promise<string[]> {
  try {
    const { stdout } = await run("git", ["ls-tree", "-r", "--name-only", "HEAD", "--", `${evRoot}/AI_DONE/${taskId}/`], { cwd });
    return stdout.split("\n").map((l) => l.trim()).filter((l) => isEvidencePath(l));
  } catch {
    return [];
  }
}

/** The AI Done `Evidence` cell: one markdown link per file (images as images). */
export function evidenceCell(paths: string[]): string {
  return [...new Set(paths)].map((p) => evidenceMarkdown(posix.basename(p).replace(/^\d+-/, ""), p, mimeOf(p))).join(" ");
}

/** `git show <rev>:<path>` as bytes, or null. */
async function showBytes(root: string, rev: string, path: string): Promise<Buffer | null> {
  try {
    const { stdout } = await run("git", ["show", `${rev}:${path}`], { cwd: root, encoding: "buffer", maxBuffer: EVIDENCE_MAX_BYTES + 1024 });
    return stdout as unknown as Buffer;
  } catch {
    return null;
  }
}

/**
 * Read one evidence file — or an intake mockup (`<mockupDir>/….html`) — for the web:
 * the books branch first (web-staged evidence + mockups — ADR-0448), then `origin/<base>` (evidence merged
 * with a task PR), then `origin/<ref>` (a task branch whose PR is not merged yet), then the working tree.
 * @api machine-0073 @adr 0448
 */
export async function readEvidenceFile(
  root: string,
  base: string | null,
  path: string,
  ref: string | undefined,
  mockupDir: string,
  designDirs: readonly string[] = [],
  rev?: string,
): Promise<AutonomousEvidenceReply> {
  const mockup = isSafeRepoDir(path) && path.startsWith(`${mockupDir}/`) && path.toLowerCase().endsWith(".html");
  // A sequence diagram / ER file (`.md` under `sequenceDir` / `erDir` — ADR-0453).
  const design = isSafeRepoDir(path) && path.toLowerCase().endsWith(".md") && designDirs.some((d) => path.startsWith(`${d}/`));
  if (!isEvidencePath(path) && !mockup && !design) return { error: "invalid evidence path" };
  if (ref && !/^[A-Za-z0-9._/-]{1,200}$/.test(ref)) return { error: "invalid ref" };
  if (rev !== undefined && !EVIDENCE_REV_RE.test(rev)) return { error: "invalid version" };
  let bytes: Buffer | null = null;
  // A past version (ADR-0515): that commit only, no fallbacks.
  if (rev) bytes = await showBytes(root, rev, path);
  else if (base) bytes = await showBytes(root, `origin/${booksBranch(base)}`, path);
  // A work branch (a task / request / DOC whose PR is not merged yet) before `<base>` — its file is the newer one.
  if (!bytes && ref && !rev) bytes = await showBytes(root, `origin/${ref}`, path);
  if (!bytes && base && !rev) bytes = await showBytes(root, `origin/${base}`, path);
  if (!bytes && !rev) bytes = await readFileInRoot(root, join(root, path)).catch(() => null);
  if (!bytes) return { error: "evidence not found" };
  // The reply rides one WS frame (8 MB): base64 of the 5 MB evidence cap fits, a bigger file is refused.
  if (bytes.length > EVIDENCE_MAX_BYTES) return { error: "evidence file too large" };
  return { contentBase64: bytes.toString("base64"), contentType: mimeOf(path), name: posix.basename(path), size: bytes.length };
}

/** Is `path` a file with a version history in the app — an intake mockup or a sequence diagram? @adr 0515 */
export function isVersionedEvidencePath(path: string, mockupDir: string, sequenceDir: string): boolean {
  if (!isSafeRepoDir(path)) return false;
  const p = path.toLowerCase();
  return (path.startsWith(`${mockupDir}/`) && p.endsWith(".html")) || (path.startsWith(`${sequenceDir}/`) && p.endsWith(".md"));
}

/**
 * The versions of one mockup / sequence file: the commits on `ref` that touched it, newest first, at most 50.
 * @api machine-0085 @adr 0515
 */
export async function evidenceHistory(root: string, ref: string, path: string): Promise<EvidenceCommit[]> {
  const { stdout } = await run("git", ["-c", "core.quotepath=off", "log", "-n", "50", "--format=%H%x1f%cI%x1f%an%x1f%s", ref, "--", path], {
    cwd: root,
  });
  return String(stdout)
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [sha = "", at = "", author = "", subject = ""] = l.split("\x1f");
      return { sha, at, author, subject };
    })
    .filter((c) => /^[0-9a-f]{40}$/.test(c.sha));
}

/**
 * Restore a mockup / sequence file to its content at `rev`: write it back onto `<base>` as a new commit (the off-tree
 * base commit of ADR-0511 — mockups and sequences are work output since ADR-0563). `unchanged` when the file already
 * has that content.
 * @api machine-0086 @adr 0515 @adr 0563
 */
export async function restoreEvidenceVersion(
  root: string,
  base: string,
  dirs: { mockupDir: string; sequenceDir: string },
  path: string,
  rev: string,
  who: string,
): Promise<{ ok: true; result: "published" | "unchanged" } | { ok: false; error: string }> {
  if (!isVersionedEvidencePath(path, dirs.mockupDir, dirs.sequenceDir) || !EVIDENCE_REV_RE.test(rev)) {
    return { ok: false, error: "invalid evidence path or version" };
  }
  const bytes = await showBytes(root, rev, path);
  if (!bytes) return { ok: false, error: "this version does not contain the file" };
  const loc = await locateBase(root, path).catch(() => null);
  if (!loc || !base) return { ok: false, error: "no remote base branch to restore on" };
  try {
    const sha = await commitToBase(root, loc, [{ op: "put", path: loc.rel, data: bytes }], { message: `evidence: restore ${path} to ${rev.slice(0, 7)}`, by: who });
    return { ok: true, result: sha ? "published" : "unchanged" };
  } catch (err) {
    return { ok: false, error: `could not push the restore to ${base} (${err instanceof Error ? err.message : String(err)})` };
  }
}
