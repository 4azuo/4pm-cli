#!/usr/bin/env node
/**
 * 4pm-doc-lint — check the project's docs (and optionally code) against the 4PM Doc Header standard:
 * header present and valid, known kinds, unique ids, refs/links that resolve, no parent cycles, no
 * orphans, nesting depth within the ideal, code file headers. Prints a table (default) or JSON
 * (`--json`); exits 1 when any error is found. Read-only, no network, Node built-ins only.
 *
 *   node doc-lint.mjs [--mode docs|code|all] [--json] [--root <dir>] [--errors-only]
 */
import { readdir, readFile, lstat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDocModel, CODE_EXT } from "./doc-model.mjs";

const SKIP = new Set(["node_modules", ".git", "dist", "build", ".next", "out", "coverage", ".turbo", "vendor", "__pycache__", ".venv", "venv", "target"]);
const CONFIG_RE = /(^|\/)(tsconfig\.json|tsconfig\.[\w.-]+\.json|package\.json|go\.mod)$/;
const MAX_FILES = 4000;
const MAX_FILE = 1_000_000;

/** Parse argv. */
function args() {
  const a = process.argv.slice(2);
  const val = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] ?? d : d);
  const here = fileURLToPath(new URL(".", import.meta.url));
  // Default root: the project that holds `.claude/skills/4pm-doc-lint` (or `.agents/skills/…`), else cwd.
  const guess = resolve(here, "../../..");
  return {
    mode: ["docs", "code", "all"].includes(val("--mode", "docs")) ? val("--mode", "docs") : "docs",
    json: a.includes("--json"),
    errorsOnly: a.includes("--errors-only"),
    root: resolve(val("--root", here.includes(`${sep}skills${sep}`) ? guess : process.cwd())),
  };
}

/** Walk the project (no symlinks, no hidden or heavy dirs). */
async function walk(root) {
  const docs = [];
  const code = [];
  const configs = [];
  const stack = [root];
  while (stack.length && docs.length + code.length + configs.length < MAX_FILES) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP.has(e.name) && !e.name.startsWith(".")) stack.push(full);
        continue;
      }
      const rel = relative(root, full).split(sep).join("/");
      const lower = e.name.toLowerCase();
      if (CONFIG_RE.test(rel)) configs.push(rel);
      else if (lower.endsWith(".md")) docs.push(rel);
      else if (CODE_EXT.some((x) => lower.endsWith(x)) && !lower.endsWith(".d.ts")) code.push(rel);
    }
  }
  return { docs, code, configs };
}

/** Read files (skipping big ones). */
async function read(root, rels) {
  const out = [];
  for (const path of rels) {
    try {
      const st = await lstat(join(root, path));
      if (!st.isFile() || st.size > MAX_FILE) continue;
      out.push({ path, text: await readFile(join(root, path), "utf8") });
    } catch {
      // skipped
    }
  }
  return out;
}

/** The project's `docs` options from project.settings.json. */
async function options(root) {
  try {
    const j = JSON.parse(await readFile(join(root, "project.settings.json"), "utf8"));
    return j && typeof j.docs === "object" && j.docs ? j.docs : {};
  } catch {
    return {};
  }
}

const opt = args();
const w = await walk(opt.root);
const model = buildDocModel({
  mode: opt.mode,
  docs: opt.mode === "code" ? [] : await read(opt.root, w.docs),
  code: opt.mode === "docs" ? [] : await read(opt.root, w.code),
  configs: await read(opt.root, w.configs),
  options: await options(opt.root),
});
const issues = opt.errorsOnly ? model.issues.filter((i) => i.severity === "error") : model.issues;
const errors = model.issues.filter((i) => i.severity === "error").length;
if (opt.json) {
  process.stdout.write(`${JSON.stringify({ metrics: model.metrics, issues }, null, 2)}\n`);
} else {
  const m = model.metrics;
  console.log(`4PM doc lint — ${opt.mode} · ${model.nodes.length} nodes · ${model.edges.length} edges`);
  console.log(`depth score ${m.depthScore}/100 (max depth ${m.maxDepth}, avg ${m.avgDepth}, ideal ≤ ${m.idealDepth}) · orphans ${model.orphans.length} · broken refs ${m.brokenRefs} · unclassified ${m.unclassified} · cycles ${m.cycles}`);
  if (!issues.length) console.log("No issues.");
  for (const i of issues) console.log(`${i.severity === "error" ? "ERROR" : "warn "}  ${i.rule.padEnd(20)} ${i.file}  ${i.message}`);
  console.log(`${errors} error(s), ${model.issues.length - errors} warning(s).`);
}
process.exit(errors > 0 ? 1 : 0);
