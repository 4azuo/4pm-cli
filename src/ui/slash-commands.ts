/**
 * Slash commands for the TUI (ADR-0057): lines starting with `/` are intercepted by
 * the input box and handled locally (NOT sent to the AI CLI) — check version, view /
 * init / update the profile config, clear the transcript, quit. Extensible registry:
 * add a SlashCommand to COMMANDS.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  defaultProfileConfig,
  deleteProfileConfigKey,
  overwriteProfileConfig,
  readProfileConfig,
  writeProfileConfig,
  type ProfileConfig,
} from "../config/profile";
import { getCommandHistory } from "../core/command-history";
import { readCommandOutput } from "../core/command-output-store";
import {
  clearPinnedCredential,
  getPinnedCredential,
  getWorkingCredential,
  setPinnedCredential,
} from "../core/ai-profile-state";
import {
  credentialKey,
  isUsableCredential,
  labelFromCredentialKey,
  profileDisplayLabel,
  resolveHomePath,
  type AiCredential,
} from "../utils/ai-cli";
import { readRecentLogLines } from "../common/logger/logger";
import type { SessionInfo } from "./session-info";
import { t, type CliMessageKey } from "../i18n";

/** Live session state passed from the App (for /status). */
export interface SlashLiveState {
  status: string;
  scope: string;
  worker: string | null;
  project: string | null;
  activeProfile: string | null;
  /** Session start (ms) — for uptime. */
  startedAt: number;
}

/** Config keys the operator may set/delete via /config. */
const CONFIG_KEYS = [
  "aiCli",
  "claudeHome",
  "codexHome",
  "antigravityHome",
  "physicPath",
  "commandHistoryUploadMinutes",
  "autoUpdate",
  "aiEnv",
] as const satisfies readonly (keyof ProfileConfig)[];

/** Context handed to a slash command's run(). */
export interface SlashContext {
  /** Args after the command name (whitespace-split). */
  args: string[];
  /** Print one output line into the transcript. */
  print: (text: string, level?: "info" | "warn" | "error") => void;
  /** Clear the transcript. */
  clear: () => void;
  /** Quit the cli. */
  quit: () => void;
  /** Ask a yes/no question; `onYes` runs if the next input line is y/yes — for /config init. */
  confirm: (prompt: string, onYes: () => void) => void;
  /** Forward text to the AI CLI (as if typed as a prompt) — for /claude-cmd. */
  submitAi: (input: string) => void;
  /** Force an immediate reconnect — for /reconnect. */
  reconnect: () => void;
  /** Update the header's active-AI-profile label — for /ai-profile use/reset (ADR-0250). */
  setActiveProfile: (label: string | null) => void;
  /** Toggle a fold's expansion (ADR-0108); `n` defaults to the newest fold — for /expand. */
  expand: (n?: number) => void;
  /** Collapse a fold (ADR-0108); `n` defaults to the newest fold — for /collapse. */
  collapse: (n?: number) => void;
  /** Highest fold number currently on screen (0 = none) — bounds /expand·/collapse. */
  maxBlock: number;
  /** Live session state for /status. */
  live: SlashLiveState;
  info: SessionInfo;
}

/** One slash command. */
interface SlashCommand {
  name: string;
  usage: string;
  description: string;
  run: (ctx: SlashContext) => void;
}

/** Path to the profile's config.json. */
function configPath(profileDir: string): string {
  return join(profileDir, "config.json");
}

