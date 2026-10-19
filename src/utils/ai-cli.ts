/**
 * Plan how the TUI input box drives an AI CLI. The operator types a
 * natural-language prompt; by default it goes to `claude` (print mode) so the AI agent
 * itself decides whether to call `gh`/`glab`/`git`/etc. — no command whitelist.
 *
 * The credentials are ONE ordered mixed list (`aiProfiles`, each naming its provider): the
 * runner tries them in order until one authenticates, then remembers the working one
 * (working-first ordering here). Every profile's `args` are EXTRA pre-prompt args
 * appended AFTER the hardcoded required args — they can add options but never
 * strip the token-metering flags — plus an optional `model`. Pure helper.
 * @adr 0057 @adr 0158
 */
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { logger } from "../common/logger/logger";
import { denySettingsArgs } from "./agent-deny";
import { projectMcpArgs, strictMcpArgs } from "./agent-mcp";
import { readAgentFile } from "./agent-user";
import { effectiveCredentialDir } from "./ai-cred-mount";

/**
 * REQUIRED pre-prompt args per known AI CLI — **hardcoded in source and always
 * injected** so token metering can never be turned off by an operator's config edit.
 * Claude runs headless via `-p` and emits **stream-json** (needs `--verbose`) so the cli
 * renders text live AND reads the real token usage from the final `result` event; codex
 * runs `exec --json` for the same reason (its JSONL `turn.completed` carries usage —
 * ADR-0072). A profile's own `args` are appended as EXTRAS on top of these, never
 * replacing them. Antigravity has none yet (schema-only until its CLI is wired).
 * @adr 0138
 */
const REQUIRED_AI_ARGS: { claude: string[]; codex: string[]; antigravity: string[] } = {
  claude: ["-p", "--output-format", "stream-json", "--verbose"],
  codex: ["exec", "--json"],
  antigravity: [],
};

/**
 * Agentic tools disallowed for a one-shot AI run — a comma-separated single token so
 * claude's variadic `--disallowedTools <tools...>` consumes exactly this arg (a terminator flag
 * follows so it can't swallow the prompt). A text-in → text-out spec review/compose/suggest has no
 * reason to run these; blocking them stops the run from wandering the repo / editing files / looping.
 * @adr 0249
 */
export const ONE_SHOT_DISALLOWED_CLAUDE_TOOLS = [
  "Bash", "Edit", "Write", "Read", "Glob", "Grep", "NotebookEdit", "Task", "WebSearch", "WebFetch",
  "Skill", "ToolSearch", "TaskCreate", "TaskGet", "TaskList", "TaskOutput",
  "TaskStop", "TaskUpdate", "Monitor", "DesignSync", "CronCreate", "CronDelete", "CronList",
  "EnterWorktree", "ExitWorktree", "RemoteTrigger", "ScheduleWakeup", "SendMessage", "PushNotification",
].join(",");

/**
 * Fixed agentic turn cap for a one-shot AI run (AI suggest/review/compose). A small budget (>1) lets
 * the model take a couple of internal reasoning turns to produce a better single answer while still
 * bounding the loop; the run stays text-in → text-out because every agentic tool is disallowed.
 */
const ONE_SHOT_MAX_TURNS = 4;

/**
 * Extra pre-prompt args that make a claude run one-shot: a fixed `--max-turns`
 * ({@link ONE_SHOT_MAX_TURNS}, equals form so an older claude that doesn't know the flag treats it as
 * an ignored unknown option, NOT a stray positional) bounds the agentic loop; `--disallowedTools`
 * blocks the tools; and `--permission-mode default` is a NON-variadic terminator placed last so the
 * variadic `--disallowedTools` consumes only its tool token. The prompt no longer follows on argv (it
 * rides stdin), so the terminator's "shield the prompt" role is moot but the flag is still
 * a valid setting. Claude only — codex `exec` is already single-shot. Empty for a non-claude cmd.
 * @adr 0249 @adr 0251
 */
function oneShotArgs(cmd: string): string[] {
  if (!cmd.includes("claude")) return [];
  return [
    `--max-turns=${ONE_SHOT_MAX_TURNS}`,
    "--disallowedTools",
    ONE_SHOT_DISALLOWED_CLAUDE_TOOLS,
    "--permission-mode",
    "default",
  ];
}

