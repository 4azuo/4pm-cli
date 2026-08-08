/**
 * Plan how the TUI input box drives an AI CLI (ADR-0057). The operator types a
 * natural-language prompt; by default it goes to `claude` (print mode) so the AI agent
 * itself decides whether to call `gh`/`glab`/`git`/etc. — no command whitelist.
 *
 * Each provider (claudeHome / codexHome / antigravityHome) is a **list** of profiles: the
 * runner tries them in order until one authenticates, then remembers the working one
 * (working-first ordering here). Every profile's `args` are EXTRA pre-prompt args
 * appended AFTER the hardcoded required args (ADR-0158) — they can add options but never
 * strip the token-metering flags — plus an optional `model`. Pure helper.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";

/**
 * REQUIRED pre-prompt args per known AI CLI (ADR-0158) — **hardcoded in source and always
 * injected** so token metering can never be turned off by an operator's config edit.
 * Claude runs headless via `-p` and emits **stream-json** (needs `--verbose`) so the cli
 * renders text live AND reads the real token usage from the final `result` event; codex
 * runs `exec --json` for the same reason (its JSONL `turn.completed` carries usage —
 * ADR-0072). A profile's own `args` are appended as EXTRAS on top of these, never
 * replacing them. Antigravity has none yet (schema-only until its CLI is wired — ADR-0138).
 */
const REQUIRED_AI_ARGS: { claude: string[]; codex: string[]; antigravity: string[] } = {
  claude: ["-p", "--output-format", "stream-json", "--verbose"],
  codex: ["exec", "--json"],
  antigravity: [],
};

/** The hardcoded required args for a command (substring match — `cmd` may be a path). */
function requiredArgs(cmd: string): string[] {
  if (cmd.includes("claude")) return REQUIRED_AI_ARGS.claude;
  if (cmd.includes("codex")) return REQUIRED_AI_ARGS.codex;
  return REQUIRED_AI_ARGS.antigravity;
}

/** Fallback AI CLI when the profile does not configure one. */
const DEFAULT_AI_CLI = "claude";

/**
 * One AI-CLI profile (config.json). `profile` is the home/config directory selecting the
 * signed-in account (CLAUDE_CONFIG_DIR / CODEX_HOME / …) — an absolute path, "~/x", or a
 * bare name resolved under $HOME (e.g. ".claude-1"). `args` are EXTRA pre-prompt args
 * appended after the hardcoded required args (ADR-0158) — they cannot remove the required
 * metering flags (omitted ⇒ just the required args). `model` is passed as `--model <model>`
 * (omitted/empty ⇒ the CLI's own default model). `enabled` (ADR-0180) defaults true; a
 * profile with `enabled: false` is kept in config.json but excluded from the run plan (never
 * spawned; skipped by failover — ADR-0057 — and %session rotation — ADR-0081).
 */
export interface AiProfile {
  profile: string;
  args?: string[];
  model?: string;
  enabled?: boolean;
}

/** The AI providers a credential can target — each maps to a CLI command + config-dir env var. */
export type AiProvider = "claude" | "codex" | "antigravity";

/** The known providers, for validating hand-edited config entries. */
const AI_PROVIDERS: readonly AiProvider[] = ["claude", "codex", "antigravity"];

/**
 * One entry in the unified, mixed credential list (`config.aiProfiles` — ADR-0182): an AiProfile
 * plus the `provider` that selects which AI CLI it drives (command + hardcoded metering args +
 * `CLAUDE_CONFIG_DIR`/`CODEX_HOME`). The account/auth (OAuth **or** the user's own API key) is
 * configured by the user INSIDE the `profile` config dir — 4PM never stores a key. `label` is an
 * optional display name (falls back to the signed-in account email / the dir basename).
 */
export interface AiCredential extends AiProfile {
  provider: AiProvider;
  label?: string;
}

