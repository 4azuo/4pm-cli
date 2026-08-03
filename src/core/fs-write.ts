/**
 * Write a file on the worker (fs.write channel — machine-0027, ADR-0151), clamped to the
 * physic-project root. The single Git-tab write not carried by a git command over dispatch;
 * used by manual merge-conflict resolution. A path escaping the root is rejected (never
 * silently redirected) so the browser can only write inside the project it serves.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import type { FsWriteReply } from "@4pm/ws";

/** Max bytes accepted for a single write (mirrors the read cap scale). */
const MAX_BYTES = 2 * 1024 * 1024;

/**
 * Resolve `relPath` inside `root`; return null when there is no root or the path escapes it.
 * (Unlike the read path's clamp-to-root, a write to an out-of-root path is refused outright.)
 */
function resolveInRoot(root: string | null, relPath: string): string | null {
  if (!root) return null;
  const base = resolve(root);
  const target = resolve(base, relPath || ".");
  return target === base || target.startsWith(base + sep) ? target : null;
}

/** Write `content` to `relPath` under the physic root. Never throws — errors map to `ok:false`. */
export async function writeWorkerFile(
  root: string | null,
  relPath: string,
  content: string,
): Promise<FsWriteReply> {
  const target = resolveInRoot(root, relPath);
  if (!target) {
    return { ok: false, path: relPath, bytes: 0, error: "path escapes the project root" };
  }
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_BYTES) {
    return { ok: false, path: target, bytes: 0, error: `content too large (max ${MAX_BYTES} bytes)` };
  }
  try {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
    return { ok: true, path: target, bytes };
  } catch (err) {
    return { ok: false, path: target, bytes: 0, error: err instanceof Error ? err.message : String(err) };
  }
}
