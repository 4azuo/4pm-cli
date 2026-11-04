/**
 * Vendored from @4pm/shared-constants (worker-tools.ts) by scripts/vendor-shared.mjs — do not edit.
 */
export type WorkerToolCategory = "runtime" | "ai-cli" | "vcs";
export const WORKER_TOOL_MANAGERS = ["npm", "pnpm"] as const;
export type WorkerToolManager = (typeof WORKER_TOOL_MANAGERS)[number];
export interface WorkerToolCatalogEntry {
    id: string;
    label: string;
    category: WorkerToolCategory;
    versionArg: string;
    installPackage: string | null;
    installable: boolean;
    updatable: boolean;
    installWhenMissing: boolean;
}
export const WORKER_TOOL_CATALOG: readonly WorkerToolCatalogEntry[] = [
    { id: "git", label: "Git", category: "vcs", versionArg: "--version", installPackage: null, installable: false, updatable: false, installWhenMissing: false },
    { id: "node", label: "Node.js", category: "runtime", versionArg: "--version", installPackage: null, installable: false, updatable: false, installWhenMissing: false },
    { id: "npm", label: "npm", category: "runtime", versionArg: "--version", installPackage: null, installable: false, updatable: false, installWhenMissing: false },
    { id: "pnpm", label: "pnpm", category: "runtime", versionArg: "--version", installPackage: "pnpm", installable: false, updatable: true, installWhenMissing: false },
    { id: "claude", label: "Claude Code", category: "ai-cli", versionArg: "--version", installPackage: "@anthropic-ai/claude-code", installable: false, updatable: true, installWhenMissing: true },
    { id: "codex", label: "Codex", category: "ai-cli", versionArg: "--version", installPackage: "@openai/codex", installable: false, updatable: true, installWhenMissing: true },
    { id: "gh", label: "GitHub CLI", category: "vcs", versionArg: "--version", installPackage: null, installable: false, updatable: false, installWhenMissing: true },
    { id: "glab", label: "GitLab CLI", category: "vcs", versionArg: "--version", installPackage: null, installable: false, updatable: false, installWhenMissing: true },
] as const;
export const WORKER_TOOL_PREREQUISITE_IDS: readonly string[] = WORKER_TOOL_CATALOG.filter((t) => !t.installable).map((t) => t.id);
export const WORKER_TOOL_UPDATABLE_IDS: readonly string[] = WORKER_TOOL_CATALOG.filter((t) => t.updatable).map((t) => t.id);
export const WORKER_TOOL_BUNDLED_GLOBALS: readonly string[] = ["npm", "corepack"];
export const WORKER_TOOL_INSTALL_WHEN_MISSING_IDS: readonly string[] = WORKER_TOOL_CATALOG.filter((t) => t.installWhenMissing).map((t) => t.id);
