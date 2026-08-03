/**
 * Directory browsing on the worker (machine-0007, fs.list channel): the server
 * asks the project cli to list a folder so the web FsPicker can browse the physic
 * project. The listing is **scoped to the physic project root** — an empty/blank
 * path ⇒ the root itself, and any path that would escape the root is clamped back
 * to it (the tree only goes inward — never out). An unreadable path ⇒ empty.
 */
import { readdir } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { FsListReply } from "@4pm/ws";

/**
 * List a directory on the worker (within `root`), dirs first then files, sorted by
 * name. `root` null (no project served) ⇒ nothing to browse. Never throws — an
 * unreadable path yields an empty listing.
 */
export async function listDir(path: string, root: string | null): Promise<FsListReply> {
  if (!root) return { path: "", entries: [] };
  const base = resolve(root);
  // Resolve within the root; clamp anything that escapes (e.g. "..") back to it.
  const requested = resolve(base, path && path.trim() ? path : ".");
  const target = requested === base || requested.startsWith(base + sep) ? requested : base;
  try {
    const dirents = await readdir(target, { withFileTypes: true });
    const entries = dirents.map((d) => ({
      name: d.name,
      type: d.isDirectory() ? ("dir" as const) : ("file" as const),
    }));
    entries.sort((a, b) =>
      a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1,
    );
    return { path: target, entries };
  } catch {
    return { path: target, entries: [] };
  }
}