/** Parse a `/config set <key> <value…>` assignment into a ProfileConfig patch. */
function parseConfigAssignment(
  key: string,
  valueTokens: string[],
): { patch: ProfileConfig } | { error: string } {
  const value = valueTokens.join(" ").trim();
  switch (key) {
    case "aiCli":
    case "physicPath":
      if (!value) return { error: t("slash.config.missingValue", { key }) };
      return { patch: { [key]: value } };
    case "claudeHome":
    case "codexHome":
    case "antigravityHome": {
      // Space-separated profile dirs → `{ profile, model:"" }` objects (failover order —
      // ADR-0057). `args`/`model` per profile are set by editing config.json directly.
      const dirs = valueTokens.filter((t) => t.trim());
      if (dirs.length === 0) return { error: t("slash.config.missingValue", { key }) };
      return { patch: { [key]: dirs.map((profile) => ({ profile, model: "" })) } };
    }
    case "commandHistoryUploadMinutes": {
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0) return { error: t("slash.config.notPositive", { value }) };
      return { patch: { commandHistoryUploadMinutes: n } };
    }
    case "autoUpdate":
      if (value !== "true" && value !== "false") return { error: t("slash.config.useTrueFalse", { value }) };
      return { patch: { autoUpdate: value === "true" } };
    case "aiEnv":
      try {
        return { patch: { aiEnv: JSON.parse(value) as Record<string, string> } };
      } catch {
        return { error: t("slash.config.aiEnvJson") };
      }
    default:
      return { error: t("slash.config.unknownKey", { key, keys: CONFIG_KEYS.join(", ") }) };
  }
}

/** Handle the `/config` command and its subcommands (show | init | set). */
function runConfig(ctx: SlashContext): void {
  const [sub, ...rest] = ctx.args;
  const dir = ctx.info.profileDir;
  const path = configPath(dir);

  if (!sub || sub === "show") {
    ctx.print(t("slash.config.path", { path }));
    const json = JSON.stringify(readProfileConfig(dir), null, 2);
    for (const line of json.split("\n")) ctx.print(line);
    return;
  }
  if (sub === "init") {
    const writeDefaults = (verb: string): void => {
      overwriteProfileConfig(dir, defaultProfileConfig());
      ctx.print(t("slash.config.wroteDefault", { verb, path }));
      ctx.print(t("slash.config.addClaudeHint"));
    };
    if (existsSync(path)) {
      // Ask before clobbering an existing config; the replace is a full overwrite.
      ctx.confirm(t("slash.config.replaceConfirm", { path }), () =>
        writeDefaults(t("slash.config.verbReplaced")),
      );
      return;
    }
    writeDefaults(t("slash.config.verbWrote"));
    return;
  }
  if (sub === "set") {
    const [key, ...valueTokens] = rest;
    if (!key) {
      ctx.print(t("slash.config.usageSet"), "error");
      return;
    }
    const result = parseConfigAssignment(key, valueTokens);
    if ("error" in result) {
      ctx.print(result.error, "error");
      return;
    }
    const merged = writeProfileConfig(dir, result.patch);
    ctx.print(t("slash.config.setOk", { key, value: JSON.stringify((merged as Record<string, unknown>)[key]) }));
    return;
  }
  if (sub === "delete" || sub === "unset") {
    const key = rest[0];
    if (!key) {
      ctx.print(t("slash.config.usageDelete"), "error");
      return;
    }
    if (!(CONFIG_KEYS as readonly string[]).includes(key)) {
      ctx.print(t("slash.config.unknownKey", { key, keys: CONFIG_KEYS.join(", ") }), "error");
      return;
    }
    deleteProfileConfigKey(dir, key as keyof ProfileConfig);
    ctx.print(t("slash.config.deletedKey", { key }));
    return;
  }
  ctx.print(t("slash.config.unknownSub", { sub: sub ?? "" }), "error");
}

/** Format a duration (seconds) as e.g. "1h 05m 09s". */
function fmtDuration(totalSec: number): string {
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n: number): string => String(n).padStart(2, "0");
  return h > 0 ? `${h}h ${pad(m)}m ${pad(s)}s` : `${m}m ${pad(s)}s`;
}

/** Format an executed command entry as one line. */
function commandLine(cmd: string, args: string[]): string {
  return `${cmd} ${args.join(" ")}`.trim();
}

/** /history [N] — list the last N executed commands (newest first) with timestamps. */
function runHistory(ctx: SlashContext): void {
  const n = Math.max(1, Math.min(50, Number(ctx.args[0]) || 15));
  const all = getCommandHistory();
  if (all.length === 0) {
    ctx.print(t("slash.history.none"));
    return;
  }
  const recent = all.slice(-n).reverse();
  ctx.print(t("slash.history.header", { n: recent.length, total: all.length }));
  recent.forEach((e, i) => {
    const time = new Date(e.startedAt).toLocaleTimeString();
    const state =
      e.status === "done" ? "✓" : e.status === "failed" ? `✗ exit ${e.exitCode}` : t("slash.history.running");
    ctx.print(`  [${i + 1}] ${time}  ${commandLine(e.cmd, e.args)}  · ${state}`);
  });
}

