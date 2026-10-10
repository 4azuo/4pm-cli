/**
 * Multi-instance profiles: each cli instance runs with its own profile
 * `4pm --profile <name>` (or the FOURPM_PROFILE env var) — a separate config dir +
 * `.cre` at ~/.4pm/profiles/<name>/. Without `--profile`, the default profile is keyed
 * by the paired MACHINE userId, stored in the ~/.4pm/default pointer;
 * `default` is only the legacy fallback (pre-ADR-0047).
 * @adr 0014 @adr 0047
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { Locale } from "@4pm/constants";
import { ensureDir } from "../common/io/ensure-dir";
import type { AiCredential, AiProfile } from "../utils/ai-cli";
import { agentUser, registerAgentRoot, shareWithAgent, traversableByAgent } from "../utils/agent-user";

/** Legacy default profile name (pre-ADR-0047 fallback). */
export const DEFAULT_PROFILE = "default";

/** Path to the ~/.4pm/default pointer (holds the userId of the default profile). */
function defaultPointerPath(): string {
  return join(homedir(), ".4pm", "default");
}

/**
 * The default profile name = the userId in ~/.4pm/default, falling back to
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
  ensureDir(join(homedir(), ".4pm"), fourpmHomeMode());
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
  /**
   * UI language for the cli's own operator-facing error messages, set from the
   * Worker configs form. Operator-editable (not server-managed). Absent ⇒ the cli falls back
   * to `FOURPM_LOCALE`/`LANG`/`LC_ALL`, then English.
   * @adr 0276
   */
  locale?: Locale;
  /** Auto-update on startup — defaults to true. @adr 0015 */
  autoUpdate?: boolean;
  /**
   * Catalog ids / npm package names flagged for per-tool auto-update. The daily
   * maintenance tick (ADR-0074, org-gated + idle-only) runs `npm i -g <pkg>@latest` for each.
   * Since ADR-0254 the authoritative flags live in the DB `MachineLink.toolSnapshot`; this is a
   * **server-seeded local mirror** written from `ws_token.toolRestore.autoUpdate` on each connect, so
   * the idle tick can read it without a round-trip. Empty/absent ⇒ none.
   * @adr 0253
   */
  autoUpdateTools?: string[];
  /**
   * Toolchain self-install: install a missing gh/glab at start and the AI CLIs of the enabled
   * profiles at start + on use. Defaults to true; `false` leaves installs to the Tools tab's Install button.
   * @adr 0396
   */
  autoInstallTools?: boolean;
  /**
   * Timeout (seconds) for a global tool install/update/restore op — bounds each
   * `npm i -g`/`pnpm add -g` attempt so a hung child can't wedge a restore, while being long enough
   * for a cold npm on a slow container egress (the old fixed 180s was too short). `0`/absent ⇒ the
   * 300s default. Detection probes (`--version`, `npm ls -g`) keep their own short timeouts.
   * @adr 0258
   */
  toolInstallTimeoutSec?: number;
  /**
   * Minutes between periodic git snapshots of the served project — each one runs
   * `git fetch --prune` first so the server sees origin as of now. Absent/invalid ⇒ 10; `0` disables the
   * periodic run (event-driven snapshots still go out).
   * @adr 0369 @arch 0051
   */
  gitSnapshotIntervalMin?: number;
  /** The physic project folder this cli serves (assigned by the server). */
  physicPath?: string | null;
  /** Interval to upload command history to R2 (minutes) — defaults to 10. */
  commandHistoryUploadMinutes?: number;
  /** AI CLI the TUI input box drives — defaults to "claude". @adr 0057 */
  aiCli?: string;
  /**
   * Claude profiles to run — each `{ profile, args?, model? }` sets CLAUDE_CONFIG_DIR to
   * its `profile` dir. A **list** of candidates tried in order until one authenticates
   * (the working one is remembered). `args` are EXTRA pre-prompt args appended
   * after the hardcoded required metering flags; `model` is passed as `--model`.
   * @adr 0158 @adr 0057
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
   * Unified mixed credential list. Each `{ provider, profile, args?, model?, enabled?,
   * label? }` names the AI CLI it drives, so a single ordered list intermixes claude/codex/
   * antigravity accounts. When present (≥1 usable entry) it REPLACES `claudeHome`/`codexHome`/
   * `antigravityHome` + the single `aiCli` for the run plan: failover walks it in order and can
   * cross providers. Absent ⇒ the legacy per-`aiCli` plan (backward-compatible — no migration).
   * @adr 0182
   */
  aiProfiles?: AiCredential[];
  /**
   * Failover start policy: `"remember"` starts from the last-working credential;
   * `"priority"` always starts at the top of `aiProfiles`. Default `"remember"`.
   * @adr 0182 @adr 0057
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
   * Read-only mirror of the serving project's runtime token knobs, refreshed
   * from each `ws_token`. The server is the source of truth — these are
   * cached locally only so the AI prompt path can enforce them without a round-trip.
   * @api machine-0003 @adr 0081
   */
  /** Session (5h) utilization % that triggers a Claude profile rotation; 0 = off. */
  sessionSwitchPct?: number;
  /** Estimated-token ceiling for a single prompt; 0 = no limit. */
  perPromptTokenLimit?: number;
  /**
   * Machine-user default wall-clock ceiling (seconds) for a single AI run before the cli
   * terminates the spawned AI CLI. Operator-editable via the Worker config; 0 = no
   * limit. Overridden per-project by the read-only `projectAiRunTimeoutSec` mirror below when >0.
   * @adr 0243
   */
  aiRunTimeoutSec?: number;
  /**
   * 4pm-cli slash commands blocked from the **web Console** — operator-editable via the
   * Worker config + config templates. A `/name` line dispatched from the web runs on the worker
   * unless its `name` is listed here. Machine-user policy (not per-project); default blocks the two
   * that tamper with / kill the worker — `quit` + `config` — everything else allowed (`[]` = allow all).
   * The TUI is unaffected (an operator at the machine keeps every command).
   * @adr 0249
   */
  webBlockedCommands?: string[];
  /**
   * Read-only mirror of the serving project's AI-run timeout override, refreshed from
   * each `ws_token` like the two knobs above. Server is the source of truth; >0 wins over the
   * machine-user `aiRunTimeoutSec`; 0 ⇒ no project override. Never operator-editable (a Worker-config
   * write preserves it — a server-managed key).
   * @adr 0243
   */
  projectAiRunTimeoutSec?: number;
  /**
   * Read-only mirror of the serving project's idle auto-clear override, refreshed from
   * each `ws_token` like the knobs above. Server is the source of truth; >0 wins over the
   * machine-user `autoClearIdleMinutes`; 0 ⇒ no project override. Never operator-editable (a
   * Worker-config write preserves it — a server-managed key).
   * @adr 0244
   */
  projectAutoClearIdleMinutes?: number;
  /**
   * Shared AI memory — machine-user defaults, operator-editable via the Worker config.
   * `aiMemoryEnabled` turns the rolling cross-profile memory on for this worker (default false;
   * costs an extra compaction AI call per turn); `aiMemoryBudgetChars` caps the compacted text
   * (default 1000, max 9999). Overridden per-project by the two read-only mirror keys below.
   * @adr 0245
   */
  aiMemoryEnabled?: boolean;
  aiMemoryBudgetChars?: number;
  /**
   * Bounded native `--resume` — operator-editable. A remembered claude session is resumed
   * only if its last run ended ≤ `aiResumeMaxIdleMinutes` ago (default 5, the prompt-cache TTL) and
   * its context is ≤ `aiResumeMaxContextTokens` (default 100 000); otherwise a fresh session seeded
   * with the shared memory. `0` ⇒ that bound is off.
   * @adr 0339
   */
  aiResumeMaxIdleMinutes?: number;
  aiResumeMaxContextTokens?: number;
  /**
   * Read-only mirror of the serving project's memory override, refreshed from each
   * `ws_token`. Server is the source of truth; `mode` `on`/`off` forces enablement (else `inherit`
   * defers to `aiMemoryEnabled`), `projectAiMemoryBudgetChars` `>0` wins over `aiMemoryBudgetChars`.
   * Never operator-editable (server-managed keys).
   * @adr 0245
   */
  projectAiMemoryMode?: "inherit" | "on" | "off";
  projectAiMemoryBudgetChars?: number;
  /**
   * Read-only mirror of `ws_token.maskAiAccounts`: on a platform-pool (rented) worker the
   * AI credential labels are shown as `AI account #N`. Kept here so `4pm start` masks the header
   * before the first token arrives. Server-managed, never operator-editable.
   * @adr 0395
   */
  maskAiAccounts?: boolean;
}

