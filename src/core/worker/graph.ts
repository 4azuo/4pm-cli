/**
 * Docs & code structure graph on the worker (graph.build channel). Walks the physic project
 * (bounded, symlink-safe reads) and hands the files to the shared Doc Header model
 * (`core/docs/doc-model.ts`, the same module the `4pm-doc-lint` skill ships): typed edges from the Doc
 * Header and markdown links (docs), file-level imports + header tags (code), the parent / import tree,
 * the depth score and the lint issues. Deterministic, no tokens. Never throws — errors map to an empty
 * graph. Project files are agent-writable ⇒ untrusted input: per-file and per-build caps, string-only
 * import resolution, and the cli's own parser (never the project's copy of the skill).
 * @adr 0155 @adr 0488
 */
import { readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join, relative } from "node:path";
import type { GraphBuildReply } from "@4pm/ws";
import { readFileInRoot } from "../../utils/safe-path";
import { buildDocModel, CODE_EXT, type DocOptions, type SourceFile } from "../docs/doc-model";

const MAX_FILES = 2000;
/** Larger files are skipped (listed nowhere) — keeps a build bounded. */
const MAX_FILE_BYTES = 1_000_000;
/** Total text read per build. */
const MAX_TOTAL_BYTES = 64_000_000;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "out", "coverage", ".turbo", "vendor", "__pycache__", ".venv", "venv", "target"]);
const CONFIG_RE = /(^|\/)(tsconfig\.json|tsconfig\.[\w.-]+\.json|package\.json|go\.mod)$/;

/** Files gathered by one walk. */
interface Walked {
  docs: string[];
  code: string[];
  configs: string[];
}

/** Walk the project (bounded; skips heavy and hidden dirs — a hidden dir is tooling, not docs/code). */
async function walk(root: string, wantDocs: boolean, wantCode: boolean): Promise<Walked> {
  const out: Walked = { docs: [], code: [], configs: [] };
  const stack = [root];
  let count = 0;
  while (stack.length && count < MAX_FILES) {
    const dir = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) stack.push(full);
        continue;
      }
      if (!e.isFile()) continue;
      const rel = relative(root, full).split("\\").join("/");
      const lower = e.name.toLowerCase();
      if (CONFIG_RE.test(rel) && wantCode) out.configs.push(rel);
      else if (lower.endsWith(".md") && (wantDocs || wantCode)) out.docs.push(rel);
      else if (wantCode && CODE_EXT.some((x) => lower.endsWith(x)) && !lower.endsWith(".d.ts") && !lower.endsWith(".min.js")) out.code.push(rel);
      else continue;
      if (++count >= MAX_FILES) break;
    }
  }
  return out;
}

/** Read files symlink-safe within the per-file and per-build caps. */
async function readAll(root: string, rels: string[], budget: { left: number }): Promise<SourceFile[]> {
  const out: SourceFile[] = [];
  for (const rel of rels) {
    if (budget.left <= 0) break;
    try {
      const text = await readFileInRoot(root, join(root, rel), "utf8"); // symlink-safe (ADR-0430)
      if (text.length > MAX_FILE_BYTES) continue;
      budget.left -= text.length;
      out.push({ path: rel, text });
    } catch {
      // unreadable ⇒ skipped
    }
  }
  return out;
}

/** The project's `docs` options from `project.settings.json` (kinds, maxDepth, ignore), validated. */
async function docOptions(root: string): Promise<DocOptions> {
  try {
    const raw = JSON.parse(await readFileInRoot(root, join(root, "project.settings.json"), "utf8")) as { docs?: unknown };
    const d = raw.docs as { kinds?: unknown; maxDepth?: unknown; ignore?: unknown } | undefined;
    if (!d || typeof d !== "object") return {};
    const opts: DocOptions = {};
    if (Array.isArray(d.kinds)) {
      opts.kinds = d.kinds
        .filter((k): k is { key: string; label?: string } => !!k && typeof (k as { key?: unknown }).key === "string")
        .slice(0, 24)
        .map((k) => ({ key: k.key, ...(typeof k.label === "string" ? { label: k.label.slice(0, 60) } : {}) }));
    }
    if (typeof d.maxDepth === "number") opts.maxDepth = d.maxDepth;
    if (Array.isArray(d.ignore)) opts.ignore = d.ignore.filter((g): g is string => typeof g === "string" && g.length <= 200).slice(0, 50);
    return opts;
  } catch {
    return {};
  }
}

/** graph.build — build the docs / code / all structure graph. Never throws. */
export async function buildGraph(root: string, mode: "docs" | "code" | "all"): Promise<GraphBuildReply> {
  try {
    const m = mode === "code" || mode === "all" ? mode : "docs";
    const walked = await walk(root, m !== "code", m !== "docs");
    const budget = { left: MAX_TOTAL_BYTES };
    const configs = await readAll(root, walked.configs, budget);
    const docs = m === "code" ? [] : await readAll(root, walked.docs, budget);
    const code = m === "docs" ? [] : await readAll(root, walked.code, budget);
    return buildDocModel({ mode: m, docs, code, configs, options: await docOptions(root) });
  } catch {
    return {
      nodes: [],
      edges: [],
      orphans: [],
      roots: [],
      metrics: { depthScore: 100, maxDepth: 0, avgDepth: 0, idealDepth: 3, cycles: 0, unclassified: 0, brokenRefs: 0, perRoot: [] },
      issues: [],
    };
  }
}
