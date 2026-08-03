/**
 * Auto-update on startup (ADR-0015, meta-0001):
 * GET /meta/cli-version ⇒ current < minSupported = mandatory update;
 * current < latest + autoUpdate ⇒ auto-update. Supports two paths: npm global
 * (`npm i -g @4pm/cli@<latest>`) or self-download tarball (verify sha256). After
 * updating, verify the version at the re-exec path actually advanced before claiming
 * success, so a mis-applied update can't trigger a restart loop (ADR-0053).
 */
import { execSync } from "node:child_process";
import { createHash, createPublicKey, verify } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { CLI_SIGNING_PUBLIC_KEY } from "../config/signing";
import { CLI_VERSION } from "../version";
import { fetchCliVersion } from "../services/api";

/** Result of the startup update-check step. */
export type UpdateResult =
  | { action: "none" }
  | { action: "updated"; version: string }
  | { action: "blocked"; minSupported: string };

/**
 * Simple semver comparison (major.minor.patch) — returns <0 / 0 / >0.
 */
export function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * The install root of the RUNNING code = parent of dist/ (which holds package.json +
 * dist/). Derived from `import.meta.url` — the SAME basis version.ts uses (ADR-0052) —
 * NOT `process.argv[1]`, which for a symlinked global bin points at the bin/prefix dir,
 * not the real package. Using the wrong basis makes the update land in the wrong
 * directory while CLI_VERSION never changes (the bug this fixes).
 */
