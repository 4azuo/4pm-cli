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
import { readRecentLogLines } from "../common/logger/logger";
import type { SessionInfo } from "./session-info";

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
      if (!value) return { error: `Missing value for "${key}".` };
      return { patch: { [key]: value } };
    case "claudeHome":
    case "codexHome":
    case "antigravityHome": {
      // Space-separated profile dirs → `{ profile, model:"" }` objects (failover order —
      // ADR-0057). `args`/`model` per profile are set by editing config.json directly.
      const dirs = valueTokens.filter((t) => t.trim());
      if (dirs.length === 0) return { error: `Missing value for "${key}".` };
      return { patch: { [key]: dirs.map((profile) => ({ profile, model: "" })) } };
    }
    case "commandHistoryUploadMinutes": {
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0) return { error: `"${value}" is not a positive number.` };
      return { patch: { commandHistoryUploadMinutes: n } };
    }
    case "autoUpdate":
      if (value !== "true" && value !== "false") return { error: `Use true|false, not "${value}".` };
      return { patch: { autoUpdate: value === "true" } };
    case "aiEnv":
      try {
        return { patch: { aiEnv: JSON.parse(value) as Record<string, string> } };
      } catch {
        return { error: `aiEnv must be JSON, e.g. {"KEY":"val"}.` };
      }
    default:
      return { error: `Unknown key "${key}". Allowed: ${CONFIG_KEYS.join(", ")}.` };
  }
}

/** Handle the `/config` command and its subcommands (show | init | set). */
function runConfig(ctx: SlashContext): void {
  const [sub, ...rest] = ctx.args;
  const dir = ctx.info.profileDir;
  const path = configPath(dir);

  if (!sub || sub === "show") {
    ctx.print(`config: ${path}`);
    const json = JSON.stringify(readProfileConfig(dir), null, 2);
    for (const line of json.split("\n")) ctx.print(line);
    return;
  }
  if (sub === "init") {
    const writeDefaults = (verb: string): void => {
      overwriteProfileConfig(dir, defaultProfileConfig());
      ctx.print(`✔ ${verb} default config: ${path}`);
      ctx.print("add claude profiles: /config set claudeHome .claude .claude-1 (tried in order)");
    };
    if (existsSync(path)) {
      // Ask before clobbering an existing config; the replace is a full overwrite.
      ctx.confirm(`config exists: ${path} — replace it with defaults? (y/N)`, () =>
        writeDefaults("replaced with"),
      );
      return;
    }
    writeDefaults("wrote");
    return;
  }
  if (sub === "set") {
    const [key, ...valueTokens] = rest;
    if (!key) {
      ctx.print("usage: /config set <key> <value>", "error");
      return;
    }
    const result = parseConfigAssignment(key, valueTokens);
    if ("error" in result) {
      ctx.print(result.error, "error");
      return;
    }
    const merged = writeProfileConfig(dir, result.patch);
    ctx.print(`✔ ${key} = ${JSON.stringify((merged as Record<string, unknown>)[key])} (applies to the next prompt)`);
    return;
  }
  if (sub === "delete" || sub === "unset") {
    const key = rest[0];
    if (!key) {
      ctx.print("usage: /config delete <key>", "error");
      return;
    }
    if (!(CONFIG_KEYS as readonly string[]).includes(key)) {
      ctx.print(`Unknown key "${key}". Allowed: ${CONFIG_KEYS.join(", ")}.`, "error");
      return;
    }
    deleteProfileConfigKey(dir, key as keyof ProfileConfig);
    ctx.print(`✔ deleted ${key}`);
    return;
  }
  ctx.print(`Unknown /config subcommand "${sub}". Use: show | init | set | delete.`, "error");
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
    ctx.print("No commands run yet.");
    return;
  }
  const recent = all.slice(-n).reverse();
  ctx.print(`Last ${recent.length} of ${all.length} commands (newest first) · /output <n> to view:`);
  recent.forEach((e, i) => {
    const time = new Date(e.startedAt).toLocaleTimeString();
    const state =
      e.status === "done" ? "✓" : e.status === "failed" ? `✗ exit ${e.exitCode}` : "· running";
    ctx.print(`  [${i + 1}] ${time}  ${commandLine(e.cmd, e.args)}  · ${state}`);
  });
}

/** /output <n> — replay the captured output of the nth command from /history. */
function runOutput(ctx: SlashContext): void {
  const all = getCommandHistory();
  const n = Number(ctx.args[0]);
  if (!Number.isInteger(n) || n < 1 || n > all.length) {
    ctx.print("usage: /output <n>   (n = index from /history)", "error");
    return;
  }
  const entry = all.slice().reverse()[n - 1]!;
  const state = entry.exitCode != null ? ` (exit ${entry.exitCode})` : "";
  ctx.print(`── output [${n}] ${commandLine(entry.cmd, entry.args)} · ${entry.status}${state} ──`);
  const out = readCommandOutput(entry.commandId);
  if (out == null) {
    ctx.print("(no output stored — it ran in a previous session or produced none)", "warn");
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
    ctx.print("No log lines yet.");
    return;
  }
  ctx.print(`Last ${lines.length} log lines (${dir}):`);
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
  ctx.print("whoami: fetching from the server…");
  void ctx.info.whoami().then((w) => {
    if (!w) {
      ctx.print("whoami: unavailable (server unreachable or link invalid)", "warn");
      return;
    }
    ctx.print(`account:  ${w.username} · scope: ${w.scope} · roles: ${w.roles.join(", ") || "—"}`);
    ctx.print(`teams:    ${w.teams.length ? w.teams.map((t) => t.name).join(", ") : "(none)"}`);
    ctx.print(`projects: ${w.projects.length ? w.projects.map((p) => p.name).join(", ") : "(none)"}`);
  });
}

