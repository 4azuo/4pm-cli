/**
 * Worker identity without a persistent volume. `4pm credential-export` prints a paired
 * profile's `.cre` as ONE opaque value (base64 of `{profile, credential}`) that an operator stores in a
 * secret store (e.g. AWS Secrets Manager). Injected as `FOURPM_CREDENTIAL`, it lets `4pm start` on an
 * ephemeral container (an ECS task without EFS) restore the same identity on every boot — no re-pairing,
 * since provisioning tokens are single-use. An existing `.cre` is never overwritten.
 * @adr 0428
 */
import { readCredential, writeCredential, type Credential } from "../core/profile/credential";
import { ensureProfileConfig, profileDir, writeDefaultProfile } from "../config/profile";
import { t } from "../i18n";

/** The decoded `FOURPM_CREDENTIAL` payload. */
interface ExportedCredential {
  profile: string;
  credential: Credential;
}

/** A filesystem-safe profile name (same rule as `4pm link`). @adr 0063 */
function safeProfileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_") || "profile";
}

/** Decode + validate a `FOURPM_CREDENTIAL` value; null when it is not a well-formed export. */
export function decodeExportedCredential(value: string): ExportedCredential | null {
  try {
    const parsed = JSON.parse(Buffer.from(value.trim(), "base64").toString("utf8")) as Partial<ExportedCredential>;
    const c = parsed.credential as Partial<Credential> | undefined;
    if (typeof parsed.profile !== "string" || !parsed.profile.trim() || !c) return null;
    if (typeof c.serverUrl !== "string" || typeof c.hashcode3 !== "string" || typeof c.scope !== "string") return null;
    if (!c.serverUrl || !c.hashcode3) return null;
    return {
      profile: safeProfileName(parsed.profile.trim()),
      credential: {
        serverUrl: c.serverUrl,
        hashcode3: c.hashcode3,
        scope: c.scope,
        pairedAt: typeof c.pairedAt === "string" ? c.pairedAt : new Date().toISOString(),
        ...(typeof c.wsUrl === "string" && c.wsUrl ? { wsUrl: c.wsUrl } : {}),
      },
    };
  } catch {
    return null;
  }
}

/** Encode a profile's credential as the single `FOURPM_CREDENTIAL` value. */
export function encodeExportedCredential(profile: string, credential: Credential): string {
  return Buffer.from(JSON.stringify({ profile, credential } satisfies ExportedCredential), "utf8").toString("base64");
}

/**
 * `4pm credential-export` — print the profile's credential as one value (stdout only, so it can be
 * captured straight into a secret). Exit code 1 when the profile is not linked.
 */
export function runCredentialExport(dir: string, name: string): void {
  const credential = readCredential(dir, name);
  if (!credential) {
    console.error(t("credential.exportNotLinked", { profile: name }));
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${encodeExportedCredential(name, credential)}\n`);
}

/**
 * On `4pm start`: restore the profile carried by `FOURPM_CREDENTIAL` when it has no `.cre` yet (an
 * ephemeral container's first boot). `explicitProfile` (`--profile` / FOURPM_PROFILE) wins over the
 * exported name. Returns the restored profile name, or null when nothing was restored.
 */
export function importCredentialFromEnv(explicitProfile: string | null): string | null {
  const raw = process.env.FOURPM_CREDENTIAL;
  if (!raw || !raw.trim()) return null;
  const decoded = decodeExportedCredential(raw);
  if (!decoded) {
    console.error(t("credential.importInvalid"));
    return null;
  }
  const name = explicitProfile ?? decoded.profile;
  const dir = profileDir(name); // created 0700 when missing
  if (readCredential(dir, name)) return null;
  writeCredential(dir, decoded.credential);
  ensureProfileConfig(dir);
  writeDefaultProfile(name);
  console.log(t("credential.imported", { profile: name }));
  return name;
}
