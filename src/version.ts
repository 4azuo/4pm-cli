/**
 * Current CLI version — read from the package.json shipped next to dist/ (ADR-0052).
 * The git tag `cli-vX.Y.Z` is the single source of truth: CI stamps package.json from
 * the tag before build (`npm pkg set version`). npm-global and the self-download
 * tarball both ship package.json at the package root (dist/ underneath), so reading
 * it at runtime works everywhere; `tsx` dev reads the workspace `0.0.0` (dev marker).
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Derive a real version from the CLI's own git tags (`cli-vX.Y.Z`) for a source/dev run whose
 * package.json still carries the `0.0.0` workspace marker — so the dashboard shows a meaningful
 * version instead of the placeholder. This is a **local** read of the checkout's own tags — no network
 * or remote access. `--match cli-v*` (and no `--always`) means it only ever reports against a real CLI
 * release tag: `cli-v1.9.0` on a tagged commit or `cli-v1.9.0-3-gabc123` when ahead of it (we strip the
 * `cli-v` prefix). Best-effort: any failure (no git, no `cli-v*` tag, not the cli repo — e.g. a
 * bundled/global install, or the dir nested in an unrelated repo) leaves the marker untouched.
 */
function gitDescribeVersion(cwd: string): string | null {
  try {
    const out = execFileSync("git", ["describe", "--tags", "--match", "cli-v*"], {
      cwd,
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    const stripped = out.replace(/^cli-v/, "");
    return stripped || null;
  } catch {
    return null;
  }
}

/**
 * Resolve the running CLI version, in priority order:
 *  1. `FOURPM_CLI_VERSION` env — an explicit override, so a **container built from source** (no real
 *     package.json version, no `.git`) can inject the built version at build/run time (e.g.
 *     `-e FOURPM_CLI_VERSION=$(git -C <cli> describe --tags --match 'cli-v*')`). The `cli-v` prefix is
 *     stripped if present.
 *  2. The sibling package.json `version` (dist/../ when bundled, src/../ under tsx) — an npm/global
 *     install carries the CI-stamped release here, so a container that `npm i -g @4pm/cli@X` needs
 *     nothing extra.
 *  3. For a `0.0.0` workspace marker (a source/dev run), the CLI's own git tag (`gitDescribeVersion`).
 * Returns the `0.0.0` marker only when none of the above yields a version.
 */
function readCliVersion(): string {
  const envVersion = process.env.FOURPM_CLI_VERSION?.trim();
  if (envVersion) return envVersion.replace(/^cli-v/, "");
  let version = "0.0.0";
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as {
      version?: string;
    };
    version = pkg.version ?? "0.0.0";
    if (version === "0.0.0") {
      const dev = gitDescribeVersion(here);
      if (dev) version = dev;
    }
  } catch {
    // keep the marker
  }
  return version;
}

export const CLI_VERSION = readCliVersion();
