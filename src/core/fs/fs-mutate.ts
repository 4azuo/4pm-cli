/**
 * File mutations on the worker (fs.mutate channel): create a folder
 * (`mkdir`) or file (`create`), `move` (also rename), or `delete` a file/folder — each **clamped
 * to the physic-project root**. A path escaping the root is refused outright (never redirected), so
 * the browser can only mutate inside the project it serves. Never throws — errors map to `ok:false`.
 * @api machine-0059 @adr 0260
 */
import { lstat, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import type { FsMutateReply, FsMutateRequest } from "@4pm/ws";
import { lexicalInRoot, mkdirInRoot, resolveEntry, resolveForRead, writeFileInRoot } from "../../utils/safe-path";

/** Max bytes for a seeded new file (mirrors the write cap). */
const MAX_BYTES = 2 * 1024 * 1024;

/** True when `p` exists and is a directory. */
async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/** True when `p` exists (a dangling symlink counts — it is never followed). */
async function exists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

/** Apply one file mutation under the physic root. */
export async function mutateFs(root: string | null, req: FsMutateRequest): Promise<FsMutateReply> {
  if (!root) return { ok: false, path: req.path ?? req.from ?? "", error: "no project served" };
  const escaped = (p: string): FsMutateReply => ({ ok: false, path: p, error: "path escapes the project root" });
  try {
    switch (req.op) {
      case "mkdir": {
        const target = lexicalInRoot(root, req.path ?? "");
        if (!target || target === resolve(root)) return escaped(req.path ?? "");
        // Symlink-safe (ADR-0430): never creates folders through a link that leads outside.
        await mkdirInRoot(root, target);
        return { ok: true, path: target };
      }
      case "create": {
        const target = lexicalInRoot(root, req.path ?? "");
        if (!target || target === resolve(root)) return escaped(req.path ?? "");
        if (await exists(target)) return { ok: false, path: target, error: "already exists" };
        const content = req.content ?? "";
        if (Buffer.byteLength(content, "utf8") > MAX_BYTES) {
          return { ok: false, path: target, error: `content too large (max ${MAX_BYTES} bytes)` };
        }
        await writeFileInRoot(root, target, content);
        return { ok: true, path: target };
      }
      case "move": {
        if (lexicalInRoot(root, req.from ?? "") === resolve(root)) {
          return { ok: false, path: resolve(root), error: "cannot move the project root" };
        }
        // Symlink-safe (ADR-0430): the entry itself moves (a link stays a link); both parents must really
        // be inside the root, and "move into a folder" only follows a folder that really is inside.
        const from = resolveEntry(root, req.from ?? "");
        let to = lexicalInRoot(root, req.to ?? "");
        if (!from || !to) return escaped(req.from ?? req.to ?? "");
        // Dropping onto an existing folder ⇒ move INTO it (keep the source name).
        if (await isDir(to)) {
          if (!resolveForRead(root, to)) return escaped(req.to ?? "");
          to = resolve(to, basename(from));
        }
        const dest = resolveEntry(root, to);
        if (!dest) return escaped(req.to ?? "");
        if (await exists(dest)) return { ok: false, path: dest, error: "destination already exists" };
        await mkdirInRoot(root, dirname(dest));
        await rename(from, dest);
        return { ok: true, path: dest };
      }
      case "delete": {
        if (lexicalInRoot(root, req.path ?? "") === resolve(root)) {
          return { ok: false, path: resolve(root), error: "cannot delete the project root" };
        }
        // Symlink-safe (ADR-0430): removes the entry itself (a link, never its target); `rm` does not
        // follow links inside a folder either.
        const target = resolveEntry(root, req.path ?? "");
        if (!target) return escaped(req.path ?? "");
        await rm(target, { recursive: true, force: true });
        return { ok: true, path: target };
      }
      default:
        return { ok: false, path: "", error: "unknown op" };
    }
  } catch (err) {
    return { ok: false, path: req.path ?? req.from ?? "", error: err instanceof Error ? err.message : String(err) };
  }
}
