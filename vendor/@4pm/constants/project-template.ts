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
  version: "1.0.0",
  changelog: [
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
