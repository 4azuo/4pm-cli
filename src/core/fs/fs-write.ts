/**
 * Write a file on the worker (fs.write channel), clamped to the
 * physic-project root. The single Git-tab write not carried by a git command over dispatch;
 * used by manual merge-conflict resolution. A path escaping the root is rejected (never
 * silently redirected) so the browser can only write inside the project it serves — symlinks included.
 * @api machine-0027 @adr 0430 @adr 0151
 */
import type { FsWriteReply } from "@4pm/ws";
import { lexicalInRoot, writeFileInRoot } from "../../utils/safe-path";

/** Max bytes accepted for a single write (mirrors the read cap scale). */
const MAX_BYTES = 2 * 1024 * 1024;

/** Write `content` to `relPath` under the physic root. Never throws — errors map to `ok:false`. */
export async function writeWorkerFile(
  root: string | null,
  relPath: string,
  content: string,
): Promise<FsWriteReply> {
  const target = lexicalInRoot(root, relPath);
  if (!root || !target) {
    return { ok: false, path: relPath, bytes: 0, error: "path escapes the project root" };
  }
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_BYTES) {
    return { ok: false, path: target, bytes: 0, error: `content too large (max ${MAX_BYTES} bytes)` };
  }
  try {
    // Symlink-safe: never writes through a link or a linked folder to outside the project.
    await writeFileInRoot(root, target, content);
    return { ok: true, path: target, bytes };
  } catch (err) {
    return { ok: false, path: target, bytes: 0, error: err instanceof Error ? err.message : String(err) };
  }
}
