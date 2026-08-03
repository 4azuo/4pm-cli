/**
 * `4pm version` command — print the installed cli version; when a server URL is
 * available (a linked profile or --server), also query /meta/cli-version to show
 * the latest / minSupported and whether an update is available (meta-0001).
 */
import { readCredential } from "../core/credential";
import { compareSemver } from "../core/update";
import { fetchCliVersion } from "../services/api";
import { CLI_VERSION } from "../version";

/**
 * Print the local version and, if the server is reachable, latest/minSupported.
 */
export async function runVersion(
  profileDir: string,
  profileName: string,
  serverUrlFlag?: string,
): Promise<void> {
  console.log(`4pm cli ${CLI_VERSION}`);

  const serverUrl =
    serverUrlFlag ??
    readCredential(profileDir, profileName)?.serverUrl ??
    process.env.FOURPM_SERVER;
  if (!serverUrl) return;

  try {
    const meta = await fetchCliVersion(serverUrl.replace(/\/$/, ""));
    const outdated = compareSemver(CLI_VERSION, meta.latest) < 0;
    const hint = outdated
      ? "  (update available — run `4pm update`)"
      : "  (up to date)";
    console.log(`latest:  ${meta.latest}${hint}`);
    console.log(`minSupported: ${meta.minSupported}`);
  } catch (err) {
    // Offline / server down ⇒ the local version above is still useful.
    console.warn(`Could not reach the server for the latest version: ${err}`);
  }
}
