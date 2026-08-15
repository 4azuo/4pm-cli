/**
 * Worker tool catalog (ADR-0206) — the default set of command-line tools 4PM detects on a
 * worker (the AI CLIs, the VCS CLIs and the base toolchain), plus the shape used to install
 * one. Single source of truth reused by the cli (detection/install), the shared UI panel, and
 * the admin Documents "Default tools" reference. Framework-independent (pure constant).
 */

/** How a catalog tool is categorized in the UI. */
export type WorkerToolCategory = "runtime" | "ai-cli" | "vcs";

/** The package managers a global install/uninstall may use. */
export const WORKER_TOOL_MANAGERS = ["npm", "pnpm"] as const;

/** Union of the supported package managers. */
export type WorkerToolManager = (typeof WORKER_TOOL_MANAGERS)[number];

/** One default-catalog tool. */
export interface WorkerToolCatalogEntry {
  /** Stable id + the command probed on the worker (also the DELETE `:name` for a catalog tool). */
  id: string;
  /** Human label for the UI. */
  label: string;
  /** Category badge. */
  category: WorkerToolCategory;
  /** Argument used to probe the version (always `--version` today; kept explicit for clarity). */
  versionArg: string;
  /**
   * The npm package to install for this tool, or `null` for a **detect-only** prerequisite
   * (runtime/OS binary that is not installed through npm/pnpm — shown with a guidance note, no
   * install/uninstall button).
   */
  installPackage: string | null;
}

/**
 * The default worker-tool catalog (ADR-0206). `installPackage: null` ⇒ detect-only (a
 * prerequisite the panel never installs/uninstalls).
 */
export const WORKER_TOOL_CATALOG: readonly WorkerToolCatalogEntry[] = [
  { id: "git", label: "Git", category: "vcs", versionArg: "--version", installPackage: null },
  { id: "node", label: "Node.js", category: "runtime", versionArg: "--version", installPackage: null },
  { id: "npm", label: "npm", category: "runtime", versionArg: "--version", installPackage: null },
  { id: "pnpm", label: "pnpm", category: "runtime", versionArg: "--version", installPackage: "pnpm" },
  { id: "claude", label: "Claude Code", category: "ai-cli", versionArg: "--version", installPackage: "@anthropic-ai/claude-code" },
  { id: "codex", label: "Codex", category: "ai-cli", versionArg: "--version", installPackage: "@openai/codex" },
  { id: "gh", label: "GitHub CLI", category: "vcs", versionArg: "--version", installPackage: null },
  { id: "glab", label: "GitLab CLI", category: "vcs", versionArg: "--version", installPackage: null },
] as const;

/** The catalog ids that are detect-only prerequisites (cannot be installed/uninstalled). */
export const WORKER_TOOL_PREREQUISITE_IDS: readonly string[] = WORKER_TOOL_CATALOG.filter(
  (t) => t.installPackage === null,
).map((t) => t.id);

/**
 * Global npm packages that ship **with Node itself** (not operator-installed). They are never
 * listed as uninstallable "extras" and the cli refuses to install/uninstall them — removing them
 * would break the runtime.
 */
export const WORKER_TOOL_BUNDLED_GLOBALS: readonly string[] = ["npm", "corepack"];
