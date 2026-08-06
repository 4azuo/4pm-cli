/**
 * Multi-instance profiles (ADR-0014): each cli instance runs with its own profile
 * `4pm --profile <name>` (or the FOURPM_PROFILE env var) — a separate config dir +
 * `.cre` at ~/.4pm/profiles/<name>/. Without `--profile`, the default profile is keyed
 * by the paired MACHINE userId (ADR-0047), stored in the ~/.4pm/default pointer;
 * `default` is only the legacy fallback (pre-ADR-0047).
 */
import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ensureDir } from "../common/io/ensure-dir";
import type { AiCredential, AiProfile } from "../utils/ai-cli";

/** Legacy default profile name (pre-ADR-0047 fallback). */
export const DEFAULT_PROFILE = "default";

/** Path to the ~/.4pm/default pointer (holds the userId of the default profile). */
function defaultPointerPath(): string {
  return join(homedir(), ".4pm", "default");
}

/**
 * The default profile name = the userId in ~/.4pm/default (ADR-0047), falling back to
 * the legacy `default` profile when the pointer is absent.
 */
export function defaultProfileName(): string {
  try {
    const userId = readFileSync(defaultPointerPath(), "utf8").trim();
    if (userId) return userId;
  } catch {
    // no pointer ⇒ legacy fallback
  }
  return DEFAULT_PROFILE;
}

/** Point the default profile at a MACHINE userId (written on `4pm link` sans --profile). */
export function writeDefaultProfile(userId: string): void {
  ensureDir(join(homedir(), ".4pm"));
  writeFileSync(defaultPointerPath(), userId, "utf8");
}

/** Clear the default pointer when it points at `name` (on unlink of the default). */
export function clearDefaultProfileIf(name: string): void {
  try {
    if (readFileSync(defaultPointerPath(), "utf8").trim() === name) {
      rmSync(defaultPointerPath(), { force: true });
    }
  } catch {
    // no pointer ⇒ nothing to clear
  }
}

/** Per-profile config (config.json inside the profile directory). */
export interface ProfileConfig {
  /** Auto-update on startup (ADR-0015) — defaults to true. */
  autoUpdate?: boolean;
  /** The physic project folder this cli serves (assigned by the server). */
  physicPath?: string | null;
  /** Interval to upload command history to R2 (minutes) — defaults to 10. */
  commandHistoryUploadMinutes?: number;
  /** AI CLI the TUI input box drives (ADR-0057) — defaults to "claude". */
  aiCli?: string;
  /**
   * Claude profiles to run — each `{ profile, args?, model? }` sets CLAUDE_CONFIG_DIR to
   * its `profile` dir. A **list** of candidates tried in order until one authenticates
   * (the working one is remembered — ADR-0057). `args` are EXTRA pre-prompt args appended
   * after the hardcoded required metering flags (ADR-0158); `model` is passed as `--model`.
   */
  claudeHome?: AiProfile[];
  /** Codex profiles to run — same shape; each sets CODEX_HOME to its `profile` dir. */
  codexHome?: AiProfile[];
  /**
   * Reserved for the future antigravity CLI (schema only) — stored/editable but not
   * spawned with a home dir yet.
   */
  antigravityHome?: AiProfile[];
  /**
   * Unified mixed credential list (ADR-0182). Each `{ provider, profile, args?, model?, enabled?,
   * label? }` names the AI CLI it drives, so a single ordered list intermixes claude/codex/
   * antigravity accounts. When present (≥1 usable entry) it REPLACES `claudeHome`/`codexHome`/
   * `antigravityHome` + the single `aiCli` for the run plan: failover walks it in order and can
   * cross providers. Absent ⇒ the legacy per-`aiCli` plan (backward-compatible — no migration).
   */
  aiProfiles?: AiCredential[];
  /**
   * Failover start policy (ADR-0182): `"remember"` starts from the last-working credential
   * (ADR-0057); `"priority"` always starts at the top of `aiProfiles`. Default `"remember"`.
   */
  aiFailoverMode?: "remember" | "priority";
  /** Extra env passed when spawning the AI CLI (overrides the mapped ones above). */
  aiEnv?: Record<string, string>;
  /**
   * Auto-clear the TUI transcript after this many minutes with no local (operator) input —
   * bounds an idle session's on-screen buffer. Never clears mid-response. 0 = off; default 10.
   */
  autoClearIdleMinutes?: number;
  /**
   * Read-only mirror of the serving project's runtime token knobs (ADR-0081), refreshed
   * from each `ws_token` (machine-0003). The server is the source of truth — these are
   * cached locally only so the AI prompt path can enforce them without a round-trip.
   */
  /** Session (5h) utilization % that triggers a Claude profile rotation; 0 = off. */
  sessionSwitchPct?: number;
  /** Estimated-token ceiling for a single prompt; 0 = no limit. */
  perPromptTokenLimit?: number;
}

