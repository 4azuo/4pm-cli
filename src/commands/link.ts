/**
 * `4pm link` command — two-way pairing with the server (machine-0001/0002, ADR-0014):
 * generate hashcode (1) shown to the user ⇒ the user enters it on the web /machines
 * page ⇒ enter hashcode (2) from the web back here ⇒ confirm (with the machine
 * fingerprint) ⇒ store hashcode (3) in the profile's `.cre`. Without --profile the
 * profile is keyed by the paired MACHINE userId (ADR-0047). Pairing always proceeds
 * (no "already linked" pre-check): it renews the profile if it exists, else adds it
 * (ADR-0063).
 */
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { readCredential, writeCredential } from "../core/credential";
import { collectFingerprint } from "../core/fingerprint";
import { confirmPairing, pairWithToken } from "../services/api";
import { ensureProfileConfig, profileDir, writeDefaultProfile } from "../config/profile";
import { assertSecureRemoteUrl } from "../utils/secure-url";
import { initI18n, t } from "../i18n";

/**
 * A filesystem-safe profile name derived from the account username (ADR-0063): readable
 * folders (e.g. "mcacc1", "admin") so no `--profile` is needed to tell them apart.
 */
function sanitizeProfileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_") || "profile";
}

/**
 * Run interactive pairing. `explicitProfile` is the (optional) --profile name; when
 * absent the profile is named after the paired account's username (ADR-0063).
 */
export async function runLink(
  serverUrl: string,
  explicitProfile: string | null,
  token: string | null = null,
): Promise<void> {
  // Hard-block before any credential leaves the machine when the server URL is plaintext to
  // a non-local host (ADR-0194 Phase-0 finding #1) — the hashcodes/token below would travel
  // in the clear to an unauthenticated server. Opt out only on a trusted private network.
  assertSecureRemoteUrl(serverUrl);
  // Pairing runs before any config.json exists, so localize from the environment (ADR-0276).
  initI18n();
  // Headless pairing (ADR-0192 §6): a provisioning token (`--token` / FOURPM_PAIR_TOKEN) exchanges
  // for hashcode (3) with no interactive hashcode dance — the container/pool boot path.
  let result;
  if (token) {
    console.log(t("link.headlessHeader", { profile: explicitProfile ?? "default" }));
    result = await pairWithToken(serverUrl, token, collectFingerprint());
  } else {
    const hashcode1 = randomBytes(32).toString("hex");
    console.log(t("link.header", { profile: explicitProfile ?? "default" }));
    console.log(t("link.step1"));
    console.log(`\n   ${hashcode1}\n`);
    console.log(t("link.step2"));
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const hashcode2 = (await rl.question(t("link.confirmPrompt"))).trim();
    rl.close();
    result = await confirmPairing(serverUrl, hashcode2, collectFingerprint());
  }
  const { hashcode3, username, scope, projectName } = result;
  // Explicit --profile keeps its name; otherwise name the profile after the account's
  // username (readable, no --profile needed — ADR-0063).
  const profileName = explicitProfile ?? sanitizeProfileName(username);
  // Renew if the profile already exists, else add a new one (ADR-0063) — notified below.
  const existed = readCredential(profileDir(profileName), profileName) != null;
  const dir = profileDir(profileName);
  writeCredential(dir, {
    serverUrl,
    hashcode3,
    scope, // decided by the server from the pairing user (ADR-0010); shown in the TUI
    pairedAt: new Date().toISOString(),
  });
  // Scaffold config.json with the canonical defaults so a freshly-linked profile has the
  // same structure as one created via `/config init` (instead of the partial file the
  // first ws_token would otherwise write). No-op when renewing an existing profile.
  ensureProfileConfig(dir);
  // MEMO#9 — scaffold the physic project folder inside the profile when the MACHINE
  // user already belongs to a project (folder = project name — ADR-0064).
  if (projectName && scope === "project") {
    const folder = join(dir, projectName);
    mkdirSync(folder, { recursive: true });
    console.log(t("link.createdFolder", { folder }));
  }
  // Point the `default` at this profile (fallback for version/update when not picking).
  writeDefaultProfile(profileName);
  // Show scope so it is obvious WHICH account was paired: "orchestrator" = the admin
  // (the web wizard's default), "project" = the selected MACHINE user (worker).
  const verb = existed ? t("link.verbRenewed") : t("link.verbAdded");
  console.log(t("link.saved", { verb, profile: profileName, username, scope }));
  if (scope === "orchestrator") {
    console.log(t("link.orchestratorNote"));
  }
}
