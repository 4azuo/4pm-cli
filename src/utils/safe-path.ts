/**
 * Symlink-safe access to files under a project root. A lexical `resolve` +
 * `startsWith` check is not enough: a symlink committed to the repo (`leak -> ../credential.cre`) or an
 * intermediate symlinked folder would make a read return — or a write overwrite — a file outside the
 * project (the worker's `.cre`, `config.json`…). Every project path the cli reads or writes goes through
 * these helpers:
 *
 * - **read** — the target's real path must be inside the root's real path;
 * - **write** — the real path of the nearest existing ancestor must be inside the root (so `mkdir -p`
 *   cannot walk through a symlinked folder), the target itself must not be a symlink, and the file is
 *   opened with `O_NOFOLLOW`;
 * - **entry** — delete / move / rename act on the entry itself (a link, not its target), so only its
 *   parent folder has to be inside the root.
 * @adr 0430 phase 0
 */
import { constants, existsSync, lstatSync, mkdirSync, openSync, closeSync, realpathSync, writeSync } from "node:fs";
import { lstat, mkdir, open, readFile, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";

/** Raised when a path would leave the project root (lexically or through a symlink). */
export class PathEscapeError extends Error {
  /** Build the error for the offending path. */
  constructor(path: string) {
    super(`Path is outside the project folder: ${path}`);
    this.name = "PathEscapeError";
  }
}

/** True when `p` is `base` or below it (both already absolute, normalized). */
function within(base: string, p: string): boolean {
  return p === base || p.startsWith(base.endsWith(sep) ? base : base + sep);
}

/** The root's real path (falls back to the resolved path when it does not exist yet). */
function realRootSync(root: string): string {
  const abs = resolve(root);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

/** The real path of `p`, or of its nearest existing ancestor joined with the missing tail. */
function realOrAncestorSync(p: string): string {
  let cur = p;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(cur);
      return tail.length ? join(real, ...tail.reverse()) : real;
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return p;
      tail.push(basename(cur));
      cur = parent;
    }
  }
}

/**
 * Resolve `rel` (or an absolute path) against `root` lexically; null when it escapes. The lexical step
 * alone is what the old per-module `resolveInRoot` copies did — callers use the checks below on top.
 */
export function lexicalInRoot(root: string | null, rel: string): string | null {
  if (!root) return null;
  const base = resolve(root);
  const target = resolve(base, rel || ".");
  return within(base, target) ? target : null;
}

/**
 * Resolve a project path for **reading**: lexically inside the root AND its real path inside
 * the root's real path. Returns the real path (read through it — no symlink left to swap), or the lexical
 * path when the target does not exist (the caller's read then fails with ENOENT). Null when it escapes.
 */
export function resolveForRead(root: string | null, rel: string): string | null {
  const target = lexicalInRoot(root, rel);
  if (!target || !root) return null;
  const realRoot = realRootSync(root);
  if (!existsSync(target)) return within(realRoot, realOrAncestorSync(target)) ? target : null;
  let real: string;
  try {
    real = realpathSync(target);
  } catch {
    return null;
  }
  return within(realRoot, real) ? real : null;
}

/**
 * Resolve a project path for **writing**: lexically inside the root, the nearest existing
 * ancestor's real path inside the root, and the target not a symlink. Returns the path to write (under the
 * parent's real path). Null when it escapes or the target is a symlink.
 */
export function resolveForWrite(root: string | null, rel: string): string | null {
  const target = lexicalInRoot(root, rel);
  if (!target || !root) return null;
  if (target === resolve(root)) return null;
  const realRoot = realRootSync(root);
  const parentReal = realOrAncestorSync(dirname(target));
  if (!within(realRoot, parentReal)) return null;
  try {
    if (lstatSync(target).isSymbolicLink()) return null;
  } catch {
    // missing ⇒ a new file, fine
  }
  return join(parentReal, basename(target));
}

/**
 * Resolve a project path whose **entry itself** is acted on (delete / move / rename / stat of a link —
 * ADR-0430): only the parent folder must really be inside the root; the entry may be a symlink (removing
 * or renaming a link never touches its target). Null when it escapes or names the root itself.
 */
export function resolveEntry(root: string | null, rel: string): string | null {
  const target = lexicalInRoot(root, rel);
  if (!target || !root) return null;
  if (target === resolve(root)) return null;
  const realRoot = realRootSync(root);
  const parentReal = realOrAncestorSync(dirname(target));
  return within(realRoot, parentReal) ? join(parentReal, basename(target)) : null;
}

/** Make `dir` (under `root`) and its parents, refusing to walk through a folder that leads outside. */
export async function mkdirInRoot(root: string, dir: string): Promise<void> {
  const realRoot = realRootSync(root);
  if (!within(realRoot, realOrAncestorSync(resolve(dir)))) throw new PathEscapeError(dir);
  await mkdir(dir, { recursive: true });
  if (!within(realRoot, await realpath(dir))) throw new PathEscapeError(dir);
}

/** Sync variant of {@link mkdirInRoot}. */
export function mkdirInRootSync(root: string, dir: string): void {
  const realRoot = realRootSync(root);
  if (!within(realRoot, realOrAncestorSync(resolve(dir)))) throw new PathEscapeError(dir);
  mkdirSync(dir, { recursive: true });
  if (!within(realRoot, realpathSync(dir))) throw new PathEscapeError(dir);
}

/** Read a project file (absolute or root-relative path) only when it really is inside `root`. */
export async function readFileInRoot(root: string, path: string): Promise<Buffer>;
export async function readFileInRoot(root: string, path: string, encoding: BufferEncoding): Promise<string>;
export async function readFileInRoot(root: string, path: string, encoding?: BufferEncoding): Promise<Buffer | string> {
  const safe = resolveForRead(root, path);
  if (!safe) throw new PathEscapeError(path);
  return encoding ? readFile(safe, encoding) : readFile(safe);
}

/** Flags for a write that refuses to follow a symlink at the final path component. */
const WRITE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW;

/**
 * Write a project file (absolute or root-relative path) only when it really is inside `root`: creates the
 * missing parent folders safely, refuses a symlink target, and opens with `O_NOFOLLOW`.
 */
export async function writeFileInRoot(root: string, path: string, data: string | Uint8Array, mode?: number): Promise<void> {
  const lexical = lexicalInRoot(root, path);
  if (!lexical) throw new PathEscapeError(path);
  await mkdirInRoot(root, dirname(lexical));
  const safe = resolveForWrite(root, lexical);
  if (!safe) throw new PathEscapeError(path);
  const handle = await open(safe, WRITE_FLAGS, mode ?? 0o666);
  try {
    await handle.writeFile(data);
  } finally {
    await handle.close();
  }
}

/** Sync variant of {@link writeFileInRoot}. */
export function writeFileInRootSync(root: string, path: string, data: string | Uint8Array, mode?: number): void {
  const lexical = lexicalInRoot(root, path);
  if (!lexical) throw new PathEscapeError(path);
  mkdirInRootSync(root, dirname(lexical));
  const safe = resolveForWrite(root, lexical);
  if (!safe) throw new PathEscapeError(path);
  const fd = openSync(safe, WRITE_FLAGS, mode ?? 0o666);
  try {
    const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    let off = 0;
    while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
  } finally {
    closeSync(fd);
  }
}

/** True when the path exists and is a symlink (never follows it). */
export async function isSymlink(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isSymbolicLink();
  } catch {
    return false;
  }
}