/** /output <n> — replay the captured output of the nth command from /history. */
function runOutput(ctx: SlashContext): void {
  const all = getCommandHistory();
  const n = Number(ctx.args[0]);
  if (!Number.isInteger(n) || n < 1 || n > all.length) {
    ctx.print(t("slash.output.usage"), "error");
    return;
  }
  const entry = all.slice().reverse()[n - 1]!;
  const state = entry.exitCode != null ? ` (exit ${entry.exitCode})` : "";
  ctx.print(t("slash.output.header", { n, cmd: commandLine(entry.cmd, entry.args), status: entry.status, state }));
  const out = readCommandOutput(entry.commandId);
  if (out == null) {
    ctx.print(t("slash.output.none"), "warn");
    return;
  }
  for (const line of out.replace(/\n$/, "").split("\n")) ctx.print(line);
}

/** /logs [N] — tail the profile's structured log (ADR-0054). */
function runLogs(ctx: SlashContext): void {
  const n = Math.max(1, Math.min(200, Number(ctx.args[0]) || 20));
  const dir = join(ctx.info.profileDir, "logs");
  const lines = readRecentLogLines(dir, n);
  if (lines.length === 0) {
    ctx.print(t("slash.logs.none"));
    return;
  }
  ctx.print(t("slash.logs.header", { n: lines.length, dir }));
  for (const raw of lines) {
    try {
      const j = JSON.parse(raw) as Record<string, unknown>;
      const time = String(j.timestamp ?? "").slice(11, 19);
      const level = String(j.level ?? "").padEnd(5);
      const { timestamp, level: _l, version, profile, scope, event, ...fields } = j;
      void timestamp;
      void _l;
      void version;
      void profile;
      void scope;
      const extra = Object.keys(fields).length ? " " + JSON.stringify(fields) : "";
      ctx.print(`  ${time} ${level} ${String(event ?? "")}${extra}`);
    } catch {
      ctx.print(`  ${raw}`);
    }
  }
}

/** /whoami — fetch + show this cli's account + its teams & projects (async). */
function runWhoami(ctx: SlashContext): void {
  ctx.print(t("slash.whoami.fetching"));
  void ctx.info.whoami().then((w) => {
    if (!w) {
      ctx.print(t("slash.whoami.unavailable"), "warn");
      return;
    }
    ctx.print(t("slash.whoami.account", { username: w.username, scope: w.scope, roles: w.roles.join(", ") || t("slash.common.dash") }));
    ctx.print(t("slash.whoami.teams", { teams: w.teams.length ? w.teams.map((team) => team.name).join(", ") : t("slash.common.none") }));
    ctx.print(t("slash.whoami.projects", { projects: w.projects.length ? w.projects.map((p) => p.name).join(", ") : t("slash.common.none") }));
  });
}

/** Display label for a unified credential entry (its `label`, else the account email / dir name). */
function aiProfileLabel(c: AiCredential): string {
  return c.label?.trim() || profileDisplayLabel(resolveHomePath(c.profile));
}

/**
 * /ai-profile [list | use <n> | reset] — view the worker's AI credential profiles (ADR-0182) and
 * switch which one runs (ADR-0250). `use <n>` PINS entry `n`: it is tried first on every prompt
 * (overriding aiFailoverMode), with failover to the rest kept as a backup; `reset` returns to
 * automatic failover. Operates on the unified mixed list (`config.aiProfiles`); a legacy
 * per-provider config has nothing to switch here.
 */
