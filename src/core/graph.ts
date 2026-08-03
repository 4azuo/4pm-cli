/**
 * Docs & code dependency graph on the worker (ADR-0155, graph.build channel). Builds a
 * `{ nodes, edges, orphans }` graph of the physic project — **docs** mode (each `.md` a node,
 * markdown links the edges) or **code** mode (each function a node, name-references the edges).
 * Deterministic + bounded (caps on files/nodes) — no tokens; the heuristic code analysis is
 * approximate (name-based, not a precise call graph). Orphans = nodes nothing links to (unused).
 * Never throws — errors map to an empty graph.
 */
import { readFile, readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join, relative, dirname, resolve, extname, basename } from "node:path";
import type { GraphBuildReply, GraphEdge, GraphNode } from "@4pm/ws";

const MAX_FILES = 2000;
const MAX_NODES = 3000;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "out", "coverage", ".turbo"]);
const CODE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java", ".rb", ".php"]);

/** Walk the tree collecting files with an accepted extension (bounded, skips heavy dirs). */
async function walk(root: string, accept: (p: string) => boolean): Promise<string[]> {
  const out: string[] = [];
  const stack = [root];
  while (stack.length && out.length < MAX_FILES) {
    const dir = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") && e.name !== ".claude") {
        if (e.isDirectory()) continue;
      }
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(full);
      } else if (accept(full)) {
        out.push(full);
        if (out.length >= MAX_FILES) break;
      }
    }
  }
  return out;
}

/** Compute the orphan set (node ids with no inbound edge — unused/unreferenced). */
function orphansOf(nodes: GraphNode[], edges: GraphEdge[]): string[] {
  const hasInbound = new Set(edges.map((e) => e.to));
  return nodes.filter((n) => !hasInbound.has(n.id)).map((n) => n.id);
}

/** Build the docs graph: a node per `.md`, an edge per markdown link to another doc. */
async function buildDocs(root: string): Promise<GraphBuildReply> {
  const files = await walk(root, (p) => extname(p) === ".md");
  const ids = new Set(files.map((f) => relative(root, f).split("\\").join("/")));
  const nodes: GraphNode[] = files.map((f) => {
    const rel = relative(root, f).split("\\").join("/");
    return { id: rel, label: basename(rel), kind: "doc", file: rel };
  });
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    const rel = relative(root, f).split("\\").join("/");
    let text = "";
    try {
      text = await readFile(f, "utf8");
    } catch {
      continue;
    }
    for (const m of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const href = (m[1] ?? "").split("#")[0]!.trim();
      if (!href || !href.endsWith(".md") || href.startsWith("http")) continue;
      const target = relative(root, resolve(dirname(f), href)).split("\\").join("/");
      if (ids.has(target) && target !== rel) {
        const key = `${rel}->${target}`;
        if (!seen.has(key)) {
          seen.add(key);
          edges.push({ from: rel, to: target });
        }
      }
    }
  }
  return { nodes, edges, orphans: orphansOf(nodes, edges) };
}

/** One function definition found in a file. */
interface Def {
  name: string;
  id: string;
  start: number;
}

/** Heuristic function-definition patterns (name in group 1). */
const DEF_PATTERNS = [
  /\bfunction\s+([A-Za-z_$][\w$]*)/g, // JS/TS function decl
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/g, // arrow/func expr
  /^\s*def\s+([A-Za-z_]\w*)/gm, // Python
  /\bfunc\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/g, // Go
];

/** Build the code graph: a node per function, an edge when one function calls another by name. */
async function buildCode(root: string): Promise<GraphBuildReply> {
  const files = await walk(root, (p) => CODE_EXT.has(extname(p)));
  const nodes: GraphNode[] = [];
  const nameToIds = new Map<string, string[]>();
  const fileDefs = new Map<string, { rel: string; text: string; defs: Def[] }>();

  for (const f of files) {
    if (nodes.length >= MAX_NODES) break;
    const rel = relative(root, f).split("\\").join("/");
    let text = "";
    try {
      text = await readFile(f, "utf8");
    } catch {
      continue;
    }
    const defs: Def[] = [];
    for (const re of DEF_PATTERNS) {
      for (const m of text.matchAll(re)) {
        const name = m[1] ?? "";
        if (!name || name.length < 2) continue;
        const id = `${rel}#${name}`;
        if (nameToIds.has(name) && (nameToIds.get(name) ?? []).includes(id)) continue;
        if (nodes.length >= MAX_NODES) break;
        defs.push({ name, id, start: m.index ?? 0 });
        nodes.push({ id, label: name, kind: "fn", file: rel });
        nameToIds.set(name, [...(nameToIds.get(name) ?? []), id]);
      }
    }
    defs.sort((a, b) => a.start - b.start);
    fileDefs.set(rel, { rel, text, defs });
  }

  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  for (const { text, defs } of fileDefs.values()) {
    for (let i = 0; i < defs.length; i++) {
      const def = defs[i]!;
      const end = i + 1 < defs.length ? defs[i + 1]!.start : text.length;
      const body = text.slice(def.start, end);
      // A callee reference is `name(` for a name defined somewhere in the project.
      for (const m of body.matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)) {
        const callee = m[1] ?? "";
        if (callee === def.name) continue;
        for (const targetId of nameToIds.get(callee) ?? []) {
          if (targetId === def.id) continue;
          const key = `${def.id}->${targetId}`;
          if (!seen.has(key)) {
            seen.add(key);
            edges.push({ from: def.id, to: targetId });
          }
        }
      }
    }
  }
  return { nodes, edges, orphans: orphansOf(nodes, edges) };
}

/** graph.build — build the docs/code dependency graph. Never throws. */
export async function buildGraph(root: string, mode: "docs" | "code"): Promise<GraphBuildReply> {
  try {
    return mode === "docs" ? await buildDocs(root) : await buildCode(root);
  } catch {
    return { nodes: [], edges: [], orphans: [] };
  }
}
