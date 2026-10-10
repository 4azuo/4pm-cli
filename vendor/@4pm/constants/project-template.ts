/**
 * Scaffold-template (`project-sample`) version + changelog — the single source of truth.
 * The data lives in the sibling `project-template.json`; this file holds only its types
 * and exposes it as the typed `PROJECT_TEMPLATE`. The cli reads `PROJECT_TEMPLATE.version` (via its
 * vendored copy) to stamp a new project's `.4pm/.4pm.json`; `@4pm/server` serves this constant
 * so the web can compare a created project's version against the latest and drive the
 * update flow.
 *
 * Bumping the template: in `project-template.json`, add a newest-first `changelog` entry and raise
 * `version` in the SAME commit that changes the `project-sample` files (submodule) — otherwise
 * created projects can't tell they are behind and the Analyze/Update prompts have nothing to diff.
 * @api project-0054 @adr 0262
 */
import templateData from "./project-template.json";

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
   * mandatory: the Skip control only shows when EVERY pending version is `skippable`.
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

/** The authoritative scaffold-template version + changelog. */
export const PROJECT_TEMPLATE: ProjectTemplate = templateData;
