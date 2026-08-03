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
import { INSECURE_URL_WARNING, isInsecureRemoteUrl } from "../utils/secure-url";

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
  // Warn before any credential leaves the machine when the server URL is plaintext to a
  // non-local host (ADR-0194 Phase-0 finding #1) — the hashcodes/token below travel in the clear.
  if (isInsecureRemoteUrl(serverUrl)) console.warn(`\n${INSECURE_URL_WARNING}\n`);
  // Headless pairing (ADR-0192 §6): a provisioning token (`--token` / FOURPM_PAIR_TOKEN) exchanges
  // for hashcode (3) with no interactive hashcode dance — the container/pool boot path.
  let result;
  if (token) {
    console.log(`── 4PM cli headless pairing (profile: ${explicitProfile ?? "default"}) ──`);
    result = await pairWithToken(serverUrl, token, collectFingerprint());
  } else {
    const hashcode1 = randomBytes(32).toString("hex");
    console.log(`── 4PM cli pairing (profile: ${explicitProfile ?? "default"}) ─────────────`);
    console.log("1. Open the 4PM web → /machines, enter the pairing code:");
    console.log(`\n   ${hashcode1}\n`);
    console.log("2. The web will show a confirmation code — paste it here.");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const hashcode2 = (await rl.question("Confirmation code: ")).trim();
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
    console.log(`✔ Created physic project folder: ${folder}`);
  }
  // Point the `default` at this profile (fallback for version/update when not picking).
  writeDefaultProfile(profileName);
  // Show scope so it is obvious WHICH account was paired: "orchestrator" = the admin
  // (the web wizard's default), "project" = the selected MACHINE user (worker).
  const verb = existed ? "Renewed" : "Added";
  console.log(
    `✔ ${verb} profile "${profileName}" as "${username}" · scope: ${scope} — saved .cre. Run \`4pm start\` to connect.`,
  );
  if (scope === "orchestrator") {
    console.log(
      "  (This is the orchestrator/admin link. To pair a worker instead, pick the " +
        "MACHINE user in the web pairing wizard before entering the pairing code.)",
    );
  }
}
