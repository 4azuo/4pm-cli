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
 * version instead of the placeholder. `git describe --tags` yields `cli-v1.9.0` on a tagged commit
 * or `cli-v1.9.0-3-gabc123` when ahead of it; we strip the `cli-v` prefix. Best-effort: any failure
 * (no git, no tags, not a repo — e.g. a bundled/global install) leaves the marker untouched.
 */
function gitDescribeVersion(cwd: string): string | null {
  try {
    const out = execFileSync("git", ["describe", "--tags", "--always"], {
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
 * Read the `version` field from the sibling package.json (dist/../package.json when
 * bundled, src/../package.json under tsx). A `0.0.0` (dev marker) falls back to the CLI's git
 * tag so a source run reports a real version (ADR-0052 dev fallback). Returns the marker if unreadable.
 */
function readCliVersion(): string {
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
