/**
 * AI prompt catalog registry (ADR-0381) — the single, framework-free source of truth for every
 * **server-managed** pre-written prompt (arch 0047). Shared by `@4pm/server` (seed default + the
 * server-built builders) and `@4pm/cli` (built-in default + override-or-built-in), so the default
 * text lives in exactly one place. The live content is the server DB prompt catalog, keyed by each
 * entry's `key`; these defaults are the **fill-only seed default + forward-safe fallback**.
 *
 * The default **template text** lives in the sibling `ai-prompt-defaults.json` (one string per key,
 * `{{var}}` placeholders); this file holds only each prompt's metadata (owner app, title,
 * description, required variables) and wires it to its default. Editing a prompt's wording = editing
 * the JSON (seed) or, at runtime, the admin DB catalog.
 *
 * Templating: a template may contain `{{var}}` placeholders; the builder substitutes them with
 * `renderPrompt`. `requiredVars` lists the placeholders a builder depends on — admin edits are
 * validated against this so a save can never drop a variable the builder needs.
 */
import defaultTemplates from "./ai-prompt-defaults.json";

/** The seed/fallback template per prompt key (from `ai-prompt-defaults.json`). */
const DEFAULTS = defaultTemplates as Record<string, string>;

/** Which app builds + dispatches the prompt (arch 0047). */
export type PromptOwnerApp = "server" | "cli" | "web";

/** Rollout phase (ADR-0381): `1` = server/cli (DB-managed now), `2` = web (deferred). */
export type PromptPhase = 1 | 2;

/** One manageable prompt in the catalog. */
export interface PromptDef {
  /** Stable catalog id (also the DB row key), e.g. `cli.research.policy`. */
  key: string;
  /** App that builds + dispatches it. */
  ownerApp: PromptOwnerApp;
  /** Rollout phase. */
  phase: PromptPhase;
  /** Short admin-facing title. */
  title: string;
  /** What the prompt is for (admin-facing). */
  description: string;
  /** `{{var}}` placeholders the builder injects — enforced on save (none = a static prompt). */
  requiredVars: string[];
  /** The built-in base-locale (English) template: seed default + forward-safe fallback. */
  defaultTemplate: string;
}

/** The base locale for prompt content; other locales are translations that fall back to this. */
export const AI_PROMPT_DEFAULT_LOCALE = "en";

/**
 * Substitute `{{var}}` placeholders in a template with `vars`. Unknown placeholders are left
 * literal (so a partial var map never corrupts the rest); whitespace around the name is tolerated.
 */
export function renderPrompt(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match,
  );
}

/** Collect the `{{var}}` placeholder names used in a template (deduplicated, in first-seen order). */
export function promptTemplateVars(template: string): string[] {
  const seen: string[] = [];
  for (const m of template.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)) {
    const name = m[1] as string;
    if (!seen.includes(name)) seen.push(name);
  }
  return seen;
}

/** One registry entry's metadata (its default text is looked up from the JSON by key). */
type PromptMeta = Omit<PromptDef, "defaultTemplate">;

