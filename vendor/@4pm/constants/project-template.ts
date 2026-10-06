/**
 * Scaffold-template (`project-sample`) version + changelog — the single source of truth
 * (ADR-0262). The cli reads `PROJECT_TEMPLATE.version` (via its vendored copy) to stamp a new
 * project's `.4pm/.4pm.json`; `@4pm/server` serves this constant (project-0054) so the web can
 * compare a created project's version against the latest and drive the update flow.
 *
 * Bumping the template: add a newest-first `changelog` entry and raise `version` in the SAME
 * commit that changes the `project-sample` files (submodule) — otherwise created projects can't
 * tell they are behind and the Analyze/Update prompts have nothing to diff.
 */

/** One changelog entry for a template version (newest first in `PROJECT_TEMPLATE.changelog`). */
export interface ProjectTemplateChangelogEntry {
  /** The entry's semver (e.g. "1.1.0"). */
  version: string;
  /** ISO date of the release (YYYY-MM-DD). */
  date: string;
  /** One-line summary of what this version changes. */
  summary: string;
  /** Bullet notes on the change (optional). */
  notes?: string[];
  /** Template paths this entry touched — hints the Analyze/Update AI prompts (optional). */
  files?: string[];
  /**
   * Whether a project may defer this version's update ("Skip for now"). Default (absent/false) =
   * mandatory: the Skip control only shows when EVERY pending version is `skippable` (ADR-0262).
   */
  skippable?: boolean;
}

/** The scaffold template's current version + its changelog. */
export interface ProjectTemplate {
  /** Latest template semver — the only number that matters for the drift compare. */
  version: string;
  /** Changelog, newest first. */
  changelog: ProjectTemplateChangelogEntry[];
}

/** The authoritative scaffold-template version + changelog (ADR-0262). */
export const PROJECT_TEMPLATE: ProjectTemplate = {
  version: "1.1.1",
  changelog: [
    {
      version: "1.1.1",
      date: "2026-10-06",
      summary: "The default AI model is chosen per project instead of being hard-coded in .claude/settings.json (ADR-0394).",
      notes: [
        ".claude/settings.json no longer pins \"model\": \"claude-opus-4-8\". Remove the key to follow the AI CLI's default model, or set it to the model the project should use.",
        ".claude/agents/<name>.md frontmatter may carry description: and model: (a subagent without model: inherits the session model).",
      ],
      files: [".claude/settings.json"],
    },
    {
      version: "1.1.0",
      date: "2026-09-30",
      summary: "Multi-worker autonomous books: multi-row AI_PROGRESS claims, QA-gated task Depends, attempts sidecar (ADR-0371).",
      notes: [
        "AI_PROGRESS.md holds one row per claimed task: | Started | ID | Worker | Claim | Attempt | Task description | (was a single | Started | ID | Task description | row). Convert an existing single row into the new columns (Worker/Claim empty, Attempt 1).",
        "AI_TODO.md Depends may list QA-… ids (the task waits for that USER_QA answer); two or more TSK dependencies require their PRs to be merged into the base branch; Notes may carry size: S|M and from: <branch>.",
        "USER_QA.md notes that a question raised while implementing a task is listed in that task's Depends.",
        ".claude/AUTONOMOUS.md documents branches & claims; .claude/.autonomous.attempts.json (per-task attempts / split-pending) is committed with the books — make sure it is NOT gitignored.",
      ],
      files: [
        "AI_PROGRESS.md",
        "AI_TODO.md",
        "USER_QA.md",
        ".claude/AUTONOMOUS.md",
        ".claude/templates/AI_PROGRESS.empty.md",
        ".claude/templates/AI_PROGRESS.sample.md",
        ".claude/templates/AI_TODO.empty.md",
        ".claude/templates/AI_TODO.sample.md",
        ".claude/templates/USER_QA.empty.md",
      ],
    },
    {
      version: "1.0.2",
      date: "2026-09-16",
      summary: "AI_DONE.md changed to a Markdown table — catch-up entry for projects scaffolded before the conversion.",
      notes: [
        "AI_DONE.md's Done and Incidents sections are Markdown tables (| Timestamp | ID | Task description | Files | Notes | and | Timestamp | Note |), matching the other autonomous books.",
        "The conversion itself shipped with the baseline scaffold, but was never recorded as a template version, so the 1.0.1 changelog assumed AI_DONE was already tabular. Projects scaffolded before it still carry the old two-section prose layout even at 1.0.1; this entry lets them detect the drift and convert AI_DONE on the next Update.",
      ],
      files: [
        "AI_DONE.md",
        ".claude/templates/AI_DONE.empty.md",
        ".claude/templates/AI_DONE.sample.md",
      ],
    },
    {
      version: "1.0.1",
      date: "2026-09-13",
      summary: "Autonomous 'book' templates unified as Markdown tables (following AI_DONE).",
      notes: [
        "Every book is now a structured table: AI_PROGRESS → | Started | ID | Task description |, USER_TODO → | # | Request | Notes |, USER_QA → | Date | Original request | Question / options | Answer | (AI_DONE, AI_TODO, AI_PLACEHOLDER were already tables).",
        "Web-posted USER_TODO requests append as a table row, with who/when kept in the Notes column.",
      ],
      files: [
        ".claude/templates/AI_PROGRESS.empty.md",
        ".claude/templates/AI_PROGRESS.sample.md",
        ".claude/templates/USER_TODO.empty.md",
        ".claude/templates/USER_TODO.sample.md",
        ".claude/templates/USER_QA.empty.md",
        ".claude/templates/USER_QA.sample.md",
        "AI_PROGRESS.md",
        "USER_TODO.md",
        "USER_QA.md",
      ],
    },
    {
      version: "1.0.0",
      date: "2026-09-12",
      summary: "Baseline scaffold template with version tracking.",
      notes: [
        "Initial CLAUDE.md, .claude config (settings, hooks, skills, agents, autonomous).",
        "Standard docs/tests/reports/src layout and placeholder files.",
        "Introduces .4pm/.4pm.json template-version tracking.",
      ],
      files: [],
    },
  ],
};