/** A profile is usable when it has a non-blank dir and isn't explicitly disabled (ADR-0180). */
function isUsableProfile(p: AiProfile): boolean {
  return p.enabled !== false && Boolean(p.profile && p.profile.trim());
}

/** A credential is usable when it is a usable profile AND names a known provider (ADR-0182). */
export function isUsableCredential(c: AiCredential): boolean {
  return isUsableProfile(c) && AI_PROVIDERS.includes(c.provider);
}

/** Config knobs the planner reads (subset of ProfileConfig). */
export interface AiCliConfig {
  aiCli?: string;
  claudeHome?: AiProfile[];
  codexHome?: AiProfile[];
  /** Reserved for the future antigravity CLI — stored but not spawned yet (schema only). */
  antigravityHome?: AiProfile[];
  /**
   * Unified mixed credential list (ADR-0182). When present (with ≥1 usable entry) it REPLACES
   * the per-provider lists for the run plan: one ordered, cross-provider failover chain. Absent
   * ⇒ the legacy per-`aiCli` single-provider plan.
   */
  aiProfiles?: AiCredential[];
  /**
   * Failover start policy (ADR-0182): `"remember"` starts from the last-working credential
   * (ADR-0057); `"priority"` always starts at the top of the list. Default `"remember"`.
   */
  aiFailoverMode?: "remember" | "priority";
  aiEnv?: Record<string, string>;
}

/** One profile attempt: a display label + the argv + the env selecting that profile. */
export interface AiAttempt {
  /** The provider command to spawn — per-attempt, since a mixed plan can vary across attempts. */
  cmd: string;
  label: string;
  /** The resolved profile dir (null for the CLI's default env) — remembered on success. */
  dir: string | null;
  /** Stable credential key (provider + resolved dir), or null for the default env — remembered. */
  key: string | null;
  /** Full argv after the command (pre-prompt args + `--model` + the prompt). */
  args: string[];
  env: Record<string, string>;
}

/** A resolved plan: a representative command (first attempt's) + the ordered attempts to try. */
export interface AiPlan {
  cmd: string;
  attempts: AiAttempt[];
}

/** Stable identifier of a credential (provider + resolved dir) — for the working-first memory. */
export function credentialKey(provider: string, resolvedDir: string): string {
  return `${provider}::${resolvedDir}`;
}

/** The profile dir encoded in a credential key (everything after the `::`). */
export function dirFromCredentialKey(key: string): string {
  const at = key.indexOf("::");
  return at >= 0 ? key.slice(at + 2) : key;
}

/** Human label for a credential key (the signed-in account email, else the dir basename). */
export function labelFromCredentialKey(key: string): string {
  return profileDisplayLabel(dirFromCredentialKey(key));
}

/**
 * Claude auth mode for metering (ADR-0192 §5): `api-key` when an `ANTHROPIC_API_KEY` is present
 * (in the profile's `aiEnv` or the cli process env — the API-billed path), else `subscription`
 * (OAuth account, metered from `.credentials.json` — ADR-0072). Tags each usage report so billing
 * can split subscription vs API-key runs.
 */
export function resolveClaudeAuthMode(config: AiCliConfig): "subscription" | "api-key" {
  const key = config.aiEnv?.["ANTHROPIC_API_KEY"] ?? process.env.ANTHROPIC_API_KEY;
  return key && key.trim() ? "api-key" : "subscription";
}

/** True when the unified mixed list drives the run (≥1 usable entry) — else the legacy plan. */
export function isUnifiedConfig(config: AiCliConfig): boolean {
  return Array.isArray(config.aiProfiles) && config.aiProfiles.some(isUsableCredential);
}

/**
 * The provider the operator pinned via `aiCli`. When it names a known provider the unified run
 * (ADR-0182) is **scoped** to that provider's credentials (ADR-0197) — failover stays within the
 * active CLI; a blank/"—"/unknown value ⇒ null = **mixed** (fail over across the whole list).
 * Legacy per-`aiCli` configs already run one provider, so this only affects the unified plan.
 */
