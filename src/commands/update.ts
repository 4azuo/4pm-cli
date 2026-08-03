/**
 * `4pm update` command — manually update to the latest version (meta-0001,
 * ADR-0015). Unlike startup auto-update this forces the update regardless of the
 * profile's `autoUpdate` config; reuses the same npm/self-download path.
 */
import { readCredential } from "../core/credential";
import { updateToLatest } from "../core/update";

/**
 * True when an error is a connection-level fetch failure (server unreachable) rather
 * than an HTTP/application error. Node's `fetch` throws `TypeError: fetch failed` and
 * carries the real reason (ECONNREFUSED/ENOTFOUND/ETIMEDOUT…) on `err.cause`.
 */
function isConnectionError(err: unknown): boolean {
  return err instanceof TypeError && err.message === "fetch failed";
}

/**
 * Resolve the server URL, then force-update to latest and report the outcome.
 */
export async function runUpdate(
  profileDir: string,
  profileName: string,
  serverUrlFlag?: string,
): Promise<void> {
  // `||` not `??`: an empty flag / stored value / FOURPM_SERVER="" means "not set", and
  // `??` would keep the empty string and dial nowhere.
  const serverUrl = (
    serverUrlFlag ||
    readCredential(profileDir, profileName)?.serverUrl ||
    process.env.FOURPM_SERVER ||
    "http://localhost:42001"
  ).replace(/\/$/, "");

  let result;
  try {
    result = await updateToLatest(serverUrl);
  } catch (err) {
    // A connection-level failure surfaces as `TypeError: fetch failed` — unhelpful on
    // its own. Point at the URL we dialed and the likely cause (server down / wrong URL)
    // rather than echoing the raw error.
    if (isConnectionError(err)) {
      console.error(
        `Could not reach the server at ${serverUrl} — is it running? ` +
          `Set the server with \`--server <url>\` or the FOURPM_SERVER env var.`,
      );
    } else {
      console.error(`Could not check for updates: ${err}`);
    }
    process.exitCode = 1;
    return;
  }

  switch (result.action) {
    case "dev-build":
      console.log(
        `Running a local dev build (${result.version}) — update it by rebuilding the repo ` +
          `(\`pnpm --filter @4pm/cli build\`), not \`4pm update\`.`,
      );
      break;
    case "already-latest":
      console.log(`Already up to date (${result.version}).`);
      break;
    case "updated":
      console.log(`✔ Updated to ${result.version}. Run \`4pm start\` to reconnect.`);
      break;
    case "failed":
      console.error(`Update failed: ${result.error}`);
      process.exitCode = 1;
      break;
  }
}