/**
 * Extract the EXPLICIT profile from args (--profile <name>) or the FOURPM_PROFILE env
 * var. Returns [explicit profile | null, args with the --profile pair removed]. When
 * null, callers resolve the default lazily: `link` derives it from the paired userId;
 * other commands use `defaultProfileName()` (ADR-0047).
 */
export function resolveProfileArg(args: string[]): [string | null, string[]] {
  const index = args.indexOf("--profile");
  if (index >= 0) {
    const name = args[index + 1];
    if (!name || name.startsWith("--")) {
      throw new Error("--profile requires a profile name.");
    }
    const rest = [...args.slice(0, index), ...args.slice(index + 2)];
    return [name, rest];
  }
  // `||` not `??`: FOURPM_PROFILE="" means "not set" — `??` would return "" and select a
  // nameless profile instead of falling back to the default.
  return [process.env.FOURPM_PROFILE || null, args];
}

/** A discovered profile under ~/.4pm/profiles/. */
export interface ProfileEntry {
  name: string;
  /** Has a credential (`.cre`) ⇒ paired/linked. */
  linked: boolean;
}

/**
 * List profiles under ~/.4pm/profiles/ (each a directory), flagging which are linked
 * (have a `.cre`). Used for the interactive picker (ADR-0063) instead of `--profile`.
 */
export function listProfiles(): ProfileEntry[] {
  const base = join(homedir(), ".4pm", "profiles");
  if (!existsSync(base)) return [];
  try {
    return readdirSync(base, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => ({
        name: d.name,
        linked: existsSync(join(base, d.name, "credential.cre")),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

/**
 * The profile directory ~/.4pm/profiles/<name>/ (created if missing).
 */
export function profileDir(name: string): string {
  const dir = join(homedir(), ".4pm", "profiles", name);
  ensureDir(dir);
  return dir;
}

/**
 * Canonical default config written when a profile's config.json is first created — the
 * single source of truth shared by `4pm link` (scaffolds on pairing) and `/config init`
 * so both paths produce an identical structure. Runtime knobs (sessionSwitchPct /
 * perPromptTokenLimit) are NOT here: the server owns them and merges them in per ws_token.
 */
export function defaultProfileConfig(): ProfileConfig {
  return {
    // `aiCli` still names the provider the OAuth-only paths use (usage snapshot / support answer).
    aiCli: "claude",
    // Unified mixed credential list (ADR-0182): one ordered, cross-provider failover chain — the
    // list order IS the priority, and `aiFailoverMode` picks working-first vs top-first. `args`
    // here are EXTRA args only (empty by default) — the token-metering flags (claude stream-json /
    // codex `exec --json`) are hardcoded in source and always injected (ADR-0158, ADR-0072), so
    // they can't be dropped by editing this file. `model` = the CLI's `--model` flag; default
    // "sonnet" (balanced mid-price tier). "" ⇒ the CLI's own default model.
    aiProfiles: [
      { provider: "claude", profile: ".claude", args: [], model: "sonnet" },
      { provider: "codex", profile: ".codex", args: [], model: "" },
    ],
    aiFailoverMode: "remember",
    autoUpdate: true,
    commandHistoryUploadMinutes: 10,
    autoClearIdleMinutes: 10,
  };
}

/**
 * Scaffold config.json with the canonical defaults when it does not exist yet; a no-op
 * when it already does (never clobbers operator edits). Returns whether it was created.
 */
export function ensureProfileConfig(dir: string): boolean {
  if (existsSync(join(dir, "config.json"))) return false;
  writeProfileConfig(dir, defaultProfileConfig());
  return true;
}

/**
 * Read the per-profile config (config.json) — missing file ⇒ defaults.
 */
export function readProfileConfig(dir: string): ProfileConfig {
  const path = join(dir, "config.json");
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ProfileConfig;
  } catch {
    return {};
  }
}

/**
 * Write (merge) the per-profile config.
 */
export function writeProfileConfig(
  dir: string,
  patch: ProfileConfig,
): ProfileConfig {
  const merged = { ...readProfileConfig(dir), ...patch };
  writeFileSync(join(dir, "config.json"), JSON.stringify(merged, null, 2), "utf8");
  return merged;
}

/**
 * Overwrite config.json wholesale with `config` (no merge) — used by `/config init` to
 * REPLACE an existing file with fresh defaults so stale/old-schema keys are dropped.
 */
export function overwriteProfileConfig(dir: string, config: ProfileConfig): ProfileConfig {
  writeFileSync(join(dir, "config.json"), JSON.stringify(config, null, 2), "utf8");
  return config;
}

/**
 * Delete one key from the per-profile config; returns the updated config.
 */
export function deleteProfileConfigKey(
  dir: string,
  key: keyof ProfileConfig,
): ProfileConfig {
  const config = readProfileConfig(dir);
  delete config[key];
  writeFileSync(join(dir, "config.json"), JSON.stringify(config, null, 2), "utf8");
  return config;
}
