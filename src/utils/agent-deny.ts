/**
 * agent-deny (ADR-0347) — the secret-path **deny rules** injected into every claude agent run the cli
 * spawns (project dispatch, memory compaction, knowledge compose, AI assist, support answer, FAQ
 * compose). Claude's file tools may READ anywhere without an approval, so a prompt-injected or
 * misbehaving agent could read the worker's credentials; these rules make claude refuse Read/Glob/Grep
 * (the `Read(...)` rules) and Edit/Write (the `Edit(...)` rules) on:
 *
 * - every configured AI profile dir (`CLAUDE_CONFIG_DIR` / `CODEX_HOME` targets) and the run's own,
 * - the cli's profile store `~/.4pm/profiles/` (config.json with the `ws_token`, `.cre`, logs, sockets), the
 *   default-profile pointer and the gh/glab login dirs a container keeps in `~/.4pm/` — but NOT
 *   `~/.4pm/workspaces/`, where the served projects live (ADR-0430; denying all of `~/.4pm` also hid the
 *   agent's own project from claude),
 * - `~/.ssh/`, `~/.config/gh/`, `~/.git-credentials`, and `~/.claude*` (default claude homes/config).
 *
 * Deny rules win over allow rules and are enforced in every permission mode (incl. bypassPermissions).
 * They cover claude's FILE tools only — a shell command (`Bash`) can still read a path, so flows that
 * allow Bash stay protected only as far as their Bash policy goes. Delivered as `--settings <json>`
 * (a single-value flag, so it can't be swallowed by / swallow a variadic `--disallowedTools`).
 * Claude only — other AI CLIs get no args.
 */
import { isAbsolute, resolve } from "node:path";

/** Home-relative secret locations denied to every agent run (claude `~/` rule syntax). */
const HOME_SECRET_PATTERNS = [
  "~/.4pm/profiles/**",
  "~/.4pm/default",
  "~/.4pm/gh/**",
  "~/.4pm/glab/**",
  "~/.ssh/**",
  "~/.config/gh/**",
  "~/.git-credentials",
  "~/.claude*",
  "~/.claude*/**",
];

/**
 * Claude permission-rule path for an absolute dir: `//abs/path/**` (a single leading `/` would be
 * relative to the settings source, `//` anchors at the filesystem root).
 */
function absDirPattern(dir: string): string {
  const abs = (isAbsolute(dir) ? dir : resolve(dir)).replace(/\\/g, "/").replace(/\/+$/, "");
  return `/${abs.startsWith("/") ? abs : `/${abs}`}/**`;
}

/**
 * The deny rules for a run: the fixed home secrets plus each given AI profile dir (all configured
 * credentials + the run's own). Directories under `$HOME` are also covered by the patterns above
 * when they match; absolute rules make non-dotted / out-of-home profile dirs safe too.
 */
export function agentDenyRules(profileDirs: (string | null | undefined)[] = []): string[] {
  const patterns = new Set(HOME_SECRET_PATTERNS);
  for (const dir of profileDirs) {
    if (dir && dir.trim()) patterns.add(absDirPattern(dir.trim()));
  }
  const rules: string[] = [];
  for (const p of patterns) rules.push(`Read(${p})`, `Edit(${p})`);
  return rules;
}

/**
 * The `--settings` args carrying the deny rules for a claude run (empty for any other AI CLI).
 * `cmd` may be a path — matched by substring like the rest of the planner.
 */
export function denySettingsArgs(cmd: string, profileDirs: (string | null | undefined)[] = []): string[] {
  if (!cmd.includes("claude")) return [];
  return ["--settings", JSON.stringify({ permissions: { deny: agentDenyRules(profileDirs) } })];
}
