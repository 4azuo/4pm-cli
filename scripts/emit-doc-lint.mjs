/**
 * Emit the `4pm-doc-lint` skill's `doc-model.mjs` from the cli's single source
 * `src/core/docs/doc-model.ts` (TypeScript `transpileModule`, no type-check), so the skill and the cli's
 * `graph.build` always share one parser (ADR-0488 §5). Writes the scaffold copy under
 * `project-sample/.claude/skills/4pm-doc-lint/`; `--public <dir>` also copies the whole skill folder to a
 * marketplace checkout (e.g. `../../4pm-public/skills/4pm-doc-lint`). `--check` fails when the scaffold
 * copy is out of date instead of writing it.
 *
 *   node scripts/emit-doc-lint.mjs [--check] [--public <dir>]
 */
import { readFile, writeFile, mkdir, copyFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url));
const cliRoot = join(here, "..");
const src = join(cliRoot, "src/core/docs/doc-model.ts");
const skillDir = join(cliRoot, "project-sample/.claude/skills/4pm-doc-lint");
const out = join(skillDir, "doc-model.mjs");

/** The emitted module text for the current source. */
export async function emitDocModel() {
  const code = await readFile(src, "utf8");
  const js = ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, removeComments: false },
    fileName: "doc-model.ts",
  }).outputText;
  return `// GENERATED from the 4PM cli (src/core/docs/doc-model.ts) by scripts/emit-doc-lint.mjs — do not edit.\n${js}`;
}

/** CLI entry. */
async function main() {
  const args = process.argv.slice(2);
  const text = await emitDocModel();
  if (args.includes("--check")) {
    const cur = await readFile(out, "utf8").catch(() => "");
    if (cur !== text) {
      console.error("doc-model.mjs is out of date — run: node scripts/emit-doc-lint.mjs");
      process.exit(1);
    }
    return;
  }
  await mkdir(skillDir, { recursive: true });
  await writeFile(out, text);
  const pub = args[args.indexOf("--public") + 1];
  if (args.includes("--public") && pub) {
    await mkdir(pub, { recursive: true });
    for (const f of await readdir(skillDir)) await copyFile(join(skillDir, f), join(pub, f));
  }
  console.log(`emitted ${out}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