function runningInstallRoot(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

/**
 * Was the CLI invoked via an npm-global bin? — the invoked path lives in node_modules.
 * Kept on `process.argv[1]` (the invoked bin), NOT the resolved module path: a bin
 * symlink lands outside node_modules ⇒ the reliable self-download path is chosen (it
 * extracts over the real install root, which works for tarball/private installs too).
 */
function installedViaNpm(): boolean {
  return (process.argv[1] ?? "").split(sep).includes("node_modules");
}

/**
 * Version the re-exec would actually load — read from the package.json at the running
 * install root (same file version.ts reads — ADR-0052). Used to verify an update really
 * landed on the running install before claiming success (ADR-0053). "0.0.0" when unreadable.
 */
function readInstalledVersion(): string {
  try {
    const pkgPath = join(runningInstallRoot(), "package.json");
    return (JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * Update via npm global — a shared binary, applies to every instance (ADR-0014).
 */
function updateViaNpm(version: string): void {
  execSync(`npm i -g @4pm/cli@${version}`, { stdio: "inherit" });
}

/**
 * Self-download the tarball from the server (machine without npm): verify sha256
 * before extracting over the current installation directory.
 */
async function updateViaDownload(
  tarballUrl: string,
  checksum: string,
  signature?: string,
): Promise<void> {
  const res = await fetch(tarballUrl);
  if (!res.ok) throw new Error(`Failed to download tarball: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const actual = createHash("sha256").update(buf).digest("hex");
  if (actual !== checksum) {
    throw new Error("Tarball checksum mismatch — aborting update (ADR-0015).");
  }
  // Optional ed25519 signature over the raw tarball bytes. Enforced only when a
  // public key is embedded (CLI_SIGNING_PUBLIC_KEY); then a valid signature is
  // required — a missing/invalid one aborts the update (ADR-0015).
  if (CLI_SIGNING_PUBLIC_KEY) {
    if (!signature) {
      throw new Error("Missing tarball signature — aborting update (ADR-0015).");
    }
    // Accept the key as PEM (`-----BEGIN…`) or raw base64 SPKI (DER).
    const trimmed = CLI_SIGNING_PUBLIC_KEY.trim();
    const publicKey = trimmed.includes("BEGIN")
      ? createPublicKey(trimmed)
      : createPublicKey({
          key: Buffer.from(trimmed, "base64"),
          format: "der",
          type: "spki",
        });
    const ok = verify(null, buf, publicKey, Buffer.from(signature, "base64"));
    if (!ok) {
      throw new Error("Invalid tarball signature — aborting update (ADR-0015).");
    }
  }
  const tmp = join(mkdtempSync(join(tmpdir(), "4pm-update-")), "cli.tgz");
  writeFileSync(tmp, buf);
  // Extract over the RUNNING install root (parent of dist/ — resolved from
  // import.meta.url so it matches where CLI_VERSION is read, not a symlinked bin path).
  const installRoot = runningInstallRoot();
  execSync(`tar -xzf "${tmp}" -C "${installRoot}" --strip-components=1`, {
    stdio: "inherit",
  });
}

/** Result of a manual `4pm update` (distinguishes failure from already-latest). */
export type ManualUpdateResult =
  | { action: "dev-build"; version: string }
  | { action: "already-latest"; version: string }
  | { action: "updated"; version: string }
  | { action: "failed"; error: string };

/**
 * Manual update (`4pm update`): always update to the latest version when newer,
 * regardless of the profile's autoUpdate config. Reuses the same npm/self-download
 * path as startup auto-update. Throws only when the server is unreachable.
 */
export async function updateToLatest(serverUrl: string): Promise<ManualUpdateResult> {
  // Dev build (unstamped, "0.0.0" — ADR-0052): never self-update, and don't even dial
  // the server. A local build is updated by rebuilding the repo, not from a release
  // tarball — the same exemption startup's checkAndUpdate() applies.
  if (CLI_VERSION.startsWith("0.0.0")) return { action: "dev-build", version: CLI_VERSION };

  const meta = await fetchCliVersion(serverUrl);
  if (compareSemver(CLI_VERSION, meta.latest) >= 0) {
    return { action: "already-latest", version: CLI_VERSION };
  }
  console.log(`Updating ${CLI_VERSION} → ${meta.latest}…`);
  try {
    if (installedViaNpm()) {
      updateViaNpm(meta.latest);
    } else {
      await updateViaDownload(
        meta.source.tarballUrl,
        meta.source.checksum,
        meta.source.signature,
      );
    }
  } catch (err) {
    return { action: "failed", error: String(err) };
  }
  // Verify the update actually landed on the running install (ADR-0053) — the same
  // check startup does. Prevents `4pm update` from claiming success while the running
  // version stays old (e.g. extracted into the wrong directory).
  const installed = readInstalledVersion();
  if (compareSemver(installed, meta.latest) < 0) {
    return {
      action: "failed",
      error:
        `update ran but the installed version is still ${installed} (expected ${meta.latest}) — ` +
        `it did not apply to the running install at ${runningInstallRoot()}.`,
    };
  }
  return { action: "updated", version: meta.latest };
}

/**
 * Check the version with the server and update if needed (called before connecting WS).
 * autoUpdate=false: only update when mandatory (current < minSupported).
 */
export async function checkAndUpdate(
  serverUrl: string,
  autoUpdate: boolean,
): Promise<UpdateResult> {
  // Dev build (unstamped, "0.0.0" — ADR-0052): never self-update. A local build must
  // not replace itself from a release tarball; the server also exempts it from the
  // minSupported handshake, so it can connect as-is.
  if (CLI_VERSION.startsWith("0.0.0")) return { action: "none" };

  let meta;
  try {
    meta = await fetchCliVersion(serverUrl);
  } catch (err) {
    // Server did not return a version ⇒ skip (do not block startup)
    console.warn(`Could not check cli version: ${err}`);
    return { action: "none" };
  }

  const mandatory = compareSemver(CLI_VERSION, meta.minSupported) < 0;
  const outdated = compareSemver(CLI_VERSION, meta.latest) < 0;
  if (!outdated) return { action: "none" };
  if (!mandatory && !autoUpdate) {
    console.warn(
      `A new version ${meta.latest} is available (running ${CLI_VERSION}) — autoUpdate is off.`,
    );
    return { action: "none" };
  }

  console.log(
    `${mandatory ? "Mandatory" : "Automatic"} cli update ${CLI_VERSION} → ${meta.latest}…`,
  );
  try {
    if (installedViaNpm()) {
      updateViaNpm(meta.latest);
    } else {
      await updateViaDownload(
        meta.source.tarballUrl,
        meta.source.checksum,
        meta.source.signature,
      );
    }
  } catch (err) {
    if (mandatory) {
      console.error(`Update failed: ${err}`);
      return { action: "blocked", minSupported: meta.minSupported };
    }
    console.warn(`Update failed (skipping — not mandatory): ${err}`);
    return { action: "none" };
  }

  // Verify the update landed where the re-exec will load from (ADR-0053): the update
  // tool can report success without changing the running install (e.g. `npm i -g` hit
  // a different global prefix). Restarting into the old binary would loop — so only
  // claim "updated" when the installed version actually advanced.
  const installed = readInstalledVersion();
  if (compareSemver(installed, meta.latest) < 0) {
    const msg =
      `Update reported success but the installed version is still ${installed} ` +
      `(expected ${meta.latest}) — it did not apply to the running install ` +
      `(check the global npm prefix vs the running binary).`;
    if (mandatory) {
      console.error(msg);
      return { action: "blocked", minSupported: meta.minSupported };
    }
    console.warn(`${msg} Skipping restart.`);
    return { action: "none" };
  }
  return { action: "updated", version: meta.latest };
}
