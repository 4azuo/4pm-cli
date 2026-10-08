/**
 * Book evidence in the repo (ADR-0404). Files attached to book rows live at
 * `<evidenceDir>/<BOOK>/<ROW-ID>/<k>-<name>` (default `.4pm/evidence`; configurable — ADR-0418, links under an
 * earlier root keep working) and are referenced from the cells as plain markdown links.
 * This module stages an uploaded file in the profile dir (outside the repo) until a `bookSave` commits it,
 * moves staged files into the books' worktree, prunes files no book references any more, carries a finished
 * task's evidence from AI_TODO to AI_DONE, lists the agent's own evidence on a task branch, and reads one
 * file for the web (`origin/<base>` → task branch → working tree) — an evidence file or an intake mockup (ADR-0418).
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, posix } from "node:path";
import { promisify } from "node:util";
import {
  EVIDENCE_BOOK_DIR,
  EVIDENCE_MAX_BYTES,
  EVIDENCE_PATH_RE,
  evidenceLinks,
  isEvidencePath,
  isSafeRepoDir,
  evidenceMarkdown,
  type EvidenceBookKey,
} from "@4pm/dto";
import type { AutonomousEvidenceReply } from "@4pm/ws";

const run = promisify(execFile);

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

/** Stage one uploaded evidence file in the profile dir; returns its id (machine-0072). */
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
 * path under the saved book's own folder of the configured evidence root `evRoot` (ADR-0418); a missing
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
    const target = join(dir, it.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, await readFile(join(profileDir, STAGE_DIR, it.stageId)));
    await rm(join(profileDir, STAGE_DIR, it.stageId), { force: true });
  }
  return null;
}

/** Every file under `rel` (repo-relative, posix), recursively. */
async function listFiles(root: string, rel: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(join(root, rel), { withFileTypes: true }).catch(() => [])) {
    const child = posix.join(rel, e.name);
    if (e.isDirectory()) out.push(...(await listFiles(root, child)));
    else out.push(child);
  }
  return out;
}

/** Remove now-empty folders under `rel` (deepest first). */
async function removeEmptyDirs(root: string, rel: string): Promise<void> {
  for (const e of await readdir(join(root, rel), { withFileTypes: true }).catch(() => [])) {
    if (e.isDirectory()) await removeEmptyDirs(root, posix.join(rel, e.name));
  }
  if ((await readdir(join(root, rel)).catch(() => ["x"])).length === 0) await rmdir(join(root, rel)).catch(() => undefined);
}

/**
 * The intake UI mockups (ADR-0418): `.html` files under `mockupDir` on `origin/<base>` (else the working tree),
 * as repo paths, sorted.
 */
export async function listMockups(root: string, base: string | null, mockupDir: string): Promise<string[]> {
  const keep = (paths: string[]): string[] =>
    paths.filter((p) => p.startsWith(`${mockupDir}/`) && p.toLowerCase().endsWith(".html") && isSafeRepoDir(p)).sort();
  if (base) {
    try {
      const { stdout } = await run("git", ["ls-tree", "-r", "--name-only", `origin/${base}`, "--", `${mockupDir}/`], { cwd: root });
      return keep(stdout.split("\n").map((l) => l.trim()).filter(Boolean));
    } catch {
      // No remote base — fall back to the working tree.
    }
  }
  return keep(await listFiles(root, mockupDir));
}

/** The text of every book in `dir` (missing ⇒ empty), joined — a file is "referenced" when its path appears. */
async function allBooksText(dir: string): Promise<string> {
  const texts = await Promise.all(BOOK_FILES.map((f) => readFile(join(dir, f), "utf8").catch(() => "")));
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
    if (!text.includes(f)) await rm(join(dir, f), { force: true });
  }
  // Each root a removed file lived under (evidence may sit under an earlier `evidenceDir` — ADR-0418).
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
 * handled in place (ADR-0418). No folder ⇒ nothing to do.
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
      await mkdir(dirname(join(root, dest)), { recursive: true });
      await rename(join(root, f), join(root, dest));
      moved.push(dest);
    }
    await removeEmptyDirs(root, `${evr}/AI_TODO`);
    for (const b of BOOK_FILES) {
      const p = join(root, b);
      const text = await readFile(p, "utf8").catch(() => null);
      if (text !== null && text.includes(`${from}/`)) await writeFile(p, text.replaceAll(`${from}/`, `${to}/`), "utf8");
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
 * Read one evidence file — or an intake mockup (`<mockupDir>/….html`, ADR-0418) — for the web (machine-0073):
 * `origin/<base>` first, then `origin/<ref>` (a task branch whose PR is not merged yet), then the working tree.
 */
export async function readEvidenceFile(
  root: string,
  base: string | null,
  path: string,
  ref: string | undefined,
  mockupDir: string,
): Promise<AutonomousEvidenceReply> {
  const mockup = isSafeRepoDir(path) && path.startsWith(`${mockupDir}/`) && path.toLowerCase().endsWith(".html");
  if (!isEvidencePath(path) && !mockup) return { error: "invalid evidence path" };
  if (ref && !/^[A-Za-z0-9._/-]{1,200}$/.test(ref)) return { error: "invalid ref" };
  let bytes: Buffer | null = null;
  if (base) bytes = await showBytes(root, `origin/${base}`, path);
  if (!bytes && ref) bytes = await showBytes(root, `origin/${ref}`, path);
  if (!bytes) bytes = await readFile(join(root, path)).catch(() => null);
  if (!bytes) return { error: "evidence not found" };
  // The reply rides one WS frame (8 MB): base64 of the 5 MB evidence cap fits, a bigger file is refused.
  if (bytes.length > EVIDENCE_MAX_BYTES) return { error: "evidence file too large" };
  return { contentBase64: bytes.toString("base64"), contentType: mimeOf(path), name: posix.basename(path), size: bytes.length };
}
