/**
 * The books overlay — on a REQ / DOC / TSK branch the books set is a read-only copy of the books branch, written
 * into the working tree and hidden from git, so the agent reads every book, sidecar, discussion, ER and diagram
 * file in place while nothing of it is ever committed. Paths tracked on the branch are marked
 * `--skip-worktree`; untracked ones are listed in `.git/info/exclude`. Books-set files the branch tracks but the
 * books branch no longer has are removed from the tree (same flags). The cli lifts the overlay before every merge,
 * checkout or WIP commit and applies it again afterwards, so git never merges a book path. The state of the
 * applied overlay is kept in `.git/4pm-overlay.json` so a crash is cleaned up by the next lift. The run's context
 * manifest rides the overlay the same way.
 * @adr 0563 @adr 0565
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isBooksSetPath, type BooksSetDirs } from "@4pm/dto";
import { gitQuiet } from "./autonomous-git";
import { execInProject } from "../agent/agent-spawn";
import { resolveEntry, writeFileInRoot } from "../../utils/safe-path";

/** The marker lines of the overlay block in `.git/info/exclude`. */
const EXCLUDE_BEGIN = "# 4pm-books-overlay begin";
const EXCLUDE_END = "# 4pm-books-overlay end";

/** What an applied overlay changed in one checkout. */
interface OverlayState {
  /** Index paths flagged `--skip-worktree` (written or removed in the tree). */
  tracked: string[];
  /** Untracked files written (excluded from git). */
  untracked: string[];
}

/** Paths per git call (keeps the argument list short). */
const CHUNK = 200;

/** `.git` folder of a checkout (the root of a normal clone). */
function gitDir(root: string): string {
  return join(root, ".git");
}

/** The overlay state file. */
function statePath(root: string): string {
  return join(gitDir(root), "4pm-overlay.json");
}

/** Run git over `paths` in chunks. */
async function gitChunks(root: string, args: string[], paths: readonly string[]): Promise<void> {
  for (let i = 0; i < paths.length; i += CHUNK) await gitQuiet(root, [...args, "--", ...paths.slice(i, i + CHUNK)]);
}

/** `git show <ref>:<path>` as bytes, or null. */
async function showBytes(root: string, ref: string, path: string): Promise<Buffer | null> {
  try {
    const { stdout } = await execInProject("git", ["show", `${ref}:${path}`], { cwd: root, encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
    return stdout as unknown as Buffer;
  } catch {
    return null;
  }
}

/** The books-set paths of a tree listing (`git ls-tree -r` / `git ls-files`). */
function booksPaths(listing: string, dirs: BooksSetDirs): string[] {
  return listing
    .split("\n")
    .map((l) => l.trim())
    .filter((p) => p && isBooksSetPath(p, dirs));
}

/** Read the saved overlay state (null when none is applied). */
async function readState(root: string): Promise<OverlayState | null> {
  try {
    const o = JSON.parse(await readFile(statePath(root), "utf8")) as Partial<OverlayState>;
    return { tracked: Array.isArray(o.tracked) ? o.tracked : [], untracked: Array.isArray(o.untracked) ? o.untracked : [] };
  } catch {
    return null;
  }
}

/** Write the overlay block into `.git/info/exclude` (replacing an earlier one). */
async function writeExclude(root: string, paths: readonly string[]): Promise<void> {
  const file = join(gitDir(root), "info", "exclude");
  const cur = await readFile(file, "utf8").catch(() => "");
  const kept = stripExcludeBlock(cur);
  const block = paths.length ? `${EXCLUDE_BEGIN}\n${paths.map((p) => `/${p}`).join("\n")}\n${EXCLUDE_END}\n` : "";
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${kept}${kept && !kept.endsWith("\n") ? "\n" : ""}${block}`, "utf8");
}

/** An exclude file without the overlay block. */
function stripExcludeBlock(text: string): string {
  const a = text.indexOf(EXCLUDE_BEGIN);
  if (a < 0) return text;
  const b = text.indexOf(EXCLUDE_END, a);
  return text.slice(0, a) + (b < 0 ? "" : text.slice(b + EXCLUDE_END.length).replace(/^\n/, ""));
}

/**
 * Apply the overlay of `booksRef` on the checked-out branch of `root`: every books-set file of the books branch is
 * written into the tree, every books-set file the branch tracks but the books branch lacks is removed, and git is
 * told to ignore them. An overlay already applied is lifted first. Returns the number of files written.
 */
export async function applyOverlay(root: string, booksRef: string, dirs: BooksSetDirs): Promise<number> {
  await liftOverlay(root);
  const fromBooks = booksPaths(await gitQuiet(root, ["ls-tree", "-r", "--name-only", booksRef]), dirs);
  const onBranch = new Set(booksPaths(await gitQuiet(root, ["ls-files"]), dirs));
  const tracked: string[] = [];
  const untracked: string[] = [];
  let written = 0;
  for (const p of fromBooks) {
    const bytes = await showBytes(root, booksRef, p);
    if (!bytes) continue;
    await writeFileInRoot(root, join(root, p), bytes);
    written++;
    (onBranch.has(p) ? tracked : untracked).push(p);
  }
  const inBooks = new Set(fromBooks);
  for (const p of onBranch) {
    if (inBooks.has(p)) continue;
    const abs = resolveEntry(root, join(root, p));
    if (abs) await rm(abs, { force: true });
    tracked.push(p);
  }
  await gitChunks(root, ["update-index", "--skip-worktree"], tracked);
  await writeExclude(root, untracked);
  await writeFile(statePath(root), JSON.stringify({ tracked, untracked } satisfies OverlayState), "utf8");
  return written;
}

/**
 * Lift the overlay: clear the skip-worktree flags and restore the branch's own version of those paths, delete the
 * untracked copies (and drop any of them an agent force-added to the index), remove the exclude block. A no-op
 * when no overlay is applied.
 */
export async function liftOverlay(root: string): Promise<void> {
  const st = await readState(root);
  if (!st) return;
  await gitChunks(root, ["update-index", "--no-skip-worktree"], st.tracked);
  await gitChunks(root, ["checkout", "-q", "HEAD"], st.tracked);
  // An agent may have force-added an untracked copy: it leaves the index with the file.
  await gitChunks(root, ["rm", "-q", "--cached", "--ignore-unmatch"], st.untracked);
  for (const p of st.untracked) {
    const abs = resolveEntry(root, join(root, p));
    if (abs) await rm(abs, { force: true });
  }
  await writeExclude(root, []);
  await rm(statePath(root), { force: true });
}

/**
 * Write one more never-committed file into an applied overlay (the run's context manifest — ADR-0565): it is
 * excluded from git and removed by the next lift like the books copies. False when no overlay is applied.
 */
export async function addOverlayFile(root: string, rel: string, content: string): Promise<boolean> {
  const st = await readState(root);
  if (!st) return false;
  await writeFileInRoot(root, join(root, rel), content);
  if (!st.untracked.includes(rel)) st.untracked.push(rel);
  await writeExclude(root, st.untracked);
  await writeFile(statePath(root), JSON.stringify(st satisfies OverlayState), "utf8");
  return true;
}

/** Is an overlay applied in this checkout? */
export async function overlayApplied(root: string): Promise<boolean> {
  return (await readState(root)) !== null;
}

