/**
 * Regenerates `standalone/pnpm-lock.yaml` — the lockfile the standalone public 4pm-cli CI installs from
 * (ADR-0684). The standalone pnpm settings and lockfile live under `standalone/` (not the repo root) so
 * this repo stays one package of the monorepo workspace when it is the `21-apps/31-cli` submodule; this
 * script resolves `package.json` against `standalone/pnpm-workspace.yaml` in a throwaway directory
 * (lockfile only — nothing is installed, no install script runs) and copies the result back.
 *
 * Usage:
 *   node scripts/standalone-lock.mjs           # rewrite standalone/pnpm-lock.yaml
 *   node scripts/standalone-lock.mjs --check   # exit 1 when it is out of date
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const cliDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const standaloneDir = join(cliDir, "standalone");
const lockPath = join(standaloneDir, "pnpm-lock.yaml");
const check = process.argv.includes("--check");

/** Resolve the lockfile in a temp dir and return its text. */
function resolveLock() {
  const dir = mkdtempSync(join(tmpdir(), "4pm-cli-lock-"));
  try {
    copyFileSync(join(cliDir, "package.json"), join(dir, "package.json"));
    copyFileSync(join(standaloneDir, "pnpm-workspace.yaml"), join(dir, "pnpm-workspace.yaml"));
    try {
      copyFileSync(lockPath, join(dir, "pnpm-lock.yaml"));
    } catch {
      // No lockfile yet — resolve from scratch.
    }
    execFileSync("pnpm", ["install", "--lockfile-only", "--ignore-scripts"], { cwd: dir, stdio: "inherit" });
    return readFileSync(join(dir, "pnpm-lock.yaml"), "utf8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const next = resolveLock();
let current = "";
try {
  current = readFileSync(lockPath, "utf8");
} catch {
  // Missing ⇒ out of date.
}
if (check) {
  if (next !== current) {
    console.error("standalone/pnpm-lock.yaml is out of date — run: node scripts/standalone-lock.mjs");
    process.exit(1);
  }
  console.log("standalone/pnpm-lock.yaml is up to date.");
} else if (next !== current) {
  writeFileSync(lockPath, next);
  console.log("Updated standalone/pnpm-lock.yaml.");
} else {
  console.log("standalone/pnpm-lock.yaml already up to date.");
}