function runAiProfile(ctx: SlashContext): void {
  const dir = ctx.info.profileDir;
  const config = readProfileConfig(dir);
  const list = Array.isArray(config.aiProfiles) ? config.aiProfiles : [];
  const [sub, ...rest] = ctx.args;
  const action = (sub ?? "list").toLowerCase();

  if (action === "list") {
    if (list.length === 0) {
      ctx.print(t("slash.aiProfile.none"), "warn");
      ctx.print(t("slash.aiProfile.legacyHint"));
      return;
    }
    const pinned = getPinnedCredential(dir);
    const working = getWorkingCredential(dir);
    ctx.print(t("slash.aiProfile.listHeader"));
    list.forEach((c, i) => {
      const usable = isUsableCredential(c);
      const key = usable ? credentialKey(c.provider, resolveHomePath(c.profile)) : null;
      const flags: string[] = [];
      if (key && key === pinned) flags.push(t("slash.aiProfile.flagPinned"));
      // "active" = the profile that last authenticated (the header) — hidden while a pin overrides it.
      else if (key && !pinned && key === working) flags.push(t("slash.aiProfile.flagActive"));
      if (c.enabled === false) flags.push(t("slash.aiProfile.flagDisabled"));
      const model = c.model?.trim() ? ` · model=${c.model.trim()}` : "";
      const flagStr = flags.length ? `  (${flags.join(", ")})` : "";
      const marker = key && key === pinned ? "*" : " ";
      ctx.print(`  ${marker}[${i + 1}] ${c.provider.padEnd(11)} ${aiProfileLabel(c)}${model}${flagStr}`);
    });
    if (pinned) {
      ctx.print(t("slash.aiProfile.pinnedNote"));
    }
    return;
  }

  if (action === "reset" || action === "auto" || action === "clear") {
    clearPinnedCredential(dir);
    ctx.print(t("slash.aiProfile.resetOk"));
    // Header reverts to the last-remembered working profile (or blank until the next run).
    const working = getWorkingCredential(dir);
    ctx.setActiveProfile(working ? labelFromCredentialKey(working) : null);
    return;
  }

  if (action === "use" || action === "switch") {
    const n = Number(rest[0]);
    if (!Number.isInteger(n) || n < 1 || n > list.length) {
      ctx.print(t("slash.aiProfile.usageUse", { max: list.length || "?" }), "error");
      return;
    }
    const cred = list[n - 1]!;
    if (!isUsableCredential(cred)) {
      const why = cred.enabled === false ? t("slash.aiProfile.whyDisabled") : t("slash.aiProfile.whyNoProfile");
      ctx.print(t("slash.aiProfile.cantUse", { n, label: aiProfileLabel(cred), why }), "error");
      return;
    }
    const credDir = resolveHomePath(cred.profile);
    setPinnedCredential(dir, credentialKey(cred.provider, credDir));
    // Header uses the same label a run would show (account email / dir basename — see ws-client's
    // post-run setActiveProfile) so switching doesn't flicker to a different name after the next run.
    ctx.setActiveProfile(profileDisplayLabel(credDir));
    ctx.print(
      t("slash.aiProfile.switchedOk", { provider: cred.provider, label: aiProfileLabel(cred) }),
    );
    return;
  }

  ctx.print(t("slash.aiProfile.unknownSub", { sub: sub ?? "" }), "error");
}

/** /expand [N] · /collapse [N] — toggle/fold a numbered `▸[N]` block (ADR-0108). */
function runFold(ctx: SlashContext, action: "expand" | "collapse"): void {
  if (ctx.maxBlock === 0) {
    ctx.print(t("slash.fold.none"), "warn");
    return;
  }
  const n = ctx.args[0] != null ? Number(ctx.args[0]) : ctx.maxBlock;
  if (!Number.isInteger(n) || n < 1 || n > ctx.maxBlock) {
    ctx.print(t("slash.fold.usage", { action, max: ctx.maxBlock }), "error");
    return;
  }
  if (action === "expand") ctx.expand(n);
  else ctx.collapse(n);
}