/**
 * Extract the EXPLICIT profile from args (--profile <name>) or the FOURPM_PROFILE env
 * var. Returns [explicit profile | null, args with the --profile pair removed]. When
 * null, callers resolve the default lazily: `link` derives it from the paired userId;
 * other commands use `defaultProfileName()`.
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
 * (have a `.cre`). Used for the interactive picker instead of `--profile`.
 * @adr 0063
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
 * Mode of `~/.4pm`: owner-only, except under uid separation where the shared group may
 * traverse it (`0710` — no listing) to reach `workspaces/`; the profiles inside stay `0700`.
 * @adr 0430
 */
function fourpmHomeMode(): number {
  return agentUser() ? 0o710 : 0o700;
}

/**
 * Prepare the workspace of a profile for uid separation, at `start`/`link`: `umask 007` (files
 * the cli and the agent create in a project stay group-writable), `~/.4pm` traversable by the shared group,
 * `~/.4pm/workspaces/<profile>` shared (`2770`) and registered so every process run in it runs as the
 * agent. No-op when separation is off.
 * @adr 0430
 */
export function prepareWorkspaces(profileDirPath: string): void {
  if (!agentUser()) return;
  process.umask(0o007);
  ensureDir(join(homedir(), ".4pm"), fourpmHomeMode());
  traversableByAgent(join(homedir(), ".4pm"));
  const root = workspaceRoot(profileDirPath);
  mkdirSync(root, { recursive: true });
  const parent = join(root, "..");
  if (parent !== resolve(homedir(), ".4pm")) shareWithAgent(parent);
  shareWithAgent(root);
  registerAgentRoot(root);
}