/** The prompt metadata, in catalog order. New prompts are added here + to the defaults JSON. */
const PROMPT_META: PromptMeta[] = [
  {
    key: "server.knowledge.distill",
    ownerApp: "server",
    phase: 1,
    title: "Knowledge distillation",
    description: "Turns a project into a shareable knowledge article (read-only agent in the project folder).",
    requiredVars: ["projectName"],
  },
  {
    key: "cli.research.policy",
    ownerApp: "cli",
    phase: 1,
    title: "AI Research — system policy",
    description: "System instruction + content policy prepended to an org Research question.",
    requiredVars: ["question"],
  },
  {
    key: "cli.memory.compact",
    ownerApp: "cli",
    phase: 1,
    title: "Console memory compaction",
    description: "Merges the latest exchange into the rolling per-project AI memory, budget-bounded.",
    requiredVars: ["budgetChars", "oldMemory", "prompt", "answer"],
  },
  {
    key: "cli.support.answer",
    ownerApp: "cli",
    phase: 1,
    title: "AI Help — support answer",
    description: "Answers a user/admin product question from the KB docs, with the inline moderation JSON contract. Edit with care: the response must stay a single JSON object with onTopic/sensitive/reason/answer.",
    requiredVars: ["roleNote", "docs", "question"],
  },
  {
    key: "cli.support.reply_draft",
    ownerApp: "cli",
    phase: 1,
    title: "Admin draft — ticket reply",
    description: "Drafts a support-team reply to a ticket (freeform markdown).",
    requiredVars: ["docs", "context"],
  },
  {
    key: "cli.support.outreach_draft",
    ownerApp: "cli",
    phase: 1,
    title: "Admin draft — outreach message",
    description: "Drafts an outreach message to customer orgs (freeform markdown).",
    requiredVars: ["docs", "context"],
  },
  {
    key: "cli.support.legal_draft",
    ownerApp: "cli",
    phase: 1,
    title: "Admin draft — legal document body",
    description: "Drafts/revises a legal document body in a locale, keeping legal {{placeholders}} verbatim.",
    requiredVars: ["docs", "context"],
  },
  {
    key: "cli.faq.compose",
    ownerApp: "cli",
    phase: 1,
    title: "Ticket → FAQ synthesis",
    description: "Agent-write run that distils resolved tickets into FAQ markdown + a per-ticket JSON summary. Keep the required JSON output block and the {{ticketJsonSkeleton}} intact.",
    requiredVars: ["transcript", "ticketJsonSkeleton"],
  },
  {
    key: "cli.scaffold.readme",
    ownerApp: "cli",
    phase: 1,
    title: "Scaffold — README author",
    description: "Writes the initial README.md for a new project from its spec JSON (on project create).",
    requiredVars: ["specJson"],
  },
  {
    key: "cli.scaffold.guide",
    ownerApp: "cli",
    phase: 1,
    title: "Scaffold — agent guide author",
    description: "Writes the project's CLAUDE.md / AGENT.md guide from its spec JSON (on project create).",
    requiredVars: ["guideFile", "specJson"],
  },
  {
    key: "cli.autonomous.intake",
    ownerApp: "cli",
    phase: 1,
    title: "Autonomous — intake",
    description: "Analyses approved user requests + answered intake questions into sized AI tasks (books only; no git/code).",
    requiredVars: ["booksIntro", "sMaxFiles", "sMaxLines", "mMaxFiles", "mMaxLines"],
  },
  {
    key: "cli.autonomous.implement",
    ownerApp: "cli",
    phase: 1,
    title: "Autonomous — implement",
    description: "Implements exactly one task on the prepared branches (commit only). Keep the final JSON status block intact.",
    requiredVars: ["taskId", "desc", "branch", "subLines"],
  },
  {
    key: "cli.autonomous.split",
    ownerApp: "cli",
    phase: 1,
    title: "Autonomous — split",
    description: "Read-only: proposes smaller child tasks when a task repeatedly fails. Keep the final JSON children block intact.",
    requiredVars: ["taskId", "desc", "reasons", "branch", "diff"],
  },
  {
    key: "web.generators",
    ownerApp: "web",
    phase: 2,
    title: "Content generator",
    description: "Produces a report / estimation / WBS / proposal / feasibility Markdown document from the project spec.",
    requiredVars: ["what", "specContext"],
  },
  {
    key: "web.guide",
    ownerApp: "web",
    phase: 2,
    title: "AI guide (CLAUDE.md / AGENT.md)",
    description: "Writes/refines the project's agent-guide file from the spec. Keep the mandatory AI_SECURITY.md section.",
    requiredVars: ["file", "specContext"],
  },
  {
    key: "web.draft_tasks",
    ownerApp: "web",
    phase: 2,
    title: "Draft tasks from spec",
    description: "Breaks the spec into a JSON array of engineering tasks. Keep the required JSON array output shape.",
    requiredVars: ["specContext"],
  },
  {
    key: "web.spec.review",
    ownerApp: "web",
    phase: 2,
    title: "Spec review (advisory)",
    description: "Advises on the whole spec in the fixed ASSESSMENT/ISSUES format (no rewrite). Keep that reply format.",
    requiredVars: ["specContext"],
  },
  {
    key: "web.spec.compose",
    ownerApp: "web",
    phase: 2,
    title: "Spec compose (gates create)",
    description: "Revises the spec with minimal edits + judges readiness. GATES project creation — keep the exact JSON object shape (changes/tree/ok/assessment/blockers).",
    requiredVars: ["specContext"],
  },
  {
    key: "web.spec.suggest",
    ownerApp: "web",
    phase: 2,
    title: "Spec field suggest (✨)",
    description: "Suggests a value for one spec field. {{shape}} carries the reply-format rule the parser depends on.",
    requiredVars: ["target", "shape", "specContext"],
  },
  {
    key: "web.spec.group_suggest",
    ownerApp: "web",
    phase: 2,
    title: "Spec section suggest",
    description: "Suggests values for a whole wizard section. Keep the single-line JSON object (field id → value) output shape.",
    requiredVars: ["groupKey", "fieldLines", "specContext"],
  },
  {
    key: "web.spec.subagents_suggest",
    ownerApp: "web",
    phase: 2,
    title: "Subagents suggest",
    description: "Proposes the project's AI subagents. Keep the JSON array of {name,description} output shape.",
    requiredVars: ["current", "specContext"],
  },
  {
    key: "web.spec.subagent_desc",
    ownerApp: "web",
    phase: 2,
    title: "Subagent description suggest",
    description: "Writes one subagent's description (plain text, no JSON).",
    requiredVars: ["who", "specContext"],
  },
  {
    key: "web.template.analyze",
    ownerApp: "web",
    phase: 2,
    title: "Template update — analyze impact",
    description: "Read-only: reports what a project-template update changes + affected files + risk.",
    requiredVars: ["localVersion", "latestVersion", "changelog"],
  },
  {
    key: "web.template.update",
    ownerApp: "web",
    phase: 2,
    title: "Template update — apply (branch + PR)",
    description: "Agent-write: applies the template update on a branch + opens a PR. Keep the branch/PR steps + the final JSON status block.",
    requiredVars: ["latestVersion", "branch", "baseRef", "changelog"],
  },
  {
    key: "web.checklist.eval",
    ownerApp: "web",
    phase: 2,
    title: "Checklist evaluate",
    description: "Read-only: verdict (pass/fail/skip/na) per checklist item vs content. Keep the one-line-per-item reply format.",
    requiredVars: ["contextLabel", "name", "lines", "contextText"],
  },
  {
    key: "web.checklist.author",
    ownerApp: "web",
    phase: 2,
    title: "Checklist authoring",
    description: "Proposes the full checklist item list from an instruction + current items. Keep the JSON array output shape.",
    requiredVars: ["current", "instruction"],
  },
  {
    key: "web.memo.compose",
    ownerApp: "web",
    phase: 2,
    title: "Memo → community post",
    description: "Turns a teammate's notes (with [Image#N] tokens) into one forum post. Keep the fenced JSON {title,body} output.",
    requiredVars: ["notes"],
  },
  {
    key: "web.verify",
    ownerApp: "web",
    phase: 2,
    title: "AI Verify (book entries)",
    description: "Read-only: answers a question per selected book entry. Keep the one-line-per-entry reply format.",
    requiredVars: ["verifyBook", "entries", "question"],
  },
  {
    key: "web.git.resolve",
    ownerApp: "web",
    phase: 2,
    title: "Git — resolve conflicts",
    description: "Agent: resolves merge conflicts + stages (no commit).",
    requiredVars: ["repoScope"],
  },
];

/**
 * The server-managed prompt catalog, keyed by `key` — metadata + its default template. The DB is
 * seeded fill-only from these defaults (ADR-0381).
 */
export const AI_PROMPTS: Readonly<Record<string, PromptDef>> = Object.fromEntries(
  PROMPT_META.map((m) => [m.key, { ...m, defaultTemplate: DEFAULTS[m.key] ?? "" }]),
);

/** All catalog keys (stable order). */
export function listPromptKeys(): string[] {
  return PROMPT_META.map((m) => m.key);
}

/** Look up a prompt definition by key, or `undefined` if the key is not in the catalog. */
export function getPromptDef(key: string): PromptDef | undefined {
  return AI_PROMPTS[key];
}
