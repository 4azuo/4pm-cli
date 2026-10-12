/**
 * Adopt host-mounted AI logins as profiles. The web run command mounts host logins at
 * `~/ai-creds/<provider>-<host folder name>` (several per provider; older commands used the bare
 * `~/ai-creds/<provider>`); without a profile pointing there the provider would run "Not logged in". At
 * start, each mounted folder that holds a login and that no profile references is appended to the credential
 * list once — the operator's order stays first; a profile they later remove is never re-added. The seeded
 * `.claude` / `.codex` defaults that hold no login are then switched off once, and the mounted logins are
 * reported to the server (`machine.status.aiMounts`) as Worker-configs suggestions.
 * @adr 0433 @adr 0466 @adr 0479
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { readProfileConfig, writeProfileConfig, type ProfileConfig } from "../../config/profile";
import type { AiMountReport } from "@4pm/ws";
import type { AiCredential, AiProfile, AiProvider } from "../../utils/ai-cli";
import { logger } from "../../common/logger/logger";

/** The providers a mount can be adopted for, with the file that shows a login is there. */
const MOUNTABLE: { provider: AiProvider; loginFiles: string[]; model: string }[] = [
  { provider: "claude", loginFiles: [".credentials.json"], model: "sonnet" },
  { provider: "codex", loginFiles: ["auth.json"], model: "" },
];

/**
 * The per-profile record of mount folder names already adopted (or found configured) — never adopted again.
 * A pre-ADR-0466 entry `claude` / `codex` names the legacy folder of the same name.
 */
function adoptedPath(profileDir: string): string {
  return join(profileDir, "ai-mount-adopted.json");
}

