/**
 * `audit.scope` — the folder tree of the served project for the AI-audit action editor: every folder (down to 4
 * levels) with its file count and bytes (`.git`, `node_modules` and `.4pm` left out, symlinks not followed), and the
 * size of the selected folders minus the excluded globs. Bounded walk; never throws.
 * @adr 0699 @arch 0077
 */
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { AuditScopeFolderWire, AuditScopeReply, AuditScopeRequest } from "@4pm/ws";
import { isIgnored } from "../../docs/doc-model";

/** Folders never walked. */
const SKIP = new Set([".git", "node_modules", ".4pm"]);
/** Most files counted (a huge repo stops here). */
const MAX_FILES = 300_000;
/** Depth of the tree returned. */
const TREE_DEPTH = 4;

/** One counted file. */
interface FileEntry {
  path: string;
  size: number;
}

/** Walk `root` and list its files (repo-relative, `/`-separated). */
async function walk(root: string): Promise<FileEntry[]> {
  const out: FileEntry[] = [];
  const stack = [""];
  while (stack.length && out.length < MAX_FILES) {
    const rel = stack.pop()!;
    let entries;
    try {
      entries = await readdir(join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (out.length >= MAX_FILES) break;
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP.has(e.name)) stack.push(p);
      } else if (e.isFile()) {
        const st = await lstat(join(root, p)).catch(() => null);
        out.push({ path: p, size: st?.size ?? 0 });
      }
    }
  }
  return out;
}

/** The folder tree (cumulative counts) of a file list. */
export function scopeTree(files: FileEntry[]): AuditScopeFolderWire {
  const root: AuditScopeFolderWire = { path: "", files: 0, bytes: 0, children: [] };
  const index = new Map<string, AuditScopeFolderWire>([["", root]]);
  for (const f of files) {
    root.files += 1;
    root.bytes += f.size;
    const parts = f.path.split("/").slice(0, -1);
    let parent = root;
    for (let i = 0; i < parts.length && i < TREE_DEPTH; i++) {
      const p = parts.slice(0, i + 1).join("/");
      let node = index.get(p);
      if (!node) {
        node = { path: p, files: 0, bytes: 0, children: [] };
        index.set(p, node);
        parent.children.push(node);
      }
      node.files += 1;
      node.bytes += f.size;
      parent = node;
    }
  }
  const sort = (n: AuditScopeFolderWire): void => {
    n.children.sort((a, b) => a.path.localeCompare(b.path));
    n.children.forEach(sort);
  };
  sort(root);
  return root;
}

/** Files of the selected folders minus the excluded globs. */
export function scopeSize(files: FileEntry[], folders: string[], exclude: string[]): { files: number; bytes: number } {
  const roots = folders.map((f) => f.replace(/^\.?\/+|\/+$/g, "")).filter(Boolean);
  let count = 0;
  let bytes = 0;
  for (const f of files) {
    if (!roots.some((r) => f.path === r || f.path.startsWith(`${r}/`))) continue;
    if (exclude.length && isIgnored(f.path, exclude)) continue;
    count += 1;
    bytes += f.size;
  }
  return { files: count, bytes };
}

/** `audit.scope` on the project at `root`. */
export async function auditScope(root: string, req: AuditScopeRequest): Promise<AuditScopeReply> {
  try {
    const files = await walk(root);
    return { ok: true, tree: scopeTree(files), selected: scopeSize(files, req.folders ?? [], req.exclude ?? []) };
  } catch (err) {
    return { ok: false, code: "AUDIT_SCOPE_FAILED", error: err instanceof Error ? err.message : String(err) };
  }
}