/**
 * Where a profile's served projects live: `~/.4pm/workspaces/<profile>/` — OUTSIDE the profile
 * dir, so the profile (`.cre`, config, logs, sockets) can stay owner-only while the project tree is shared
 * with the agent user, and the claude deny rules on `~/.4pm/profiles/**` never cover the project itself.
 * `SCAFFOLD_ROOT` overrides it (tests / custom layouts).
 * @adr 0430
 */
export function workspaceRoot(profileDirPath: string): string {
  if (process.env.SCAFFOLD_ROOT) return resolve(process.env.SCAFFOLD_ROOT);
  return join(homedir(), ".4pm", "workspaces", basename(profileDirPath));
}

/** A filesystem-safe project folder name (no separators, no `..`); "" when nothing usable is left. */
export function safeProjectFolderName(projectName: string): string {
  return projectName.replace(/[/\\]/g, "_").replace(/\.\./g, "_").trim();
}

/**
 * The folder a project is served from (folder = sanitized project name); null when unusable.
 * @adr 0064 @adr 0430
 */
export function projectFolder(profileDirPath: string, projectName: string): string | null {
  const safe = safeProjectFolderName(projectName);
  return safe ? join(workspaceRoot(profileDirPath), safe) : null;
}

/**
 * The profile directory ~/.4pm/profiles/<name>/ (created if missing).
 */
export function profileDir(name: string): string {
  const dir = join(homedir(), ".4pm", "profiles", name);
  // 0o700 (owner-only): the profile dir holds the `.cre`, AI credentials, the control socket + its
  // token — no other OS user should traverse or read it (ADR-0320 hardening).
  ensureDir(dir, 0o700);
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
    // Terminate a single AI run after 5 min by default (ADR-0243) so a hung/looping AI CLI
    // (e.g. a heavy spec review/compose) can't spin the dispatcher forever; 0 = no limit.
    aiRunTimeoutSec: 300,
    // Web-Console blocked slash commands (ADR-0249): block the two that tamper with / kill the
    // worker by default — `/quit` (stops the cli — DoS) and `/config` (writes config.json). Every
    // other command (incl. /reconnect, /logs — non-destructive) is allowed; operators adjust this
    // list in the Worker config. Empty ⇒ allow all.
    webBlockedCommands: ["quit", "config"],
    // Shared AI memory (ADR-0245) — off by default (opt-in; costs a compaction call per turn).
    aiMemoryEnabled: false,
    aiMemoryBudgetChars: 1000,
    // Bounded native resume (ADR-0339) — resume only a warm (≤5 min), not-too-large session.
    aiResumeMaxIdleMinutes: 5,
    aiResumeMaxContextTokens: 100_000,
  };
}

