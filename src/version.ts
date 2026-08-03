/**
 * Current CLI version — read from the package.json shipped next to dist/ (ADR-0052).
 * The git tag `cli-vX.Y.Z` is the single source of truth: CI stamps package.json from
 * the tag before build (`npm pkg set version`). npm-global and the self-download
 * tarball both ship package.json at the package root (dist/ underneath), so reading
 * it at runtime works everywhere; `tsx` dev reads the workspace `0.0.0` (dev marker).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Read the `version` field from the sibling package.json (dist/../package.json when
 * bundled, src/../package.json under tsx). Falls back to a dev marker if unreadable.
 */
function readCliVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as {
      version?: string;
    };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const CLI_VERSION = readCliVersion();