/**
 * Tools disallowed for a **read-only agent** run — the write/orchestration tools only, as
 * one comma-separated token (same variadic-consumption trick as {@link ONE_SHOT_DISALLOWED_CLAUDE_TOOLS}).
 * Unlike one-shot this **keeps** `Read`/`Glob`/`Grep`/`Bash`/`ToolSearch` so the agent can inspect and
 * diff the repo; it only blocks anything that would modify files or spawn side-effecting work — a
 * read-only report (template "Analyze impact") must never edit/commit.
 * @adr 0265
 */
const READ_ONLY_DISALLOWED_CLAUDE_TOOLS = [
  "Edit", "Write", "NotebookEdit", "Task", "SlashCommand", "Skill", "WebSearch", "WebFetch",
  "TaskCreate", "TaskGet", "TaskList", "TaskOutput", "TaskStop", "TaskUpdate", "Monitor",
  "DesignSync", "CronCreate", "CronDelete", "CronList", "EnterWorktree", "ExitWorktree",
  "RemoteTrigger", "ScheduleWakeup", "SendMessage", "PushNotification",
].join(",");

/**
 * Fixed agentic turn cap for a read-only run — a whole-repo analysis (e.g. the template
 * "Analyze impact" report) must read many files over several turns before it can write the report, so
 * this is generous and NOT operator-tunable: a tiny per-profile cap would starve the run before it
 * ever produces output.
 * @adr 0265
 */
const READ_ONLY_MAX_TURNS = 40;

/**
 * Extra pre-prompt args that make a claude run a **read-only agent**: a fixed `--max-turns`
 * ({@link READ_ONLY_MAX_TURNS} — NOT 1, it must read many files over several turns); `--disallowedTools`
 * blocking only write/orchestration tools; and `--permission-mode plan` as the NON-variadic terminator
 * placed last (plan mode is read-only: the agent may Read/Glob/Grep and run read-only Bash to explore
 * but cannot edit files). For codex a read-only sandbox (`--sandbox read-only`) denies writes. Empty
 * for a non-claude/non-codex cmd.
 * @adr 0265
 */
function readOnlyArgs(cmd: string): string[] {
  if (cmd.includes("claude")) {
    return [
      `--max-turns=${READ_ONLY_MAX_TURNS}`,
      "--disallowedTools",
      READ_ONLY_DISALLOWED_CLAUDE_TOOLS,
      "--permission-mode",
      "plan",
    ];
  }
  if (cmd.includes("codex")) return ["--sandbox", "read-only"];
  return [];
}

/**
 * Extra pre-prompt args that make a claude run a **write-capable agent**: a full agent
 * that must run file + git/`gh`/`glab` writes **headless without an approval prompt** (the project-
 * template "Update" → branch + PR). `--permission-mode bypassPermissions` auto-approves every tool for
 * this run so it never stalls on an interactive approval a headless `-p` can't answer; it keeps ALL
 * tools (no `--disallowedTools`) and no turn cap (an update may take many turns). Still bounded by the
 * folder-scope guard + the wall-clock timeout. For codex a full-access run
 * (`--dangerously-bypass-approvals-and-sandbox`, best-effort). Empty for a non-claude/non-codex cmd.
 * @adr 0271 @adr 0181 @adr 0243
 */