/** Read the adopted-folder record (empty when absent / unreadable). */
function readAdopted(profileDir: string): string[] {
  try {
    const v = JSON.parse(readFileSync(adoptedPath(profileDir), "utf8")) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Resolve a configured profile path to an absolute dir as written (no separation remap). */
function rawDir(value: string): string {
  if (value.startsWith("~")) return resolve(homedir(), value.slice(1).replace(/^[/\\]/, ""));
  return isAbsolute(value) ? resolve(value) : resolve(homedir(), value);
}

/** True when any configured profile — enabled or not, any list — points at `dir`. */
function isReferenced(config: ProfileConfig, dir: string): boolean {
  const lists: (AiProfile[] | undefined)[] = [config.aiProfiles, config.claudeHome, config.codexHome, config.antigravityHome];
  return lists.some((l) => (l ?? []).some((p) => typeof p.profile === "string" && p.profile.trim() && rawDir(p.profile.trim()) === dir));
}

/** True when the mount holds a login the container can see (a mount that is absent or empty ⇒ false). */
function hasLogin(dir: string, files: string[]): boolean {
  return files.some((f) => {
    try {
      return statSync(join(dir, f)).isFile();
    } catch {
      return false;
    }
  });
}

/** The mount folders under `root` for a provider — `<provider>` and `<provider>-*`, sorted for a stable order. */
function mountFolders(root: string, provider: AiProvider): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && (e.name === provider || e.name.startsWith(`${provider}-`)))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Append a profile for each mounted login no profile references (once per mount folder per worker profile).
 * Unified configs get an `aiProfiles` entry; a legacy per-provider config (no `aiProfiles`) gets it in
 * `claudeHome` / `codexHome` so its plan is not replaced. Returns the provider of each folder added.
 */
export function adoptMountedAiLogins(profileDir: string): AiProvider[] {
  const root = resolve(homedir(), "ai-creds");
  if (!existsSync(root)) return [];
  const adopted = readAdopted(profileDir);
  const added: AiProvider[] = [];
  let recordChanged = false;
  for (const m of MOUNTABLE) {
    for (const folder of mountFolders(root, m.provider)) {
      if (adopted.includes(folder)) continue;
      const dir = join(root, folder);
      if (!hasLogin(dir, m.loginFiles)) continue;
      const config = readProfileConfig(profileDir);
      adopted.push(folder);
      recordChanged = true;
      if (isReferenced(config, dir)) continue; // the operator already wired it
      const profile = `ai-creds/${folder}`;
      const unified = Array.isArray(config.aiProfiles) && config.aiProfiles.length > 0;
      const legacy = !unified && [config.claudeHome, config.codexHome, config.antigravityHome].some((l) => (l?.length ?? 0) > 0);
      if (legacy) {
        // A new `aiProfiles` list would replace the legacy plan — extend the provider's own list instead.
        const entry: AiProfile = { profile, args: [], model: m.model };
        const list = (m.provider === "claude" ? config.claudeHome : config.codexHome) ?? [];
        writeProfileConfig(profileDir, m.provider === "claude" ? { claudeHome: [...list, entry] } : { codexHome: [...list, entry] });
      } else {
        const entry: AiCredential = { provider: m.provider, profile, args: [], model: m.model };
        writeProfileConfig(profileDir, { aiProfiles: [...(config.aiProfiles ?? []), entry] });
      }
      added.push(m.provider);
      logger.info("ai.mount.adopted", { provider: m.provider, profile });
    }
  }
  if (recordChanged) {
    try {
      writeFileSync(adoptedPath(profileDir), JSON.stringify(adopted), { mode: 0o600 });
    } catch (err) {
      logger.warn("ai.mount.record", { error: String(err) });
    }
  }
  return added;
}

/** The seeded default profile dir of each provider (`defaultProfileConfig`). */
const DEFAULT_DIRS: { provider: AiProvider; profile: string }[] = [
  { provider: "claude", profile: ".claude" },
  { provider: "codex", profile: ".codex" },
];

/** The per-profile record of default dirs already switched off — never switched off again. */
function disabledPath(profileDir: string): string {
  return join(profileDir, "ai-default-disabled.json");
}

/** Read the switched-off record (empty when absent / unreadable). */
function readDisabled(profileDir: string): string[] {
  try {
    const v = JSON.parse(readFileSync(disabledPath(profileDir), "utf8")) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** The login files of a provider (empty for one that cannot be mounted). */
function loginFilesOf(provider: AiProvider): string[] {
  return MOUNTABLE.find((m) => m.provider === provider)?.loginFiles ?? [];
}

/**
 * Every mounted folder under `~/ai-creds` holding a login, with the profile path a credential uses for it and
 * the signed-in claude email when the mount's `.claude.json` is readable. Empty when nothing is mounted.
 */
export function mountedAiLogins(): AiMountReport[] {
  const root = resolve(homedir(), "ai-creds");
  if (!existsSync(root)) return [];
  const out: AiMountReport[] = [];
  for (const m of MOUNTABLE) {
    for (const folder of mountFolders(root, m.provider)) {
      const dir = join(root, folder);
      if (!hasLogin(dir, m.loginFiles)) continue;
      const account = m.provider === "claude" ? mountAccountEmail(dir) : null;
      out.push({ provider: m.provider, profile: `ai-creds/${folder}`, ...(account ? { account } : {}) });
    }
  }
  return out;
}

/** The account email in a mounted claude login's `.claude.json` (read from the mount itself), or null. */
function mountAccountEmail(dir: string): string | null {
  try {
    const raw = JSON.parse(readFileSync(join(dir, ".claude.json"), "utf8")) as { oauthAccount?: { emailAddress?: string } };
    return raw.oauthAccount?.emailAddress?.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Switch off the seeded `.claude` / `.codex` profiles that hold no login once a mounted login exists — otherwise
 * they stay first in the failover list (every run tries them and fails "Not logged in") and show as AI accounts.
 * Only enabled OAuth entries (no `apiKey`) whose dir has no login file are touched, each default dir once per
 * worker profile, so an operator who re-enables one keeps it. No mount ⇒ no change (a native install may keep
 * its login elsewhere, e.g. the macOS Keychain). Returns the dirs switched off.
 */
export function disableUnloggedDefaults(profileDir: string): string[] {
  if (mountedAiLogins().length === 0) return [];
  const done = readDisabled(profileDir);
  const config = readProfileConfig(profileDir);
  const switched: string[] = [];
  /** Switch off a list's matching default entries, recording each default dir handled. */
  const patchList = <T extends AiProfile>(list: T[] | undefined, providerOf: (p: T) => AiProvider | undefined): T[] | null => {
    if (!Array.isArray(list)) return null;
    let changed = false;
    const next = list.map((p) => {
      const provider = providerOf(p);
      const def = DEFAULT_DIRS.find((d) => d.provider === provider);
      if (!def || typeof p.profile !== "string" || !p.profile.trim()) return p;
      const dir = rawDir(p.profile.trim());
      if (dir !== rawDir(def.profile) || done.includes(def.profile)) return p;
      if (p.enabled === false || p.apiKey || hasLogin(dir, loginFilesOf(def.provider))) return p;
      changed = true;
      if (!switched.includes(def.profile)) switched.push(def.profile);
      return { ...p, enabled: false };
    });
    return changed ? next : null;
  };
  const unified = patchList<AiCredential>(config.aiProfiles, (p) => p.provider);
  const claude = patchList<AiProfile>(config.claudeHome, () => "claude");
  const codex = patchList<AiProfile>(config.codexHome, () => "codex");
  if (switched.length === 0) return [];
  writeProfileConfig(profileDir, {
    ...(unified ? { aiProfiles: unified } : {}),
    ...(claude ? { claudeHome: claude } : {}),
    ...(codex ? { codexHome: codex } : {}),
  });
  try {
    writeFileSync(disabledPath(profileDir), JSON.stringify([...done, ...switched]), { mode: 0o600 });
  } catch (err) {
    logger.warn("ai.default.disabledRecord", { error: String(err) });
  }
  for (const profile of switched) logger.info("ai.default.disabled", { profile });
  return switched;
}
