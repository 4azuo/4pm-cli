/**
 * Read a text file on the worker (fs.read channel) for the project dashboard
 * (page 0010 files tab). Content is capped so large/binary files don't flood the
 * WS link; an unreadable path yields empty content.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { FsReadReply } from "@4pm/ws";

/** Max bytes returned for a single file (larger ⇒ truncated). */
const MAX_BYTES = 256 * 1024;

/** Read a file as UTF-8, truncating at the size cap. Never throws. */
export async function readWorkerFile(path: string): Promise<FsReadReply> {
  const target = resolve(path);
  try {
    const buf = await readFile(target);
    const truncated = buf.byteLength > MAX_BYTES;
    const content = buf.subarray(0, MAX_BYTES).toString("utf8");
    return { path: target, content, truncated };
  } catch {
    return { path: target, content: "", truncated: false };
  }
}
