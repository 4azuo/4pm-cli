/**
 * Git diff on the worker (git.diff channel): return a file's content at HEAD
 * (old) and in the working tree (new) so the dashboard can render a diff (e.g. what
 * the AI changed). Text files ride in `oldContent`/`newContent` (Monaco diff); binary
 * files (images) are detected and ride as base64 in `*Base64` with a `contentType`, so
 * the dashboard renders an image before/after instead of garbled text.
 * Untracked/new files ⇒ empty old content. The path is resolved **relative to the
 * physic-project root** and clamped to it — the browser addresses files by
 * project-relative paths, never out of the served root.
 * @adr 0282 @adr 0281
 */
import { readFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { FS_TRANSFER_MAX_BYTES } from "@4pm/dto";
import type { GitDiffReply } from "@4pm/ws";
import { guessMime } from "../fs/fs-transfer";
import { lexicalInRoot, resolveForRead } from "../../utils/safe-path";
import { execInProject } from "../agent/agent-spawn";

// Project git runs as the agent user when uid separation is on (ADR-0430); unchanged otherwise.
const run = execInProject;

/** Heuristic (git's own): a NUL byte in the first chunk ⇒ treat the file as binary. */
function looksBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8000).includes(0);
}

/** A buffer's base64, or "" when it is missing or over the transfer cap. */
function cappedBase64(buf: Buffer | null): string {
  if (!buf || buf.byteLength > FS_TRANSFER_MAX_BYTES) return "";
  return buf.toString("base64");
}

/** Read HEAD vs working-tree content for one file (relative to the physic root). Never throws. */
export async function gitDiff(root: string | null, path: string): Promise<GitDiffReply> {
  const target = lexicalInRoot(root, path);
  // Symlink-safe (ADR-0430): a link (or a linked folder) that really leads outside the root shows nothing.
  const real = resolveForRead(root, path);
  if (!target || !real) {
    return { path, oldContent: "", newContent: "", isBinary: false };
  }
  const dir = dirname(target);
  const base = basename(target);

  // Working-tree bytes (missing/unreadable for a deleted file ⇒ null).
  let newBuf: Buffer | null = null;
  try {
    newBuf = await readFile(real);
  } catch {
    // missing/unreadable ⇒ no new content
  }

  // HEAD bytes as raw buffer (untracked/new file or not a git repo ⇒ null).
  let oldBuf: Buffer | null = null;
  try {
    const { stdout } = await run("git", ["show", `HEAD:./${base}`], {
      cwd: dir,
      timeout: 15_000,
      maxBuffer: FS_TRANSFER_MAX_BYTES + 1024,
      encoding: "buffer",
    });
    oldBuf = stdout as unknown as Buffer;
  } catch {
    // untracked/new file, over maxBuffer, or not a git repo ⇒ no old content
  }

  // Decide by whichever side exists (a file added or deleted still classifies correctly).
  const sample = newBuf ?? oldBuf;
  if (sample && looksBinary(sample)) {
    return {
      path: target,
      oldContent: "",
      newContent: "",
      isBinary: true,
      contentType: guessMime(target),
      oldContentBase64: cappedBase64(oldBuf),
      newContentBase64: cappedBase64(newBuf),
    };
  }

  return {
    path: target,
    oldContent: oldBuf ? oldBuf.toString("utf8") : "",
    newContent: newBuf ? newBuf.toString("utf8") : "",
    isBinary: false,
  };
}