/** /expand [N] · /collapse [N] — toggle/fold a numbered `▸[N]` block (ADR-0108). */
function runFold(ctx: SlashContext, action: "expand" | "collapse"): void {
  if (ctx.maxBlock === 0) {
    ctx.print("No collapsible blocks on screen.", "warn");
    return;
  }
  const n = ctx.args[0] != null ? Number(ctx.args[0]) : ctx.maxBlock;
  if (!Number.isInteger(n) || n < 1 || n > ctx.maxBlock) {
    ctx.print(`usage: /${action} [1-${ctx.maxBlock}]   (no number ⇒ the newest block)`, "error");
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
    description: "List slash commands",
    run: (ctx) => {
      ctx.print("Slash commands:");
      for (const cmd of COMMANDS) ctx.print(`  ${cmd.usage.padEnd(28)} ${cmd.description}`);
    },
  },
  {
    name: "version",
    usage: "/version",
    description: "Show the cli version",
    run: (ctx) => ctx.print(`4PM CLI v${ctx.info.version} · profile ${ctx.info.profile}`),
  },
  {
    name: "status",
    usage: "/status",
    description: "Show connection + profile + session status",
    run: (ctx) => {
      const s = ctx.live;
      const uptime = fmtDuration(Math.max(0, Math.floor((Date.now() - s.startedAt) / 1000)));
      ctx.print(`connection: ${s.status}`);
      ctx.print(`scope:      ${s.scope}`);
      ctx.print(`worker:     ${s.worker ?? "(unknown)"}`);
      if (s.project) ctx.print(`project:    ${s.project}`);
      ctx.print(`profile:    ${ctx.info.profile}`);
      ctx.print(`server:     ${ctx.info.serverUrl}`);
      ctx.print(`aiCli:      ${ctx.info.aiCli}${s.activeProfile ? ` · profile ${s.activeProfile}` : ""}`);
      ctx.print(`serving:    ${ctx.info.physicPath ?? "(none)"}`);
      ctx.print(`uptime:     ${uptime} · commands: ${getCommandHistory().length}`);
    },
  },
  {
    name: "history",
    usage: "/history [N]",
    description: "List the last N executed commands (+ time)",
    run: runHistory,
  },
  {
    name: "output",
    usage: "/output <n>",
    description: "Replay a command's output (n from /history)",
    run: runOutput,
  },
  {
    name: "logs",
    usage: "/logs [N]",
    description: "Tail the profile's structured log",
    run: runLogs,
  },
  {
    name: "expand",
    usage: "/expand [N]",
    description: "Expand a collapsed ▸[N] block (default: newest); pretty-prints json/code",
    run: (ctx) => runFold(ctx, "expand"),
  },
  {
    name: "collapse",
    usage: "/collapse [N]",
    description: "Collapse an expanded ▸[N] block (default: newest)",
    run: (ctx) => runFold(ctx, "collapse"),
  },
  {
    name: "reconnect",
    usage: "/reconnect",
    description: "Reconnect to the server now (skip the backoff)",
    run: (ctx) => ctx.reconnect(),
  },
  {
    name: "whoami",
    usage: "/whoami",
    description: "Show this machine account + its teams & projects",
    run: runWhoami,
  },
  {
    name: "config",
    usage: "/config [show|init|set <k> <v>|delete <k>]",
    description: "View / init / update / delete profile config",
    run: runConfig,
  },
  {
    name: "claude-cmd",
    usage: "/claude-cmd /context",
    description: "Run an AI-CLI slash command (e.g. /context, /usage, /status)",
    run: (ctx) => {
      // Everything after /claude-cmd is forwarded verbatim to the AI CLI, so its own
      // slash commands (/context, /usage…) reach it instead of the 4pm router.
      const rest = ctx.args.join(" ").trim();
      if (!rest) {
        ctx.print("usage: /claude-cmd /context  (forwards to the AI CLI)", "error");
        return;
      }
      ctx.submitAi(rest);
    },
  },
  {
    name: "clear",
    usage: "/clear",
    description: "Clear the transcript",
    run: (ctx) => ctx.clear(),
  },
  {
    name: "quit",
    usage: "/quit",
    description: "Quit the cli (also /exit, Ctrl+C)",
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
    ctx.print(`Unknown command: /${rawName} — try /help`, "error");
    return;
  }
  command.run(ctx);
}
