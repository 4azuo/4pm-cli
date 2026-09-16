/**
 * Binary file transfer on the worker (fs.upload / fs.download channels — machine-0061/0062,
 * ADR-0278), clamped to the physic-project root and size-capped. Uploads write an uploaded/pasted
 * file's bytes into the tree; downloads return a file's raw bytes as base64 for the browser to save.
 * A path escaping the root is refused outright (never redirected) so the browser can only touch the
 * project it serves. Binary the text-only fs.read/fs.write can't carry.
 */
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, resolve, sep } from "node:path";
import { FS_TRANSFER_MAX_BYTES } from "@4pm/dto";
import type { FsDownloadReply, FsUploadReply } from "@4pm/ws";

/**
 * Resolve `relPath` inside `root`; return null when there is no root or the path escapes it (a
 * transfer to an out-of-root path is refused, mirroring `fs-write.ts`).
 */
function resolveInRoot(root: string | null, relPath: string): string | null {
  if (!root) return null;
  const base = resolve(root);
  const target = resolve(base, relPath || ".");
  return target === base || target.startsWith(base + sep) ? target : null;
}

/** Minimal extension → MIME map for the download save dialog; unknown ⇒ octet-stream. */
const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".json": "application/json",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".html": "text/html",
  ".xml": "application/xml",
};

/** Best-effort content type for a file path. */
export function guessMime(path: string): string {
  return MIME_BY_EXT[extname(path).toLowerCase()] ?? "application/octet-stream";
}

/**
 * Write an uploaded/pasted file's base64 bytes to `relPath` under the physic root. Never throws —
 * a bad path / oversize / write failure maps to `ok:false`.
 */
export async function uploadBinaryFile(
  root: string | null,
  relPath: string,
  contentBase64: string,
): Promise<FsUploadReply> {
  const target = resolveInRoot(root, relPath);
  if (!target) {
    return { ok: false, path: relPath, bytes: 0, error: "path escapes the project root" };
  }
  let buf: Buffer;
  try {
    buf = Buffer.from(contentBase64, "base64");
  } catch {
    return { ok: false, path: target, bytes: 0, error: "invalid base64 payload" };
  }
  if (buf.byteLength > FS_TRANSFER_MAX_BYTES) {
    return { ok: false, path: target, bytes: 0, error: `file too large (max ${FS_TRANSFER_MAX_BYTES} bytes)` };
  }
  try {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, buf);
    return { ok: true, path: target, bytes: buf.byteLength };
  } catch (err) {
    return { ok: false, path: target, bytes: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Read a file's raw bytes (as base64) from `relPath` under the physic root. Never throws — an
 * unreadable / over-cap file / an escaping path maps to `error` (no payload), never a silent cut.
 */
export async function downloadBinaryFile(
  root: string | null,
  relPath: string,
): Promise<FsDownloadReply> {
  const target = resolveInRoot(root, relPath);
  if (!target) return { error: "path escapes the project root" };
  try {
    const info = await stat(target);
    if (!info.isFile()) return { error: "not a file" };
    if (info.size > FS_TRANSFER_MAX_BYTES) {
      return { error: `file too large (max ${FS_TRANSFER_MAX_BYTES} bytes)` };
    }
    const buf = await readFile(target);
    return {
      contentBase64: buf.toString("base64"),
      contentType: guessMime(target),
      name: basename(target),
      size: buf.byteLength,
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
