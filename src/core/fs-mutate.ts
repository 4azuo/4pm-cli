/**
 * File mutations on the worker (fs.mutate channel — machine-0059, ADR-0260): create a folder
 * (`mkdir`) or file (`create`), `move` (also rename), or `delete` a file/folder — each **clamped
 * to the physic-project root**. A path escaping the root is refused outright (never redirected), so
 * the browser can only mutate inside the project it serves. Never throws — errors map to `ok:false`.
 */
import { mkdir, writeFile, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, resolve, sep } from "node:path";
import type { FsMutateReply, FsMutateRequest } from "@4pm/ws";

/** Max bytes for a seeded new file (mirrors the write cap). */
const MAX_BYTES = 2 * 1024 * 1024;

/** Resolve `rel` inside `root`; null when there is no root or the path escapes it. */
function resolveInRoot(root: string, rel: string): string | null {
  const base = resolve(root);
  const target = resolve(base, rel || ".");
  return target === base || target.startsWith(base + sep) ? target : null;
}

/** True when `p` exists and is a directory. */
async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/** True when `p` exists. */
async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
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
        const target = resolveInRoot(root, req.path ?? "");
        if (!target || target === resolve(root)) return escaped(req.path ?? "");
        await mkdir(target, { recursive: true });
        return { ok: true, path: target };
      }
      case "create": {
        const target = resolveInRoot(root, req.path ?? "");
        if (!target || target === resolve(root)) return escaped(req.path ?? "");
        if (await exists(target)) return { ok: false, path: target, error: "already exists" };
        const content = req.content ?? "";
        if (Buffer.byteLength(content, "utf8") > MAX_BYTES) {
          return { ok: false, path: target, error: `content too large (max ${MAX_BYTES} bytes)` };
        }
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, content, "utf8");
        return { ok: true, path: target };
      }
      case "move": {
        const from = resolveInRoot(root, req.from ?? "");
        let to = resolveInRoot(root, req.to ?? "");
        if (!from || !to) return escaped(req.from ?? req.to ?? "");
        if (from === resolve(root)) return { ok: false, path: from, error: "cannot move the project root" };
        // Dropping onto an existing folder ⇒ move INTO it (keep the source name).
        if (await isDir(to)) to = resolve(to, basename(from));
        if (to !== resolve(root) && !to.startsWith(resolve(root) + sep)) return escaped(req.to ?? "");
        if (await exists(to)) return { ok: false, path: to, error: "destination already exists" };
        await mkdir(dirname(to), { recursive: true });
        await rename(from, to);
        return { ok: true, path: to };
      }
      case "delete": {
        const target = resolveInRoot(root, req.path ?? "");
        if (!target) return escaped(req.path ?? "");
        if (target === resolve(root)) return { ok: false, path: target, error: "cannot delete the project root" };
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