export function activeProvider(config: AiCliConfig): AiProvider | null {
  const v = config.aiCli?.trim();
  return v && (AI_PROVIDERS as readonly string[]).includes(v) ? (v as AiProvider) : null;
}

/**
 * The effective claude profile list for the OAuth-only paths (usage snapshot, %session rotation,
 * support answer): the unified list's claude entries when it drives the run, else the legacy
 * `claudeHome`.
 */
function claudeProfilesOf(config: AiCliConfig): AiProfile[] {
  if (isUnifiedConfig(config)) return config.aiProfiles!.filter((c) => c.provider === "claude");
  return config.claudeHome ?? [];
}

/** Ordered credential keys of the usable claude entries (for unified %session rotation). */
export function claudeCredentialKeys(config: AiCliConfig): string[] {
  return claudeProfilesOf(config)
    .filter(isUsableProfile)
    .map((p) => credentialKey("claude", resolveHomePath(p.profile)));
}

/**
 * Resolve a config path: absolute stays as-is; "~/x" and a bare name (e.g.
 * ".claude-1") resolve under $HOME.
 */
export function resolveHomePath(value: string): string {
  if (value.startsWith("~")) return join(homedir(), value.slice(1).replace(/^[/\\]/, ""));
  if (isAbsolute(value)) return value;
  return join(homedir(), value);
}

/** Normalize a profile list into a resolved dir list (dropping blank/disabled entries). */
function profileDirs(profiles: AiProfile[] | undefined): string[] {
  if (!profiles) return [];
  return profiles.filter(isUsableProfile).map((p) => resolveHomePath(p.profile));
}

/**
 * Prepend a folder-scope guard to a prompt (project aiScope hardening): instruct the AI to
 * only read/use/modify content inside the served worker project folder, then the operator's
 * original prompt. Returned only to the spawned AI — the transcript/console still echo the
 * raw prompt.
 */
export function folderScopeGuard(folder: string, prompt: string): string {
  return [
    `IMPORTANT: You are working inside the project folder \`${folder}\`. Only read, use, and`,
    "modify content inside this folder to accomplish the task; do not access, reference, or",
    "change anything outside it.",
    "",
    prompt,
  ].join("\n");
}

/**
 * Compose the argv after the command: the hardcoded required args (always, for metering)
 * + the profile's `args` (extras appended on top — ADR-0158) + `--model <model>` when set
 * + the prompt.
 */
function buildRunArgs(profile: AiProfile, cmd: string, prompt: string): string[] {
  const extras = profile.args ?? [];
  const model = profile.model?.trim();
  const modelArgs = model ? ["--model", model] : [];
  return [...requiredArgs(cmd), ...extras, ...modelArgs, prompt];
}

/**
 * Candidate Claude home dirs (where `.credentials.json` lives) for reading the OAuth
 * usage snapshot (ADR-0072). Configured dirs first; falls back to the default `~/.claude`.
 */
export function claudeHomeDirs(config: AiCliConfig): string[] {
  const dirs = profileDirs(claudeProfilesOf(config));
  return dirs.length > 0 ? dirs : [join(homedir(), ".claude")];
}

/**
 * Human label for a profile dir: the signed-in **account email** when it can be read
 * from `<dir>/.claude.json` (`oauthAccount.emailAddress`), else the folder basename
 * (e.g. ".claude-1"). Best-effort — a missing/unreadable file or a non-claude profile
 * falls back to the folder name so the header is never blank.
 */
export function profileDisplayLabel(dir: string): string {
  try {
    const raw = JSON.parse(readFileSync(join(dir, ".claude.json"), "utf8")) as {
      oauthAccount?: { emailAddress?: string };
    };
    const email = raw.oauthAccount?.emailAddress;
    if (email && email.trim()) return email;
  } catch {
    // Best-effort — fall through to the folder name.
  }
  return basename(dir);
}

