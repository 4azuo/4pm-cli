/**
 * Read a text file on the worker (fs.read channel) for the project dashboard
 * (page 0010 files tab). The path is resolved **relative to the physic-project root** and
 * clamped to it (ADR-0281) — the browser addresses files by project-relative paths and can
 * only read inward, never out (symmetric with fs.list/write/mutate). Content is capped so
 * large/binary files don't flood the WS link; a missing/out-of-root path yields empty content.
 */
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { FsReadReply } from "@4pm/ws";

/** Max bytes returned for a single file (larger ⇒ truncated). */
const MAX_BYTES = 256 * 1024;

/**
 * Resolve `relPath` inside `root`; return null when there is no root or the path escapes it.
 * Accepts a relative path (the web) or an absolute path already inside the root (older clients).
 */
function resolveInRoot(root: string | null, relPath: string): string | null {
  if (!root) return null;
  const base = resolve(root);
  const target = resolve(base, relPath || ".");
  return target === base || target.startsWith(base + sep) ? target : null;
}

/** Read a file (relative to the physic root) as UTF-8, truncating at the size cap. Never throws. */
export async function readWorkerFile(root: string | null, path: string): Promise<FsReadReply> {
  const target = resolveInRoot(root, path);
  if (!target) {
    // No served project, or the path escapes the root ⇒ nothing to read.
    return { path, content: "", truncated: false };
  }
  try {
    const buf = await readFile(target);
    const truncated = buf.byteLength > MAX_BYTES;
    const content = buf.subarray(0, MAX_BYTES).toString("utf8");
    return { path: target, content, truncated };
  } catch {
    return { path: target, content: "", truncated: false };
  }
}
