/**
 * Read a text file on the worker (fs.read channel) for the project dashboard
 * (page 0010 files tab). The path is resolved **relative to the physic-project root** and
 * clamped to it — the browser addresses files by project-relative paths and can
 * only read inward, never out (symmetric with fs.list/write/mutate) — symlinks included. Content is capped so
 * large/binary files don't flood the WS link; a missing/out-of-root path yields empty content.
 * @adr 0281 @adr 0430
 */
import { readFile } from "node:fs/promises";
import type { FsReadReply } from "@4pm/ws";
import { lexicalInRoot, resolveForRead } from "../../utils/safe-path";

/** Max bytes returned for a single file (larger ⇒ truncated). */
const MAX_BYTES = 256 * 1024;

/** Read a file (relative to the physic root) as UTF-8, truncating at the size cap. Never throws. */
export async function readWorkerFile(root: string | null, path: string): Promise<FsReadReply> {
  const target = lexicalInRoot(root, path);
  // Symlink-safe: the real path must stay inside the root — a link to the worker's secrets
  // reads as nothing.
  const real = resolveForRead(root, path);
  if (!target || !real) {
    // No served project, or the path escapes the root ⇒ nothing to read.
    return { path, content: "", truncated: false };
  }
  try {
    const buf = await readFile(real);
    const truncated = buf.byteLength > MAX_BYTES;
    const content = buf.subarray(0, MAX_BYTES).toString("utf8");
    return { path: target, content, truncated };
  } catch {
    return { path: target, content: "", truncated: false };
  }
}