/** The env var a given AI CLI reads to pick its profile directory. */
export function profileEnvVar(cmd: string): string | null {
  if (cmd.includes("claude")) return "CLAUDE_CONFIG_DIR";
  if (cmd.includes("codex")) return "CODEX_HOME";
  return null;
}

/** The profile list configured for a given AI CLI (empty when none / unsupported). */
function profilesFor(config: AiCliConfig, cmd: string): AiProfile[] {
  const envVar = profileEnvVar(cmd);
  if (envVar === "CLAUDE_CONFIG_DIR") return config.claudeHome ?? [];
  if (envVar === "CODEX_HOME") return config.codexHome ?? [];
  return [];
}

/**
 * The configured profile labels (account email, else dir basename) for the active AI CLI
 * — for showing the current/available profile in the header. Empty when none configured.
 */
export function profileLabels(config: AiCliConfig): string[] {
  // Unified list ⇒ every provider's entries (mixed), preferring an explicit `label` (ADR-0182).
  if (isUnifiedConfig(config)) {
    return config
      .aiProfiles!.filter(isUsableCredential)
      .map((c) => c.label?.trim() || profileDisplayLabel(resolveHomePath(c.profile)));
  }
  const cmd = config.aiCli ?? DEFAULT_AI_CLI;
  return profileDirs(profilesFor(config, cmd)).map((dir) => profileDisplayLabel(dir));
}

/** A claude profile resolved for a direct run: its config dir + optional `--model`. */
export interface ResolvedClaudeProfile {
  /** CLAUDE_CONFIG_DIR selecting the signed-in account. */
  dir: string;
  /** The profile's `--model` (omitted/empty ⇒ the CLI's default model). */
  model?: string;
}

/**
 * Resolve the configured claude profiles to try (working-first, disabled/blank dropped — the
 * SAME selection as {@link planAiRun}), but WITHOUT baking a prompt into argv so the caller can
 * feed a large prompt over stdin (the support agent's grounded answer — ADR-0170). Empty list ⇒
 * no profile configured (the caller should fall back to the CLI's default env).
 */
export function resolveClaudeProfiles(
  config: AiCliConfig,
  workingDir: string | null,
): ResolvedClaudeProfile[] {
  const profiles = claudeProfilesOf(config)
    .filter(isUsableProfile)
    .map((p) => ({ dir: resolveHomePath(p.profile), model: p.model?.trim() || undefined }));
  // Working-first: move the last-known-good dir to the front when it is one of the candidates.
  const idx = workingDir ? profiles.findIndex((p) => p.dir === workingDir) : -1;
  if (idx > 0) profiles.unshift(profiles.splice(idx, 1)[0]!);
  return profiles;
}

/** Working-first hint fed to {@link planAiRun}: a legacy profile dir OR a unified credential key. */
export interface AiWorkingHint {
  /** Legacy per-`aiCli` working profile dir (moved to the front). */
  dir?: string | null;
  /** Unified working credential key (moved to the front — ADR-0182). */
  credential?: string | null;
}

/**
 * Build the run plan for a typed prompt. When the unified mixed list drives the run (ADR-0182)
 * the attempts span all providers in list order (a prompt can fail over claude→codex); otherwise
 * the legacy per-`aiCli` plan applies. Attempts are ordered working-first: the hinted credential
 * (unified) or dir (legacy) is moved to the front. No usable profile ⇒ a single "default" attempt
 * (the CLI's own default env).
 */
export function planAiRun(prompt: string, config: AiCliConfig, hint: AiWorkingHint = {}): AiPlan {
  return isUnifiedConfig(config)
    ? planUnifiedRun(prompt, config, hint.credential ?? null)
    : planLegacyRun(prompt, config, hint.dir ?? null);
}

