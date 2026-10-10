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
import { wrapUntrusted, type UntrustedKind } from "./untrusted-content";

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
  /**
   * Variables carrying third-party text (ADR-0421) and how the model must treat them — wrapped by
   * {@link renderCatalogPrompt} before substitution. **Required on every entry** (`{}` when none), so a
   * new prompt must decide; admin template edits cannot drop the marking.
   */
  untrustedVars: Readonly<Record<string, UntrustedKind>>;
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

/**
 * Render a catalog prompt (ADR-0421): wrap each non-empty value the entry's `untrustedVars` names with
 * {@link wrapUntrusted} (source `<key>.<var>`), then substitute with {@link renderPrompt}. Every
 * resolver (web / cli / server) renders through this, so the marking holds for admin overrides too.
 * An unknown key renders as plain {@link renderPrompt}.
 */
export function renderCatalogPrompt(key: string, template: string, vars: Record<string, string | number>): string {
  const untrusted = AI_PROMPTS[key]?.untrustedVars ?? {};
  const wrapped: Record<string, string | number> = { ...vars };
  for (const [name, kind] of Object.entries(untrusted)) {
    const value = vars[name];
    if (typeof value === "string" && value.trim()) {
      wrapped[name] = wrapUntrusted(value, { kind, source: `${key}.${name}` });
    }
  }
  return renderPrompt(template, wrapped);
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
    untrustedVars: { focusExtra: "request" },
  },
  {
    key: "cli.research.policy",
    ownerApp: "cli",
    phase: 1,
    title: "AI Research — system policy",
    description: "System instruction + content policy prepended to an org Research question.",
    requiredVars: ["question"],
    untrustedVars: { question: "request" },
  },
  {
    key: "cli.memory.compact",
    ownerApp: "cli",
    phase: 1,
    title: "Console memory compaction",
    description: "Merges the latest exchange into the rolling per-project AI memory, budget-bounded.",
    requiredVars: ["budgetChars", "oldMemory", "prompt", "answer"],
    untrustedVars: { oldMemory: "data", prompt: "data", answer: "data" },
  },
  {
    key: "cli.support.answer",
    ownerApp: "cli",
    phase: 1,
    title: "AI Help — support answer",
    description: "Answers a user/admin product question from the KB docs, with the inline moderation JSON contract. Edit with care: the response must stay a single JSON object with onTopic/sensitive/reason/answer.",
    requiredVars: ["roleNote", "docs", "question"],
    untrustedVars: { question: "request" },
  },
  {
    key: "cli.support.reply_draft",
    ownerApp: "cli",
    phase: 1,
    title: "Admin draft — ticket reply",
    description: "Drafts a support-team reply to a ticket (freeform markdown).",
    requiredVars: ["docs", "context"],
    untrustedVars: {},
  },
  {
    key: "cli.support.outreach_draft",
    ownerApp: "cli",
    phase: 1,
    title: "Admin draft — outreach message",
    description: "Drafts an outreach message to customer orgs (freeform markdown).",
    requiredVars: ["docs", "context"],
    untrustedVars: {},
  },
  {
    key: "cli.support.legal_draft",
    ownerApp: "cli",
    phase: 1,
    title: "Admin draft — legal document body",
    description: "Drafts/revises a legal document body in a locale, keeping legal {{placeholders}} verbatim.",
    requiredVars: ["docs", "context"],
    untrustedVars: {},
  },
  {
    key: "cli.faq.compose",
    ownerApp: "cli",
    phase: 1,
    title: "Ticket → FAQ synthesis",
    description: "Agent-write run that distils resolved tickets into FAQ markdown + a per-ticket JSON summary. Keep the required JSON output block and the {{ticketJsonSkeleton}} intact.",
    requiredVars: ["transcript", "ticketJsonSkeleton"],
    untrustedVars: { transcript: "data" },
  },
  {
    key: "cli.scaffold.readme",
    ownerApp: "cli",
    phase: 1,
    title: "Scaffold — README author",
    description: "Writes the initial README.md for a new project from its spec JSON (on project create).",
    requiredVars: ["specJson"],
    untrustedVars: { specJson: "data" },
  },
  {
    key: "cli.scaffold.guide",
    ownerApp: "cli",
    phase: 1,
    title: "Scaffold — agent guide author",
    description: "Writes the project's CLAUDE.md / AGENT.md guide from its spec JSON (on project create); includes the mandatory AI_SECURITY.md reference.",
    requiredVars: ["guideFile", "specJson"],
    untrustedVars: { specJson: "data", guideInstructionsBlock: "request" },
  },
  {
    key: "cli.scaffold.security",
    ownerApp: "cli",
    phase: 1,
    title: "Scaffold — AI security policy author",
    description: "Writes the project's AI_SECURITY.md security policy from its spec JSON (on project create); the static project-sample file is the fallback when the AI is unavailable.",
    requiredVars: ["specJson"],
    untrustedVars: { specJson: "data" },
  },
  {
    key: "cli.autonomous.intake",
    ownerApp: "cli",
    phase: 1,
    title: "Autonomous — intake",
    description:
      "Analyses approved user requests + answered intake questions into sized AI tasks, and writes UI mockups to the mockup folder (ADR-0418) — books + mockups only; no git/code.",
    requiredVars: ["booksIntro", "sMaxFiles", "sMaxLines", "mMaxFiles", "mMaxLines"],
    untrustedVars: {},
  },
  {
    key: "cli.autonomous.implement",
    ownerApp: "cli",
    phase: 1,
    title: "Autonomous — implement",
    description: "Implements exactly one task on the prepared branches (commit only). Keep the final JSON status block intact.",
    requiredVars: ["taskId", "desc", "branch", "subLines"],
    untrustedVars: { desc: "request", notes: "request" },
  },
  {
    key: "cli.autonomous.split",
    ownerApp: "cli",
    phase: 1,
    title: "Autonomous — split",
    description: "Read-only: proposes smaller child tasks when a task repeatedly fails. Keep the final JSON children block intact.",
    requiredVars: ["taskId", "desc", "reasons", "branch", "diff"],
    untrustedVars: { desc: "request", notes: "request", reasons: "data", diff: "data" },
  },
  {
    key: "web.generators",
    ownerApp: "web",
    phase: 2,
    title: "Content generator",
    description: "Produces a report / estimation / WBS / proposal / feasibility Markdown document from the project spec.",
    requiredVars: ["what", "specContext"],
    untrustedVars: { paramsBlock: "request", specContext: "data" },
  },
  {
    key: "web.guide",
    ownerApp: "web",
    phase: 2,
    title: "AI guide (CLAUDE.md / AGENT.md)",
    description: "Writes/refines the project's agent-guide file from the spec. Keep the mandatory AI_SECURITY.md section.",
    requiredVars: ["file", "specContext"],
    untrustedVars: { baseBlock: "request", extraBlock: "request", specContext: "data" },
  },
  {
    key: "web.draft_tasks",
    ownerApp: "web",
    phase: 2,
    title: "Draft tasks from spec",
    description: "Breaks the spec into a JSON array of engineering tasks. Keep the required JSON array output shape.",
    requiredVars: ["specContext"],
    untrustedVars: { specContext: "data" },
  },
  {
    key: "web.spec.review",
    ownerApp: "web",
    phase: 2,
    title: "Spec review (advisory)",
    description: "Advises on the whole spec in the fixed ASSESSMENT/ISSUES format (no rewrite). Keep that reply format.",
    requiredVars: ["specContext"],
    untrustedVars: { specContext: "data" },
  },
  {
    key: "web.spec.compose",
    ownerApp: "web",
    phase: 2,
    title: "Spec compose (gates create)",
    description: "Revises the spec with minimal edits + judges readiness. GATES project creation — keep the exact JSON object shape (changes/tree/ok/assessment/blockers).",
    requiredVars: ["specContext"],
    untrustedVars: { specContext: "data" },
  },
  {
    key: "web.spec.suggest",
    ownerApp: "web",
    phase: 2,
    title: "Spec field suggest (✨)",
    description: "Suggests a value for one spec field. {{shape}} carries the reply-format rule the parser depends on.",
    requiredVars: ["target", "shape", "specContext"],
    untrustedVars: { seed: "data", instructionBlock: "request", specContext: "data" },
  },
  {
    key: "web.spec.group_suggest",
    ownerApp: "web",
    phase: 2,
    title: "Spec section suggest",
    description: "Suggests values for a whole wizard section. Keep the single-line JSON object (field id → value) output shape.",
    requiredVars: ["groupKey", "fieldLines", "specContext"],
    untrustedVars: { instructionBlock: "request", specContext: "data" },
  },
  {
    key: "web.spec.subagents_suggest",
    ownerApp: "web",
    phase: 2,
    title: "Subagents suggest",
    description: "Proposes the project's AI subagents. Keep the JSON array of {name,description} output shape.",
    requiredVars: ["current", "specContext"],
    untrustedVars: { current: "data", instructionBlock: "request", specContext: "data" },
  },
  {
    key: "web.spec.subagent_desc",
    ownerApp: "web",
    phase: 2,
    title: "Subagent description suggest",
    description: "Writes one subagent's description (plain text, no JSON).",
    requiredVars: ["who", "specContext"],
    untrustedVars: { seed: "data", instructionBlock: "request", specContext: "data" },
  },
  {
    key: "web.template.analyze",
    ownerApp: "web",
    phase: 2,
    title: "Template update — analyze impact",
    description: "Read-only: reports what a project-template update changes + affected files + risk.",
    requiredVars: ["localVersion", "latestVersion", "changelog"],
    untrustedVars: { changelog: "data", extras: "request" },
  },
  {
    key: "web.template.update",
    ownerApp: "web",
    phase: 2,
    title: "Template update — apply (branch + PR)",
    description: "Agent-write: applies the template update on a branch + opens a PR. Keep the branch/PR steps + the final JSON status block.",
    requiredVars: ["latestVersion", "branch", "baseRef", "changelog"],
    untrustedVars: { changelog: "data", extras: "request" },
  },
  {
    key: "web.checklist.eval",
    ownerApp: "web",
    phase: 2,
    title: "Checklist evaluate",
    description: "Read-only: verdict (pass/fail/skip/na) per checklist item vs content. Keep the one-line-per-item reply format.",
    requiredVars: ["contextLabel", "name", "lines", "contextText"],
    untrustedVars: { lines: "data", contextText: "data" },
  },
  {
    key: "web.checklist.author",
    ownerApp: "web",
    phase: 2,
    title: "Checklist authoring",
    description: "Proposes the full checklist item list from an instruction + current items. Keep the JSON array output shape.",
    requiredVars: ["current", "instruction"],
    untrustedVars: { current: "data", instruction: "request" },
  },
  {
    key: "web.memo.compose",
    ownerApp: "web",
    phase: 2,
    title: "Memo → community post",
    description: "Turns a teammate's notes (with [Image#N] tokens) into one forum post. Keep the fenced JSON {title,body} output.",
    requiredVars: ["notes"],
    untrustedVars: { notes: "data" },
  },
  {
    key: "web.verify",
    ownerApp: "web",
    phase: 2,
    title: "AI Verify (book entries)",
    description: "Read-only: answers a question per selected book entry. Keep the one-line-per-entry reply format.",
    requiredVars: ["verifyBook", "entries", "question"],
    untrustedVars: { entries: "data", question: "request" },
  },
  {
    key: "web.verifyDone",
    ownerApp: "web",
    phase: 2,
    title: "AI Verify (AI Done + follow-ups)",
    description:
      "Read-only: verdict per completed task + optional follow-up proposals (ADR-0400). Keep the `[<ID>]` verdict and `FOLLOWUP [<ID>]` line formats.",
    requiredVars: ["entries", "question"],
    untrustedVars: { entries: "data", question: "request" },
  },
  {
    key: "web.bookGenerate.aiTodo",
    ownerApp: "web",
    phase: 2,
    title: "AI generate — AI_TODO tasks",
    description:
      "Read-only: drafts AI_TODO engineering tasks from the user's description (ADR-0408). Keep the JSON array output shape ({key, priority, group, depends, description, notes}).",
    requiredVars: ["entries", "description"],
    untrustedVars: { entries: "data", description: "request" },
  },
  {
    key: "web.bookGenerate.userTodo",
    ownerApp: "web",
    phase: 2,
    title: "AI generate — USER_TODO requests",
    description:
      "Read-only: drafts USER_TODO requests from the user's description (ADR-0408). Keep the JSON array output shape ({key, group, depends, request}).",
    requiredVars: ["entries", "description"],
    untrustedVars: { entries: "data", description: "request" },
  },
  {
    key: "web.bookGenerate.userQa",
    ownerApp: "web",
    phase: 2,
    title: "AI generate — USER_QA questions",
    description:
      "Read-only: drafts USER_QA questions from the user's description (ADR-0408). Keep the JSON array output shape ({key, group, depends, original, question}).",
    requiredVars: ["entries", "description"],
    untrustedVars: { entries: "data", description: "request" },
  },
  {
    key: "web.bookEdit.aiTodo",
    ownerApp: "web",
    phase: 2,
    title: "AI edit — AI_TODO tasks",
    description:
      "Read-only: rewrites the selected AI_TODO tasks from the user's instruction (ADR-0417). Keep the JSON array output shape ({id, priority, group, depends, description, notes}).",
    requiredVars: ["entries", "context", "instruction"],
    untrustedVars: { entries: "data", context: "data", instruction: "request" },
  },
  {
    key: "web.bookEdit.userTodo",
    ownerApp: "web",
    phase: 2,
    title: "AI edit — USER_TODO requests",
    description:
      "Read-only: rewrites the selected USER_TODO requests from the user's instruction (ADR-0417). Keep the JSON array output shape ({id, group, depends, request}).",
    requiredVars: ["entries", "context", "instruction"],
    untrustedVars: { entries: "data", context: "data", instruction: "request" },
  },
  {
    key: "web.bookEdit.userQa",
    ownerApp: "web",
    phase: 2,
    title: "AI edit — USER_QA questions",
    description:
      "Read-only: rewrites the selected USER_QA questions from the user's instruction (ADR-0417). Keep the JSON array output shape ({id, group, depends, original, question}).",
    requiredVars: ["entries", "context", "instruction"],
    untrustedVars: { entries: "data", context: "data", instruction: "request" },
  },
  {
    key: "web.bookVerifyLogic.aiTodo",
    ownerApp: "web",
    phase: 2,
    title: "AI verify book — AI_TODO structure",
    description:
      "Read-only: checks Group / Depends / Priority of every AI_TODO task against its content (ADR-0417). Keep the JSON array output shape ({id, issue, group, depends, priority}).",
    requiredVars: ["entries", "focus"],
    untrustedVars: { entries: "data", focus: "request" },
  },
  {
    key: "web.bookVerifyLogic.userTodo",
    ownerApp: "web",
    phase: 2,
    title: "AI verify book — USER_TODO structure",
    description:
      "Read-only: checks Group / Depends of every USER_TODO request against its content (ADR-0417). Keep the JSON array output shape ({id, issue, group, depends}).",
    requiredVars: ["entries", "focus"],
    untrustedVars: { entries: "data", focus: "request" },
  },
  {
    key: "web.bookVerifyLogic.userQa",
    ownerApp: "web",
    phase: 2,
    title: "AI verify book — USER_QA structure",
    description:
      "Read-only: checks Group / Depends of every USER_QA question against its content (ADR-0417). Keep the JSON array output shape ({id, issue, group, depends}).",
    requiredVars: ["entries", "focus"],
    untrustedVars: { entries: "data", focus: "request" },
  },
  {
    key: "web.git.resolve",
    ownerApp: "web",
    phase: 2,
    title: "Git — resolve conflicts",
    description: "Agent: resolves merge conflicts + stages (no commit).",
    requiredVars: ["repoScope"],
    untrustedVars: {},
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
