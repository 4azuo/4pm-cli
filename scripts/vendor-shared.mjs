/**
 * Vendor-trim tool (ADR-0194 §1). Produces `vendor/@4pm/*` for the standalone public
 * `4azuo/4pm-cli` repo: only the shared-package source files the CLI actually reaches are
 * copied, so the 175/193 server-only symbols in `@4pm/dto`/`@4pm/constants` never leave the
 * monorepo (ADR-0194 Phase-0 finding #4).
 *
 * How: the CLI imports the package *barrels* (`@4pm/dto`, `@4pm/ws`, …), so a file-level
 * copy would drag in everything the barrel `export *`s. Instead we resolve every symbol the
 * CLI imports to its *defining* source file via the TypeScript checker (which sees through
 * the barrel), then take the transitive closure over those files' own intra-shared imports.
 * A curated `index.ts` re-exporting only the copied files replaces the original barrel.
 *
 * Usage:
 *   node scripts/vendor-shared.mjs            # report only (default; writes nothing)
 *   node scripts/vendor-shared.mjs --write    # write vendor/@4pm/* into the CLI dir
 */
import ts from "typescript";
import { fileURLToPath } from "node:url";
import {
  cpSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const cliDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repoRoot = resolve(cliDir, "..", "..");
const write = process.argv.includes("--write");

// Standalone (public 4pm-cli) checkout: the monorepo's canonical 22-packages is absent, so
// there is nothing to regenerate from — use the committed vendor/ as-is and no-op (ADR-0194).
if (!existsSync(join(repoRoot, "tsconfig.base.json"))) {
  console.log("vendor-shared: no monorepo (tsconfig.base.json absent) — using committed vendor/.");
  process.exit(0);
}

/**
 * Every `@4pm/*` package → its source root, discovered from the base tsconfig `paths` (so a
 * new transitive shared dep like `@4pm/validation` is picked up automatically). Only the
 * files actually reached get vendored, so registering all roots is safe.
 */
const PKG_ROOTS = (() => {
  const cfg = ts.readConfigFile(join(repoRoot, "tsconfig.base.json"), ts.sys.readFile).config;
  const paths = cfg.compilerOptions?.paths ?? {};
  const roots = {};
  for (const [key, targets] of Object.entries(paths)) {
    if (key.includes("*") || !key.startsWith("@4pm/")) continue;
    roots[key] = resolve(repoRoot, targets[0]);
  }
  return roots;
})();
const PACKAGES = PKG_ROOTS;
/** External npm deps the vendored files import (excludes `node:` builtins) — for package.json. */
const externalDeps = new Set();

/** Load the monorepo config (paths → canonical 22-packages) so symbols trace to the real files. */
function loadProgram() {
  const configPath = join(cliDir, "tsconfig.monorepo.json");
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (d) => {
      throw new Error(ts.flattenDiagnosticMessageText(d.messageText, "\n"));
    },
  });
  if (!parsed) throw new Error("Failed to parse the CLI tsconfig.");
  return ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
}

/** Which shared package root (if any) a resolved file belongs to. */
function packageOf(fileName) {
  const f = resolve(fileName);
  for (const [name, root] of Object.entries(PKG_ROOTS)) {
    if (f === root || f.startsWith(root + "/")) return name;
  }
  return null;
}

/** Skip test files — they never ship (and pull test-only deps). */
function isTest(fileName) {
  return /\.(test|spec)\.tsx?$/.test(fileName);
}

const program = loadProgram();
const checker = program.getTypeChecker();
const host = ts.createCompilerHost(program.getCompilerOptions());

/** Files to vendor. */
const collected = new Set();
/** Work queue of files whose imports still need processing. */
const queue = [];
/** Namespace-import warnings (`import * as X from "@4pm/..."`) — can't be trimmed. */
const namespaceImports = [];

/** A package-root barrel (`<pkgRoot>/index.ts`) — never vendored whole; resolve symbols instead. */
function isPackageBarrel(file) {
  const f = resolve(file);
  return Object.values(PKG_ROOTS).some((root) => f === join(root, "index.ts"));
}

/** Mark a shared-package file for vendoring (+ enqueue for its own imports). */
function add(file) {
  const abs = resolve(file);
  if (!packageOf(abs) || isTest(abs) || isPackageBarrel(abs) || collected.has(abs)) return;
  collected.add(abs);
  queue.push(abs);
}