/**
 * Resolve the effective shared-AI-memory config for a serving cli: the project override
 * (server-managed mirror) wins — `mode` `on`/`off` forces enablement, else `inherit` defers to the
 * machine-user `aiMemoryEnabled`; the project budget wins when `>0`, else the machine-user budget
 * (default 1000). `enabled:false` ⇒ memory is off (no inject, no compaction).
 * @adr 0245
 */
export function resolveMemoryConfig(config: ProfileConfig): { enabled: boolean; budgetChars: number } {
  const mode = config.projectAiMemoryMode ?? "inherit";
  const enabled = mode === "on" ? true : mode === "off" ? false : (config.aiMemoryEnabled ?? false);
  const projectBudget = config.projectAiMemoryBudgetChars ?? 0;
  const budgetChars = projectBudget > 0 ? projectBudget : (config.aiMemoryBudgetChars ?? 1000);
  return { enabled, budgetChars };
}

/**
 * Resolve the bounded-resume limits: the max idle gap (ms) since the session's last run
 * and the max context tokens it may carry to still be resumed. `0` in config ⇒ that bound is off
 * (returned as `Infinity`); absent ⇒ the defaults (5 min / 100 000 tokens).
 * @adr 0339
 */
export function resolveResumePolicy(config: ProfileConfig): { maxIdleMs: number; maxContextTokens: number } {
  const idleMin = config.aiResumeMaxIdleMinutes ?? 5;
  const maxCtx = config.aiResumeMaxContextTokens ?? 100_000;
  return {
    maxIdleMs: idleMin > 0 ? idleMin * 60_000 : Number.POSITIVE_INFINITY,
    maxContextTokens: maxCtx > 0 ? maxCtx : Number.POSITIVE_INFINITY,
  };
}

/**
 * Resolve the effective idle transcript auto-clear window (minutes) for a serving cli:
 * the project override (`projectAutoClearIdleMinutes`, the server-managed mirror) wins when > 0,
 * else the machine-user's own `autoClearIdleMinutes` (default 10). 0 ⇒ disabled.
 * @adr 0244
 */
export function resolveIdleAutoClearMinutes(config: ProfileConfig): number {
  const project = config.projectAutoClearIdleMinutes ?? 0;
  return project > 0 ? project : (config.autoClearIdleMinutes ?? 10);
}

/** The safe default web-blocked commands when the key is absent — quit + config. @adr 0249 */
export const DEFAULT_WEB_BLOCKED_COMMANDS = ["quit", "config"];

/**
 * The set of 4pm-cli slash commands blocked from the web Console — the operator's
 * `webBlockedCommands` normalised to lower-case names. **Absent (undefined) ⇒ the safe default**
 * (quit + config); an explicit `[]` ⇒ allow all. TUI is never gated.
 * @adr 0249
 */
export function resolveWebBlockedCommands(config: ProfileConfig): Set<string> {
  const list = Array.isArray(config.webBlockedCommands)
    ? config.webBlockedCommands
    : DEFAULT_WEB_BLOCKED_COMMANDS;
  return new Set(list.map((c) => String(c).trim().toLowerCase()).filter(Boolean));
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
 * Backfill absent operator-default keys into an EXISTING config.json (ADR-0244 follow-up).
 * `ensureProfileConfig` seeds defaults only when the file is missing, so a config written before a
 * default was introduced (e.g. `aiRunTimeoutSec`) keeps that field absent — which resolves to
 * "no limit"/"off" and silently defeats the safeguard. On boot we merge in any missing default
 * key (a present value — including an explicit `0` — is never overwritten; server-managed mirror
 * keys are absent from the defaults, so they stay untouched) and write back only when something
 * changed. Returns whether it wrote.
 */
export function backfillProfileConfig(dir: string): boolean {
  if (!existsSync(join(dir, "config.json"))) return false;
  const current = readProfileConfig(dir) as Record<string, unknown>;
  const next = { ...current };
  let changed = false;
  for (const [key, value] of Object.entries(defaultProfileConfig() as Record<string, unknown>)) {
    if (next[key] === undefined) {
      next[key] = value;
      changed = true;
    }
  }
  if (changed) overwriteProfileConfig(dir, next as ProfileConfig);
  return changed;
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