/**
 * The unified mixed-list plan (ADR-0182): an ordered failover chain over `aiProfiles`. By default
 * it spans every provider (mixed), but a specific `aiCli` **scopes** the chain to that provider's
 * credentials — failover stays within the active CLI (ADR-0197); only "—" (blank) fails over
 * across providers.
 */
function planUnifiedRun(prompt: string, config: AiCliConfig, workingCredential: string | null): AiPlan {
  const baseEnv = config.aiEnv ?? {};
  // Scope to the pinned provider unless "—" (mixed) is selected (ADR-0197).
  const active = activeProvider(config);
  const usable = config.aiProfiles!.filter(isUsableCredential);
  const scoped = active ? usable.filter((c) => c.provider === active) : usable;
  // Pinned provider with no usable credential ⇒ a single default attempt on its own default env
  // (mirrors the legacy no-profile fallback in planLegacyRun — never silently spills to another CLI).
  if (active && scoped.length === 0) {
    return {
      cmd: active,
      attempts: [
        { cmd: active, label: "default", dir: null, key: null, args: buildRunArgs({ profile: "" }, active, prompt), env: { ...baseEnv } },
      ],
    };
  }
  const resolved = scoped.map((cred) => {
    const cmd = cred.provider;
    const dir = resolveHomePath(cred.profile);
    return { cred, cmd, dir, key: credentialKey(cmd, dir), envVar: profileEnvVar(cmd) };
  });
  // Working-first ordering: move the last-working credential to the front when it is a candidate.
  const ordered =
    workingCredential && resolved.some((r) => r.key === workingCredential)
      ? [
          resolved.find((r) => r.key === workingCredential)!,
          ...resolved.filter((r) => r.key !== workingCredential),
        ]
      : resolved;
  const attempts: AiAttempt[] = ordered.map(({ cred, cmd, dir, key, envVar }) => ({
    cmd,
    label: cred.label?.trim() || profileDisplayLabel(dir),
    dir,
    key,
    args: buildRunArgs(cred, cmd, prompt),
    env: envVar ? { ...baseEnv, [envVar]: dir } : { ...baseEnv },
  }));
  return { cmd: attempts[0]?.cmd ?? DEFAULT_AI_CLI, attempts };
}

/** The legacy single-provider plan (per `aiCli`) — unchanged behavior for pre-ADR-0182 configs. */
function planLegacyRun(prompt: string, config: AiCliConfig, workingDir: string | null): AiPlan {
  // `||` (not `??`): a blank aiCli ("mixed"/none — ADR-0182) falls back to claude here.
  const cmd = config.aiCli || DEFAULT_AI_CLI;
  const baseEnv = config.aiEnv ?? {};
  const envVar = profileEnvVar(cmd);
  const defaultPlan: AiPlan = {
    cmd,
    attempts: [
      { cmd, label: "default", dir: null, key: null, args: buildRunArgs({ profile: "" }, cmd, prompt), env: { ...baseEnv } },
    ],
  };
  if (!envVar) return defaultPlan;

  // Resolve each configured profile to its home dir (dropping blank/disabled entries — ADR-0180).
  const resolved = profilesFor(config, cmd)
    .filter(isUsableProfile)
    .map((p) => ({ profile: p, dir: resolveHomePath(p.profile) }));
  if (resolved.length === 0) return defaultPlan;

  // Working-first ordering.
  const ordered =
    workingDir && resolved.some((r) => r.dir === workingDir)
      ? [
          resolved.find((r) => r.dir === workingDir)!,
          ...resolved.filter((r) => r.dir !== workingDir),
        ]
      : resolved;
  const attempts: AiAttempt[] = ordered.map(({ profile, dir }) => ({
    cmd,
    label: profileDisplayLabel(dir),
    dir,
    key: credentialKey(cmd, dir),
    args: buildRunArgs(profile, cmd, prompt),
    env: { ...baseEnv, [envVar]: dir },
  }));
  return { cmd, attempts };
}
