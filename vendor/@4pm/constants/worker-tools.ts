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
   * The npm package this tool is distributed as — kept as the tool's **package identity** (dedup
   * against the detected global "extras" list, and the Documents "how it is installed" reference),
   * or `null` for a runtime/OS binary not distributed through npm/pnpm. This is **not** the same as
   * "installable via the panel" — see `installable`.
   */
  installPackage: string | null;
  /**
   * Whether the Tools panel offers **install/uninstall** for this tool (ADR-0227). `false` ⇒ a
   * **detect-only prerequisite**: the panel shows it read-only ("Prerequisite"), never installs or
   * uninstalls it — even when it has an `installPackage` (the tool is provisioned/managed
   * out-of-band, e.g. 4PM-managed on a rented pool worker). The whole default catalog is detect-only.
   */
  installable: boolean;
}

/**
 * The default worker-tool catalog (ADR-0206/0227). Every default tool is **detect-only**
 * (`installable: false`) — the panel probes + displays it but never installs/uninstalls it;
 * ad-hoc install/uninstall is reserved for arbitrary extra global packages. `installPackage` is
 * still the package identity (extras-dedup + Documents reference), independent of `installable`.
 */
export const WORKER_TOOL_CATALOG: readonly WorkerToolCatalogEntry[] = [
  { id: "git", label: "Git", category: "vcs", versionArg: "--version", installPackage: null, installable: false },
  { id: "node", label: "Node.js", category: "runtime", versionArg: "--version", installPackage: null, installable: false },
  { id: "npm", label: "npm", category: "runtime", versionArg: "--version", installPackage: null, installable: false },
  { id: "pnpm", label: "pnpm", category: "runtime", versionArg: "--version", installPackage: "pnpm", installable: false },
  { id: "claude", label: "Claude Code", category: "ai-cli", versionArg: "--version", installPackage: "@anthropic-ai/claude-code", installable: false },
  { id: "codex", label: "Codex", category: "ai-cli", versionArg: "--version", installPackage: "@openai/codex", installable: false },
  { id: "gh", label: "GitHub CLI", category: "vcs", versionArg: "--version", installPackage: null, installable: false },
  { id: "glab", label: "GitLab CLI", category: "vcs", versionArg: "--version", installPackage: null, installable: false },
] as const;

/** The catalog ids that are detect-only prerequisites (cannot be installed/uninstalled). */
export const WORKER_TOOL_PREREQUISITE_IDS: readonly string[] = WORKER_TOOL_CATALOG.filter(
  (t) => !t.installable,
).map((t) => t.id);

/**
 * Global npm packages that ship **with Node itself** (not operator-installed). They are never
 * listed as uninstallable "extras" and the cli refuses to install/uninstall them — removing them
 * would break the runtime.
 */
export const WORKER_TOOL_BUNDLED_GLOBALS: readonly string[] = ["npm", "corepack"];