/** Resolve an imported identifier to its DEFINING file(s), seeing through the barrel. */
function collectSymbol(identifier) {
  let symbol = checker.getSymbolAtLocation(identifier);
  if (!symbol) return;
  if (symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  for (const decl of symbol.declarations ?? []) add(decl.getSourceFile().fileName);
}

/** Process one file's imports/exports: symbol-resolve `@4pm/*` barrels, follow relative deps. */
function processFile(file, isCliSrc) {
  const sf = program.getSourceFile(file);
  if (!sf) return;
  sf.forEachChild((node) => {
    const isImport = ts.isImportDeclaration(node);
    const isExport = ts.isExportDeclaration(node);
    if (!isImport && !isExport) return;
    const spec = node.moduleSpecifier;
    if (!spec || !ts.isStringLiteral(spec)) return;
    if (spec.text.startsWith("@4pm/")) {
      // Bare shared import ⇒ resolve the used symbols to their real files (skip the barrel).
      const clause = isImport ? node.importClause : undefined;
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) {
        namespaceImports.push(`${relative(repoRoot, resolve(file))} → ${spec.text}`);
      } else if (bindings && ts.isNamedImports(bindings)) {
        for (const el of bindings.elements) collectSymbol(el.name);
      }
      if (clause?.name) collectSymbol(clause.name);
      // `export … from "@4pm/…"` inside a shared file: resolve its named symbols too.
      if (isExport && node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const el of node.exportClause.elements) collectSymbol(el.name);
      }
      return;
    }
    if (isCliSrc) return; // CLI relative imports point at CLI files — ignore.
    if (!spec.text.startsWith(".")) {
      // Bare non-`@4pm` import inside a vendored file ⇒ an external npm dep to declare
      // (node: builtins need no package.json entry).
      if (!spec.text.startsWith("node:")) externalDeps.add(spec.text);
      return;
    }
    // Relative import inside a shared file ⇒ follow it if it lands in a shared package.
    const resolved = ts.resolveModuleName(spec.text, file, program.getCompilerOptions(), host)
      .resolvedModule?.resolvedFileName;
    if (resolved) add(resolved);
  });
}

// 1. Seed from the CLI's own source (symbol-resolve every `@4pm/*` import).
for (const sf of program.getSourceFiles()) {
  const f = resolve(sf.fileName);
  if (f.startsWith(cliDir + "/src/")) processFile(f, true);
}
// 2. Transitive closure over the collected shared files.
while (queue.length) processFile(queue.pop(), false);

// 3. Group by package + report.
const byPackage = {};
for (const name of Object.keys(PACKAGES)) byPackage[name] = [];
for (const file of collected) byPackage[packageOf(file)].push(file);

console.log("=== vendor-trim report (ADR-0194) ===");
let anyLeakRisk = false;
for (const [name, root] of Object.entries(PKG_ROOTS)) {
  if (!byPackage[name].length) continue; // package not reached by the CLI
  const included = byPackage[name].map((f) => relative(root, f)).sort();
  const all = ts.sys
    .readDirectory(root, [".ts", ".tsx"])
    .map((f) => relative(root, f))
    .filter((f) => !isTest(f) && f !== "index.ts")
    .sort();
  const excluded = all.filter((f) => !included.includes(f));
  console.log(`\n${name}  (${included.length}/${all.length} source files)`);
  console.log(`  include: ${included.join(", ") || "(none)"}`);
  console.log(`  EXCLUDE: ${excluded.join(", ") || "(none)"}`);
  if (excluded.length) anyLeakRisk = true;
}
console.log(
  `\nexternal npm deps (declare in the standalone package.json): ${[...externalDeps].sort().join(", ") || "(none)"}`,
);
if (namespaceImports.length) {
  console.log(`\n⚠ namespace imports (cannot trim — pull the whole package):`);
  for (const n of namespaceImports) console.log(`  ${n}`);
}
console.log(
  `\n${anyLeakRisk ? "✔ trim excludes server-only files" : "… nothing excluded"} — ${collected.size} files vendored.`,
);

// 4. Write vendor/@4pm/* (only with --write): copy the files + a curated barrel.
if (write) {
  const vendorRoot = join(cliDir, "vendor");
  rmSync(vendorRoot, { recursive: true, force: true });
  for (const [name, root] of Object.entries(PKG_ROOTS)) {
    if (!byPackage[name].length) continue; // package not reached — nothing to vendor
    const outDir = join(vendorRoot, name);
    const files = byPackage[name].map((f) => relative(root, f)).sort();
    for (const rel of files) {
      const dest = join(outDir, rel);
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(join(root, rel), dest);
    }
    // Curated barrel: re-export only the copied files (never the server-only ones).
    const barrel = files
      .map((f) => `export * from "./${f.replace(/\.tsx?$/, "")}";`)
      .join("\n");
    writeFileSync(
      join(outDir, "index.ts"),
      `/**\n * Generated by scripts/vendor-shared.mjs (ADR-0194) — do not edit.\n */\n${barrel}\n`,
    );
  }
  console.log(`\nWrote ${collected.size} files → ${relative(repoRoot, vendorRoot)}/`);
}