function bypassArgs(cmd: string): string[] {
  if (cmd.includes("claude")) return ["--permission-mode", "bypassPermissions"];
  if (cmd.includes("codex")) return ["--dangerously-bypass-approvals-and-sandbox"];
  return [];
}

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
 * appended after the hardcoded required args — they cannot remove the required
 * metering flags (omitted ⇒ just the required args). `model` is passed as `--model <model>`
 * (omitted/empty ⇒ the CLI's own default model). `enabled` defaults true; a
 * profile with `enabled: false` is kept in config.json but excluded from the run plan (never
 * spawned; skipped by failover — ADR-0057 — and %session rotation).
 * @adr 0180 @adr 0081
 */
export interface AiProfile {
  profile: string;
  args?: string[];
  model?: string;
  enabled?: boolean;
  /** Optional managed `ANTHROPIC_API_KEY`; absent ⇒ OAuth via the profile dir. @adr 0378 */
  apiKey?: ApiKeyDescriptor;
}

/**
 * A profile's managed `ANTHROPIC_API_KEY` source. `inline` carries the key value (stored in
 * config.json — a secret); `ssm` / `secretsManager` carry only a reference the cli resolves at spawn
 * with the worker's own AWS credentials. Resolved just-in-time by `resolve-api-key.ts` and exported as
 * `ANTHROPIC_API_KEY` for that profile's spawn (so claude bills via the key — metering still parses the
 * stream-json `result`). Only claude uses it today.
 * @adr 0378
 */
export interface ApiKeyDescriptor {
  source: "inline" | "ssm" | "secretsManager";
  /** inline: the key value. */
  value?: string;
  /** ssm: the SSM Parameter Store parameter name. */
  name?: string;
  /** secretsManager: the secret id / ARN. */
  secretId?: string;
  /** ssm / secretsManager: the AWS region (else the worker's default). */
  region?: string;
  /** secretsManager: a key to read from a JSON secret. */
  jsonKey?: string;
}

/** The AI providers a credential can target — each maps to a CLI command + config-dir env var. */
export type AiProvider = "claude" | "codex" | "antigravity";

/** The known providers, for validating hand-edited config entries. */
const AI_PROVIDERS: readonly AiProvider[] = ["claude", "codex", "antigravity"];

/**
 * One entry in the unified, mixed credential list (`config.aiProfiles`): an AiProfile
 * plus the `provider` that selects which AI CLI it drives (command + hardcoded metering args +
 * `CLAUDE_CONFIG_DIR`/`CODEX_HOME`). The account/auth (OAuth **or** the user's own API key) is
 * configured by the user INSIDE the `profile` config dir — 4PM never stores a key. `label` is an
 * optional display name (falls back to the signed-in account email / the dir basename).
 * @adr 0182
 */
export interface AiCredential extends AiProfile {
  provider: AiProvider;
  label?: string;
}

/** A profile is usable when it has a non-blank dir and isn't explicitly disabled. @adr 0180 */
function isUsableProfile(p: AiProfile): boolean {
  return p.enabled !== false && Boolean(p.profile && p.profile.trim());
}

/** Resolved dirs already reported as duplicated — so the per-prompt plan warns once per dir. */
const warnedDuplicateDirs = new Set<string>();

/**
 * Keep the first entry per resolved profile dir and drop the rest: two profiles sharing a
 * dir are one account (same credential key / session state), so a duplicate only repeats a failover
 * attempt. Covers configs edited on the machine, which the web/server checks never see.
 * @adr 0409
 */
export function dropDuplicateDirs<T extends AiProfile>(profiles: T[]): T[] {
  const seen = new Set<string>();
  return profiles.filter((p) => {
    const dir = resolve(resolveHomePath(p.profile.trim()));
    if (!seen.has(dir)) {
      seen.add(dir);
      return true;
    }
    if (!warnedDuplicateDirs.has(dir)) {
      warnedDuplicateDirs.add(dir);
      logger.warn("ai.profile.duplicateDir", { dir });
    }
    return false;
  });
}

/** A credential is usable when it is a usable profile AND names a known provider. @adr 0182 */
export function isUsableCredential(c: AiCredential): boolean {
  return isUsableProfile(c) && AI_PROVIDERS.includes(c.provider);
}

/** Config knobs the planner reads (subset of ProfileConfig). */
export interface AiCliConfig {
  aiCli?: string;
  /**
   * The mixed credential list: one ordered, cross-provider failover chain. Empty ⇒ one default-env
   * attempt of the pinned (else default) CLI.
   * @adr 0182
   */
  aiProfiles?: AiCredential[];
  /**
   * Failover start policy: `"remember"` starts from the last-working credential;
   * `"priority"` always starts at the top of the list. Default `"remember"`.
   * @adr 0182
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
  /**
   * The argv after the command (required metering args + `--model` + one-shot caps) — **without**
   * the prompt: the prompt rides `stdin`, not a positional, so it can't exceed
   * `MAX_ARG_STRLEN`.
   * @adr 0251
   */
  args: string[];
  /** The prompt to feed on the child's stdin — `claude -p` / `codex exec` both read it. @adr 0251 */
  stdin: string;
  env: Record<string, string>;
  /**
   * The profile's managed API key descriptor, resolved + merged into env at spawn; omitted ⇒ OAuth.
   * @adr 0378
   */
  apiKey?: ApiKeyDescriptor;
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
 * Claude auth mode for metering: `api-key` when an `ANTHROPIC_API_KEY` is present
 * (in the profile's `aiEnv` or the cli process env — the API-billed path), else `subscription`
 * (OAuth account, metered from `.credentials.json`). Tags each usage report so billing
 * can split subscription vs API-key runs.
 * @adr 0192 §5 @adr 0072
 */
export function resolveClaudeAuthMode(config: AiCliConfig): "subscription" | "api-key" {
  const key = config.aiEnv?.["ANTHROPIC_API_KEY"] ?? process.env.ANTHROPIC_API_KEY;
  return key && key.trim() ? "api-key" : "subscription";
}

/** The usable credentials of the list, config order. */
function usableCredentials(config: AiCliConfig): AiCredential[] {
  return (config.aiProfiles ?? []).filter(isUsableCredential);
}

/**
 * The provider the operator pinned via `aiCli`. When it names a known provider the unified run
 * is **scoped** to that provider's credentials — failover stays within the
 * active CLI; a blank/"—"/unknown value ⇒ null = **mixed** (fail over across the whole list).
 * @adr 0182 @adr 0197
 */
export function activeProvider(config: AiCliConfig): AiProvider | null {
  const v = config.aiCli?.trim();
  return v && (AI_PROVIDERS as readonly string[]).includes(v) ? (v as AiProvider) : null;
}

/**
 * AI providers this worker can run: those with a usable entry in the list; with none, the pinned
 * `aiCli` (else the default `claude`) on its default home. Drives the marketplace's not-enabled-provider
 * warning.
 * @adr 0460
 */
export function enabledAiProviders(config: AiCliConfig): AiProvider[] {
  const out = new Set<AiProvider>(usableCredentials(config).map((c) => c.provider));
  if (out.size) return [...out];
  const pinned = activeProvider(config);
  if (pinned) out.add(pinned);
  if (out.size === 0) out.add(DEFAULT_AI_CLI as AiProvider);
  return [...out];
}

/**
 * The claude entries of the list for the OAuth-only paths (usage snapshot, %session rotation,
 * support answer).
 */
function claudeProfilesOf(config: AiCliConfig): AiProfile[] {
  return (config.aiProfiles ?? []).filter((c) => c.provider === "claude");
}

/** Ordered credential keys of the usable claude entries (for unified %session rotation). */
export function claudeCredentialKeys(config: AiCliConfig): string[] {
  return claudeProfilesOf(config)
    .filter(isUsableProfile)
    .map((p) => credentialKey("claude", resolveHomePath(p.profile)));
}

/**
 * Resolve a profile (credential) dir path: absolute stays as-is; "~/x" and a bare name (e.g.
 * ".claude-1") resolve under $HOME. Under uid separation a host-mounted login (`~/ai-creds/…`) resolves
 * to its imported copy, so every consumer — runs, labels, keys, deny rules — sees one dir.
 * @adr 0433
 */
export function resolveHomePath(value: string): string {
  if (value.startsWith("~")) return effectiveCredentialDir(join(homedir(), value.slice(1).replace(/^[/\\]/, "")));
  if (isAbsolute(value)) return effectiveCredentialDir(value);
  return effectiveCredentialDir(join(homedir(), value));
}

/** Normalize a profile list into a resolved dir list (dropping blank/disabled entries). */
function profileDirs(profiles: AiProfile[] | undefined): string[] {
  if (!profiles) return [];
  return profiles.filter(isUsableProfile).map((p) => resolveHomePath(p.profile));
}

/**
 * Every configured AI credential dir (all providers) — the dirs whose contents an agent run must never
 * read or edit (ADR-0347 deny rules).
 */
export function allAiProfileDirs(config: AiCliConfig): string[] {
  return [...new Set(profileDirs(config.aiProfiles))];
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
 * Per-run AI execution override — the few knobs the web "AI settings" modal can layer
 * over a profile for one dispatch (per-user, chosen in the browser). Structurally mirrors `@4pm/dto`
 * `AiRunConfig`; kept local so this pure helper stays framework/dep-free. Every field optional —
 * an unset field ⇒ the profile default. Provider mapping is best-effort (see {@link overrideArgs} /
 * {@link overrideEnv}); a knob a provider can't express is ignored so the run still proceeds.
 * @adr 0261
 */
export interface AiRunOverride {
  /** `--model` override (both providers) — wins over the profile's `model`. */
  model?: string;
  /** Coarse reasoning-budget level: claude → `MAX_THINKING_TOKENS` env; codex → reasoning-effort. */
  thinking?: "off" | "low" | "medium" | "high";
  /** Sampling temperature 0..1 — codex only (`-c model_temperature`); ignored for claude. */
  temperature?: number;
}

/** Thinking level → claude `MAX_THINKING_TOKENS` budget. `off`/absent ⇒ no env. @adr 0261 */
const THINKING_TOKENS: Record<string, number> = { low: 4000, medium: 10000, high: 31999 };

/**
 * Provider-specific pre-prompt args contributed by a per-run override. Codex takes its
 * reasoning effort + temperature as `-c key=value` config overrides; claude expresses thinking via
 * env (see {@link overrideEnv}) and has no temperature knob, so it adds none here. Best-effort — an
 * unmapped knob is simply omitted. Pure.
 * @adr 0261
 */
function overrideArgs(cmd: string, o?: AiRunOverride): string[] {
  if (!o || !cmd.includes("codex")) return [];
  const args: string[] = [];
  if (o.thinking && o.thinking !== "off") args.push("-c", `model_reasoning_effort="${o.thinking}"`);
  if (typeof o.temperature === "number") args.push("-c", `model_temperature=${o.temperature}`);
  return args;
}

/**
 * Extra env contributed by a per-run override — claude expresses its thinking budget via
 * `MAX_THINKING_TOKENS` (there is no print-mode flag). Merged into the attempt's env by the planner.
 * Non-claude / no thinking ⇒ empty. Pure.
 * @adr 0261
 */
export function overrideEnv(cmd: string, o?: AiRunOverride): Record<string, string> {
  if (!o || !cmd.includes("claude")) return {};
  if (!o.thinking || o.thinking === "off") return {};
  const budget = THINKING_TOKENS[o.thinking];
  return budget ? { MAX_THINKING_TOKENS: String(budget) } : {};
}

/**
 * Compose the argv after the command: the hardcoded required args (always, for metering)
 * + the profile's `args` (extras appended on top) + `--model <model>` when set
 * + per-run override args + one-shot caps when `oneShot` or read-only-agent
 * caps when `readOnly` (ADR-0265; `plan` mode + write-tool disallow, read tools kept). The prompt is
 * **not** appended: it rides the child's stdin, so it can't exceed `MAX_ARG_STRLEN`
 * (`claude -p` / `codex exec` read stdin when no positional prompt is given). The one-shot args stay
 * LAST — their non-variadic terminator (`--permission-mode default`) still bounds the variadic
 * `--disallowedTools`. A per-run `override.model` wins over the profile's `model`.
 * @adr 0261 @adr 0249 @adr 0251
 */
function buildRunArgs(
  profile: AiProfile,
  cmd: string,
  resumeId?: string,
  oneShot = false,
  override?: AiRunOverride,
  readOnly = false,
  bypass = false,
  denyDirs: string[] = [],
): string[] {
  const extras = profile.args ?? [];
  const model = override?.model?.trim() || profile.model?.trim();
  const modelArgs = model ? ["--model", model] : [];
  // Native session resume (ADR-0245) — claude only; resumes the prior conversation on the SAME
  // profile so the shared memory need not be re-injected. Non-claude / no id ⇒ a fresh session.
  const resumeArgs = resumeId && cmd.includes("claude") ? ["--resume", resumeId] : [];
  // Mode caps (mutually exclusive — ADR-0249/0265) each carry their OWN fixed `--max-turns`: one-shot
  // (no tools, a small fixed budget) ⇒ read-only agent (read tools kept, plan mode, a generous fixed
  // cap) ⇒ else a normal run with no turn cap. The turn budget is no longer per-profile configurable
  // (a tiny cap silently starved read-only analysis runs before they could produce a report).
  const modeExtra = oneShot
    ? oneShotArgs(cmd)
    : readOnly
      ? readOnlyArgs(cmd)
      : bypass
        ? bypassArgs(cmd)
        : [];
  return [
    ...requiredArgs(cmd),
    ...resumeArgs,
    ...extras,
    ...modelArgs,
    ...overrideArgs(cmd, override),
    // MCP allowlist (ADR-0427): every run is `--strict-mcp-config`; only a full-agent run (not one-shot /
    // read-only) gets the approved servers' generated `--mcp-config` — variadic, so the single-value
    // `--settings` below terminates it.
    ...(oneShot || readOnly ? strictMcpArgs(cmd) : projectMcpArgs(cmd)),
    // Secret-path deny rules (ADR-0347) — every configured credential dir + ~/.4pm, ~/.ssh, gh, git
    // credentials, ~/.claude*. A single-value flag, placed before the mode caps so their non-variadic
    // terminator still bounds `--disallowedTools`.
    ...denySettingsArgs(cmd, denyDirs),
    ...modeExtra,
  ];
}

/**
 * Candidate Claude home dirs (where `.credentials.json` lives) for reading the OAuth
 * usage snapshot. Configured dirs first; falls back to the default `~/.claude`.
 * @adr 0072
 */
export function claudeHomeDirs(config: AiCliConfig): string[] {
  const dirs = profileDirs(claudeProfilesOf(config));
  return dirs.length > 0 ? dirs : [join(homedir(), ".claude")];
}

/**
 * Reads the worker's current AI config while account labels are masked; null ⇒ unmasked.
 * Read at label time so the `#N` numbering follows live config edits.
 * @adr 0395
 */
let maskConfigReader: (() => AiCliConfig) | null = null;

/**
 * Turn AI account label masking on (with a reader of the current config) or off (null) — ADR-0395.
 * Set from `ws_token.maskAiAccounts` (mirrored in `config.json`) on a platform-pool (rented) worker.
 */
export function setAiAccountMask(readConfig: (() => AiCliConfig) | null): void {
  maskConfigReader = readConfig;
}

/** True while AI account labels are masked. @adr 0395 */
export function isAiAccountMaskOn(): boolean {
  return maskConfigReader !== null;
}

/**
 * The masked label of a credential dir: `AI account #N`, where N is the dir's 1-based
 * position among the configured credential dirs (all providers, config order); plain `AI account`
 * when the dir isn't configured (or the config can't be read).
 * @adr 0395
 */
function maskedAccountLabel(dir: string): string {
  try {
    const index = maskConfigReader ? allAiProfileDirs(maskConfigReader()).indexOf(dir) : -1;
    return index >= 0 ? `AI account #${index + 1}` : "AI account";
  } catch {
    return "AI account";
  }
}

/**
 * The real (unmasked) label of a profile dir: the account email, else the folder basename.
 * Only for admin-only surfaces (`machine.status.aiAccounts`).
 * @adr 0354
 */
function unmaskedProfileLabel(dir: string): string {
  return profileAccountEmail(dir) ?? basename(dir);
}

/**
 * Human label for a profile dir: the signed-in **account email** when it can be read
 * from `<dir>/.claude.json` (`oauthAccount.emailAddress`), else the folder basename
 * (e.g. ".claude-1"). Best-effort — a missing/unreadable file or a non-claude profile
 * falls back to the folder name so the header is never blank. Masked to `AI account #N`
 * on a platform-pool (rented) worker.
 * @adr 0395
 */
export function profileDisplayLabel(dir: string): string {
  return maskConfigReader ? maskedAccountLabel(dir) : unmaskedProfileLabel(dir);
}

/**
 * Display label for a configured credential: its explicit `label`, else {@link profileDisplayLabel}.
 * While masked the explicit label is hidden too — an operator may have typed an email there.
 * @adr 0395
 */
export function credentialDisplayLabel(label: string | undefined, dir: string): string {
  const explicit = label?.trim();
  return explicit && !maskConfigReader ? explicit : profileDisplayLabel(dir);
}

/** Last account email read per `.claude.json`, keyed by its mtime (the read may spawn). @adr 0430 */
const accountEmailCache = new Map<string, { mtimeMs: number; email: string | null }>();

/**
 * The signed-in account email of a claude profile dir (`<dir>/.claude.json`
 * `oauthAccount.emailAddress`), or null when missing/unreadable (or not a claude profile).
 * Under uid separation the file is the agent's (`0600`) and is read through the agent (ADR-0430
 * phase 3); the result is cached until the file changes.
 */
export function profileAccountEmail(dir: string): string | null {
  const file = join(dir, ".claude.json");
  try {
    const { mtimeMs } = statSync(file);
    const cached = accountEmailCache.get(file);
    if (cached && cached.mtimeMs === mtimeMs) return cached.email;
    const raw = JSON.parse(readAgentFile(file)) as {
      oauthAccount?: { emailAddress?: string };
    };
    const email = raw.oauthAccount?.emailAddress?.trim() || null;
    accountEmailCache.set(file, { mtimeMs, email });
    return email;
  } catch {
    // Best-effort — no readable account.
    return null;
  }
}

/**
 * The AI accounts this cli is configured with, reported to the server in `machine.status`:
 * every usable credential across all providers — the account email when readable,
 * else the credential's explicit `label`, else the folder name. De-duplicated, config order.
 * @adr 0354
 */
export function aiAccountLabels(config: AiCliConfig): string[] {
  const labels = usableCredentials(config).map((c) => {
    const dir = resolveHomePath(c.profile);
    return profileAccountEmail(dir) ?? (c.label?.trim() || basename(dir));
  });
  return [...new Set(labels)];
}

/** The env var a given AI CLI reads to pick its profile directory. */
export function profileEnvVar(cmd: string): string | null {
  if (cmd.includes("claude")) return "CLAUDE_CONFIG_DIR";
  if (cmd.includes("codex")) return "CODEX_HOME";
  return null;
}

/**
 * The configured profile labels (account email, else dir basename) for the active AI CLI
 * — for showing the current/available profile in the header. Empty when none configured.
 */
export function profileLabels(config: AiCliConfig): string[] {
  // Every provider's entries (mixed), preferring an explicit `label` (ADR-0182).
  return usableCredentials(config).map((c) => credentialDisplayLabel(c.label, resolveHomePath(c.profile)));
}

/** Working-first hint fed to {@link planAiRun}: the working credential key. */
export interface AiWorkingHint {
  /** The working credential key (moved to the front). @adr 0182 */
  credential?: string | null;
}

/**
 * Build the run plan for a typed prompt: the attempts span the list in order (a prompt can fail over
 * claude→codex), working-first (the hinted credential moves to the front). No usable credential ⇒ a
 * single "default" attempt (the CLI's own default env).
 * @adr 0182
 */
export function planAiRun(
  prompt: string,
  config: AiCliConfig,
  hint: AiWorkingHint = {},
  resume: Map<string, string> = new Map(),
  oneShot = false,
  override?: AiRunOverride,
  readOnly = false,
  bypass = false,
): AiPlan {
  return planListRun(prompt, config, hint.credential ?? null, resume, oneShot, override, readOnly, bypass);
}

/**
 * The list plan: an ordered failover chain over `aiProfiles`. By default
 * it spans every provider (mixed), but a specific `aiCli` **scopes** the chain to that provider's
 * credentials — failover stays within the active CLI; only "—" (blank) fails over
 * across providers.
 * @adr 0182 @adr 0197
 */
function planListRun(
  prompt: string,
  config: AiCliConfig,
  workingCredential: string | null,
  resume: Map<string, string>,
  oneShot: boolean,
  override?: AiRunOverride,
  readOnly = false,
  bypass = false,
): AiPlan {
  const baseEnv = config.aiEnv ?? {};
  // Scope to the pinned provider unless "—" (mixed) is selected.
  const active = activeProvider(config);
  // Duplicate dirs collapse to the first entry across all providers, before scoping (ADR-0409).
  const usable = dropDuplicateDirs(usableCredentials(config));
  const scoped = active ? usable.filter((c) => c.provider === active) : usable;
  // No usable credential (for the pinned provider) ⇒ a single default attempt on its own default env —
  // never silently spills to another CLI.
  if (scoped.length === 0) {
    const cmd = active ?? DEFAULT_AI_CLI;
    return {
      cmd,
      attempts: [
        { cmd, label: "default", dir: null, key: null, args: buildRunArgs({ profile: "" }, cmd, undefined, oneShot, override, readOnly, bypass, allAiProfileDirs(config)), stdin: prompt, env: { ...baseEnv, ...overrideEnv(cmd, override) } },
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
    label: credentialDisplayLabel(cred.label, dir),
    dir,
    key,
    args: buildRunArgs(cred, cmd, resume.get(key), oneShot, override, readOnly, bypass, [...allAiProfileDirs(config), dir]),
    stdin: prompt,
    env: envVar
      ? { ...baseEnv, [envVar]: dir, ...overrideEnv(cmd, override) }
      : { ...baseEnv, ...overrideEnv(cmd, override) },
    ...(cred.apiKey ? { apiKey: cred.apiKey } : {}),
  }));
  return { cmd: attempts[0]?.cmd ?? DEFAULT_AI_CLI, attempts };
}

/**
 * The provider args of a restricted (non-dispatch) runner — support answer, research, FAQ compose,
 * memory compaction. `args(cmd)` returns what follows the common prefix (required metering args ·
 * `--model` · strict MCP · secret-path deny settings) for that provider, or `null` when the runner
 * cannot run on it (the attempt is dropped).
 * @adr 0520
 */
export interface AiRunPolicy {
  args(cmd: string): string[] | null;
}

/**
 * Plan a restricted runner's prompt over the SAME credentials and order as {@link planAiRun} (disabled /
 * duplicate dirs dropped, the active-provider scope, working-first hint) with the
 * runner's policy args instead of the dispatch modes. The profile's free-form `args` are not applied.
 * No attempt left ⇒ one default-env claude attempt (the CLI's own config), as before.
 * @adr 0520
 */
export function planPolicyRun(
  prompt: string,
  config: AiCliConfig,
  hint: AiWorkingHint,
  policy: AiRunPolicy,
): AiPlan {
  const baseEnv = config.aiEnv ?? {};
  const allDirs = allAiProfileDirs(config);
  /** One attempt on `cmd` / `dir` (null = the CLI's default env), or null when the policy refuses it. */
  const build = (
    cmd: string,
    dir: string | null,
    label: string,
    model: string | undefined,
    apiKey: ApiKeyDescriptor | undefined,
  ): AiAttempt | null => {
    const extra = policy.args(cmd);
    if (extra === null) return null;
    const envVar = profileEnvVar(cmd);
    return {
      cmd,
      label,
      dir,
      key: dir ? credentialKey(cmd, dir) : null,
      args: [
        ...requiredArgs(cmd),
        ...(model?.trim() ? ["--model", model.trim()] : []),
        ...strictMcpArgs(cmd),
        ...denySettingsArgs(cmd, dir ? [...allDirs, dir] : allDirs),
        ...extra,
      ],
      stdin: prompt,
      env: dir && envVar ? { ...baseEnv, [envVar]: dir } : { ...baseEnv },
      ...(apiKey ? { apiKey } : {}),
    };
  };
  const active = activeProvider(config);
  const candidates = dropDuplicateDirs(usableCredentials(config))
    .filter((c) => !active || c.provider === active)
    .map((c) => {
      const dir = resolveHomePath(c.profile);
      return { cmd: c.provider as string, dir, label: credentialDisplayLabel(c.label, dir), model: c.model, apiKey: c.apiKey };
    });
  // Working-first: the hinted credential moves to the front.
  const head = hint.credential ? candidates.findIndex((c) => credentialKey(c.cmd, c.dir) === hint.credential) : -1;
  if (head > 0) candidates.unshift(candidates.splice(head, 1)[0]!);
  const attempts = candidates
    .map((c) => build(c.cmd, c.dir, c.label, c.model, c.apiKey))
    .filter((a): a is AiAttempt => a !== null);
  if (attempts.length === 0) {
    const fallback = build(DEFAULT_AI_CLI, null, "default", undefined, undefined);
    if (fallback) attempts.push(fallback);
  }
  return { cmd: attempts[0]?.cmd ?? DEFAULT_AI_CLI, attempts };
}
