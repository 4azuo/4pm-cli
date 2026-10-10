/**
 * Adopt host-mounted AI logins as profiles (ADR-0433). The web run command mounts a host login at the fixed
 * `~/ai-creds/<provider>` (claude / codex); without a profile pointing there the provider would run
 * "Not logged in". At start, a mount that holds a login and that no profile references is appended to the
 * credential list once — the operator's order stays first; a profile they later remove is never re-added.
 */
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { readProfileConfig, writeProfileConfig, type ProfileConfig } from "../config/profile";
import type { AiCredential, AiProfile, AiProvider } from "../utils/ai-cli";
import { logger } from "../common/logger/logger";

/** The providers a mount can be adopted for, with the file that shows a login is there. */
const MOUNTABLE: { provider: AiProvider; loginFiles: string[]; model: string }[] = [
  { provider: "claude", loginFiles: [".credentials.json"], model: "sonnet" },
  { provider: "codex", loginFiles: ["auth.json"], model: "" },
];

/** The per-profile record of providers already adopted (or found configured) — never adopted again. */
function adoptedPath(profileDir: string): string {
  return join(profileDir, "ai-mount-adopted.json");
}

/** Read the adopted-provider record (empty when absent / unreadable). */
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

/**
 * Append a profile for each mounted login no profile references (once per provider per worker profile).
 * Unified configs get an `aiProfiles` entry; a legacy per-provider config (no `aiProfiles`) gets it in
 * `claudeHome` / `codexHome` so its plan is not replaced. Returns the providers added.
 */
export function adoptMountedAiLogins(profileDir: string): AiProvider[] {
  const root = resolve(homedir(), "ai-creds");
  if (!existsSync(root)) return [];
  const adopted = readAdopted(profileDir);
  const added: AiProvider[] = [];
  let recordChanged = false;
  for (const m of MOUNTABLE) {
    if (adopted.includes(m.provider)) continue;
    const dir = join(root, m.provider);
    if (!hasLogin(dir, m.loginFiles)) continue;
    const config = readProfileConfig(profileDir);
    adopted.push(m.provider);
    recordChanged = true;
    if (isReferenced(config, dir)) continue; // the operator already wired it
    const profile = `ai-creds/${m.provider}`;
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
  if (recordChanged) {
    try {
      writeFileSync(adoptedPath(profileDir), JSON.stringify(adopted), { mode: 0o600 });
    } catch (err) {
      logger.warn("ai.mount.record", { error: String(err) });
    }
  }
  return added;
}