/** The command registry. */
const COMMANDS: SlashCommand[] = [
  {
    name: "help",
    usage: "/help",
    description: "slash.desc.help",
    run: (ctx) => {
      ctx.print(t("slash.help.header"));
      for (const cmd of COMMANDS) ctx.print(`  ${cmd.usage.padEnd(28)} ${t(cmd.description as CliMessageKey)}`);
    },
  },
  {
    name: "version",
    usage: "/version",
    description: "slash.desc.version",
    run: (ctx) => ctx.print(t("slash.version.line", { version: ctx.info.version, profile: ctx.info.profile })),
  },
  {
    name: "status",
    usage: "/status",
    description: "slash.desc.status",
    run: (ctx) => {
      const s = ctx.live;
      const uptime = fmtDuration(Math.max(0, Math.floor((Date.now() - s.startedAt) / 1000)));
      ctx.print(t("slash.status.connection", { status: s.status }));
      ctx.print(t("slash.status.scope", { scope: s.scope }));
      ctx.print(t("slash.status.worker", { worker: s.worker ?? t("slash.status.unknown") }));
      if (s.project) ctx.print(t("slash.status.project", { project: s.project }));
      ctx.print(t("slash.status.profile", { profile: ctx.info.profile }));
      ctx.print(t("slash.status.server", { server: ctx.info.serverUrl }));
      ctx.print(
        t("slash.status.aiCli", { aiCli: ctx.info.aiCli }) +
          (s.activeProfile ? t("slash.profileSuffix", { profile: s.activeProfile }) : ""),
      );
      ctx.print(t("slash.status.serving", { serving: ctx.info.physicPath ?? t("slash.common.none") }));
      ctx.print(t("slash.status.uptime", { uptime, count: getCommandHistory().length }));
    },
  },
  {
    name: "history",
    usage: "/history [N]",
    description: "slash.desc.history",
    run: runHistory,
  },
  {
    name: "output",
    usage: "/output <n>",
    description: "slash.desc.output",
    run: runOutput,
  },
  {
    name: "logs",
    usage: "/logs [N]",
    description: "slash.desc.logs",
    run: runLogs,
  },
  {
    name: "expand",
    usage: "/expand [N]",
    description: "slash.desc.expand",
    run: (ctx) => runFold(ctx, "expand"),
  },
  {
    name: "collapse",
    usage: "/collapse [N]",
    description: "slash.desc.collapse",
    run: (ctx) => runFold(ctx, "collapse"),
  },
  {
    name: "reconnect",
    usage: "/reconnect",
    description: "slash.desc.reconnect",
    run: (ctx) => ctx.reconnect(),
  },
  {
    name: "whoami",
    usage: "/whoami",
    description: "slash.desc.whoami",
    run: runWhoami,
  },
  {
    name: "ai-profile",
    usage: "/ai-profile [list|use <n>|reset]",
    description: "slash.desc.aiProfile",
    run: runAiProfile,
  },
  {
    name: "config",
    usage: "/config [show|init|set <k> <v>|delete <k>]",
    description: "slash.desc.config",
    run: runConfig,
  },
  {
    name: "claude-cmd",
    usage: "/claude-cmd /context",
    description: "slash.desc.claudeCmd",
    run: (ctx) => {
      // Everything after /claude-cmd is forwarded verbatim to the AI CLI, so its own
      // slash commands (/context, /usage…) reach it instead of the 4pm router.
      const rest = ctx.args.join(" ").trim();
      if (!rest) {
        ctx.print(t("slash.claudeCmd.usage"), "error");
        return;
      }
      ctx.submitAi(rest);
    },
  },
  {
    name: "clear",
    usage: "/clear",
    description: "slash.desc.clear",
    run: (ctx) => ctx.clear(),
  },
  {
    name: "quit",
    usage: "/quit",
    description: "slash.desc.quit",
    run: (ctx) => ctx.quit(),
  },
];

/** Alias: /exit ⇒ /quit. */
const ALIASES: Record<string, string> = { exit: "quit" };

/** Public command metadata (name · usage · description) for the input autocomplete. */
export const SLASH_COMMANDS: { name: string; usage: string; description: string }[] =
  COMMANDS.map((c) => ({ name: c.name, usage: c.usage, description: c.description }));

/**
 * Dispatch a `/…` line to its command. Returns nothing — output goes through
 * ctx.print. Unknown commands print an error with a hint.
 */
export function runSlashCommand(
  line: string,
  base: Omit<SlashContext, "args">,
): void {
  const tokens = line.replace(/^\//, "").trim().split(/\s+/);
  const rawName = tokens[0] ?? "";
  const name = ALIASES[rawName] ?? rawName;
  const command = COMMANDS.find((c) => c.name === name);
  const ctx: SlashContext = { ...base, args: tokens.slice(1) };
  if (!command) {
    ctx.print(t("slash.unknown", { name: rawName }), "error");
    return;
  }
  command.run(ctx);
}
