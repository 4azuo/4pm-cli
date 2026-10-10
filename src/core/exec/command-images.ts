/**
 * Console prompt attachments on the worker (ADR-0257; images and files). A web-dispatched full agent run may
 * carry image references (`[Image#N]` placeholders + uploaded ids); this module fetches each blob
 * from the server, materializes it **inside the served project folder** (so the folder-scope guard
 * lets the agent read it), rewrites the placeholders in the AI prompt to the on-disk paths, and
 * sweeps stale attachment dirs (>24h). Pure I/O helpers — the WS wiring lives in `ws-client`.
 * @adr 0388
 */
import { existsSync, lstatSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { CommandImageRef, ImageFetchReply } from "@4pm/ws";
import { commandImageExt } from "@4pm/dto";
import { logger } from "../../common/logger/logger";
import { mkdirInRootSync, resolveEntry, writeFileInRootSync } from "../../utils/safe-path";

/** Attachments live under `<physicRoot>/.4pm/attachments/` — inside the served folder. @adr 0257 */
export function attachmentsBaseDir(physicRoot: string): string {
  return join(physicRoot, ".4pm", "attachments");
}

/** Max age before a materialized attachment dir is swept: 24 hours. @adr 0257 */
export const ATTACHMENT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Materialize a dispatch's images into `<physicRoot>/.4pm/attachments/<commandId>/` and return a map
 * of each image's `[Image#N]` placeholder → the absolute file path. `fetch` pulls one blob (base64)
 * from the server; a failed/empty fetch is logged and the image is skipped (its placeholder stays
 * literal so the operator still sees it referenced). Returns an empty map when there is nothing to do.
 */
export async function materializeImages(
  physicRoot: string,
  commandId: string,
  images: CommandImageRef[],
  fetch: (imageId: string) => Promise<ImageFetchReply>,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (!images.length) return map;
  const dir = join(attachmentsBaseDir(physicRoot), commandId);
  // Symlink-safe (ADR-0430): a linked attachments folder cannot redirect the files outside the project.
  mkdirInRootSync(physicRoot, dir);
  let n = 0;
  for (const img of images) {
    n += 1;
    try {
      const reply = await fetch(img.id);
      if (!reply.dataBase64) {
        logger.warn("command.image.fetch.empty", { commandId, imageId: img.id, error: reply.error });
        continue;
      }
      const ext = commandImageExt(reply.mime ?? img.mime);
      const file = join(dir, `attachment-${n}.${ext}`);
      writeFileInRootSync(physicRoot, file, Buffer.from(reply.dataBase64, "base64"));
      map.set(img.placeholder, file);
    } catch (err) {
      logger.warn("command.image.fetch.failed", {
        commandId,
        imageId: img.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return map;
}

/**
 * Rewrite each `[Image#N]` placeholder in `prompt` to its materialized file path (wrapped in
 * backticks so the AI reads it as a path). Only the AI sees this — the transcript keeps the raw
 * prompt. Placeholders with no materialized file are left untouched.
 */
export function rewriteImagePlaceholders(prompt: string, paths: Map<string, string>): string {
  let out = prompt;
  for (const [placeholder, file] of paths) {
    out = out.split(placeholder).join(`\`${file}\``);
  }
  return out;
}

/**
 * Delete materialized attachment dirs older than `maxAgeMs` under the served folder.
 * Best-effort — a missing base dir or an unreadable entry is ignored. Returns the count removed.
 * @adr 0257
 */
export function sweepOldAttachments(physicRoot: string, maxAgeMs = ATTACHMENT_MAX_AGE_MS): number {
  const base = attachmentsBaseDir(physicRoot);
  if (!existsSync(base)) return 0;
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  try {
    for (const entry of readdirSync(base)) {
      const dir = resolveEntry(physicRoot, join(base, entry));
      if (!dir) continue;
      try {
        if (lstatSync(dir).mtimeMs < cutoff) {
          rmSync(dir, { recursive: true, force: true });
          removed += 1;
        }
      } catch {
        // Best-effort per entry — skip an unreadable/racing dir.
      }
    }
  } catch {
    // Best-effort — a listing error must never disrupt the session.
  }
  return removed;
}
