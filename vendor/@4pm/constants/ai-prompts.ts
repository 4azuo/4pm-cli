/**
 * AI prompt catalog registry — the single, framework-free source of truth for every
 * **server-managed** pre-written prompt. Shared by `@4pm/server` (seed default + the
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
 * @adr 0381 @arch 0047
 */
import defaultTemplates from "./ai-prompt-defaults.json";
import { wrapUntrusted, type UntrustedKind } from "./untrusted-content";
import { withOutputLanguage, type RepoOutputKind } from "./output-language";

/** The seed/fallback template per prompt key (from `ai-prompt-defaults.json`). */
const DEFAULTS = defaultTemplates as Record<string, string>;

/** Which app builds + dispatches the prompt. */
export type PromptOwnerApp = "server" | "cli" | "web";

/** Rollout phase: `1` = server/cli (DB-managed now), `2` = web (deferred). */
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
   * Variables carrying third-party text and how the model must treat them — wrapped by
   * {@link renderCatalogPrompt} before substitution. **Required on every entry** (`{}` when none), so a
   * new prompt must decide; admin template edits cannot drop the marking.
   * @adr 0421
   */
  untrustedVars: Readonly<Record<string, UntrustedKind>>;
  /**
   * The prompt's output lands in the project repo (docs, code, commits, book rows): a set project output language
   * appends its directive ({@link renderCatalogPrompt}); `"guide"` also asks for the guide-file line.
   * @adr 0581
   */
  repoOutput?: RepoOutputKind;
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

/** Per-render options of {@link renderCatalogPrompt}. */
export interface RenderCatalogOptions {
  /** The project's output language (spec `output_lang`); unset ⇒ no directive. @adr 0581 */
  outputLang?: string | null;
}

/**
 * Render a catalog prompt: wrap each non-empty value the entry's `untrustedVars` names with
 * {@link wrapUntrusted} (source `<key>.<var>`), then substitute with {@link renderPrompt}. Every
 * resolver (web / cli / server) renders through this, so the marking holds for admin overrides too.
 * An unknown key renders as plain {@link renderPrompt}.
 * @adr 0421
 */
export function renderCatalogPrompt(
  key: string,
  template: string,
  vars: Record<string, string | number>,
  opts: RenderCatalogOptions = {},
): string {
  const untrusted = AI_PROMPTS[key]?.untrustedVars ?? {};
  const wrapped: Record<string, string | number> = { ...vars };
  for (const [name, kind] of Object.entries(untrusted)) {
    const value = vars[name];
    if (typeof value === "string" && value.trim()) {
      wrapped[name] = wrapUntrusted(value, { kind, source: `${key}.${name}` });
    }
  }
  const rendered = renderPrompt(template, wrapped);
  // The project output language rides after the (possibly admin-overridden) template (ADR-0581).
  const repoOutput = AI_PROMPTS[key]?.repoOutput;
  return repoOutput ? withOutputLanguage(rendered, opts.outputLang, repoOutput) : rendered;
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
    key: "cli.support.hub_review",
    ownerApp: "cli",
    phase: 1,
    title: "Admin — hub item moderation advice",
    description: "Reviews a public hub item (package / knowledge / 4rum post) and outputs a JSON verdict (allow/block/unsure) with a summary, reasons and categories. Advice only — keep the JSON output contract intact.",
    requiredVars: ["context"],
    untrustedVars: { context: "data" },
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
    key: "cli.scaffold.evidenceGuide",
    ownerApp: "cli",
    phase: 1,
    title: "Scaffold — evidence guide author",
    description:
      "Writes the project's EVIDENCE_GUIDE.md (how the analysis evidences — mockups, sequence diagrams, ER, system diagram, task evidence — should look) from its spec JSON on project create (ADR-0532). Keep the six fixed section headings.",
    requiredVars: ["specJson"],
    untrustedVars: { specJson: "data", instructionsBlock: "request" },
  },
  {
    key: "cli.autonomous.intake",
    ownerApp: "cli",
    phase: 1,
    title: "Autonomous — intake",
    description:
      "Analyses ONE approved request (or answered intake question) on its own branch into sized AI tasks, and writes UI mockups (ADR-0418), sequence diagrams and ER change requests (ADR-0453) and system-diagram change requests (ADR-0530), following the project evidence guide (ADR-0532). Its context — books, discussions, ER, diagram, evidence guide — is read from the working tree, never pasted in (ADR-0563), starting from the run's context manifest `.4pm/context/<ID>.md` (ADR-0565); books + mockups + sequences + change requests only; no git/code.",
    requiredVars: ["booksIntro", "groupIds", "sMaxFiles", "sMaxLines", "mMaxFiles", "mMaxLines"],
    // Every repo text the agent reads (books, discussions, evidence guide) is named as data by the prompt itself (ADR-0563).
    untrustedVars: {},
  },
  {
    key: "cli.autonomous.implement",
    ownerApp: "cli",
    phase: 1,
    title: "Autonomous — implement",
    description:
      "Implements exactly one task on the prepared branches (commit only); may add an ER change request (ADR-0453). Its context — mockups, sequence, ER, diagram, answers, discussions, accepted docs, evidence guide — is read from the working tree (ADR-0563), starting from the run's context manifest (ADR-0565). Keep the final JSON status block intact.",
    requiredVars: ["taskId", "desc", "branch", "subLines"],
    untrustedVars: { desc: "request", notes: "request", previousTask: "request", conflictPaths: "data" },
  },
  {
    key: "cli.autonomous.docs",
    ownerApp: "cli",
    phase: 1,
    title: "Autonomous — docs round",
    description:
      "Writes / updates the project documentation of ONE request on its DOC branch, following the spec's doc types and docs organization (ADR-0536) and the mirrored doc templates `.4pm/doc-templates/` (ADR-0564): new numbered files named `NEW-<n>-<slug>.md` (the cli numbers them), the review opinions of earlier rounds applied, evidences updated only when a review asks; context from the run's manifest (ADR-0565). Docs only — no application code. Keep the final JSON status block intact.",
    requiredVars: ["docId", "group", "round", "request", "docTypes", "branch"],
    // The request / notes / review opinions are people's text; the docs organization and evidence guide are repo text.
    untrustedVars: { request: "request", desc: "request", notes: "request", reviewNote: "request", docsOrg: "data" },
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
    key: "cli.autonomous.fixDiagram",
    ownerApp: "cli",
    phase: 1,
    title: "Autonomous — fix a sequence diagram",
    description:
      "One-shot (no tools): given ONE sequence diagram Mermaid's parser rejected (written by an intake or returned with a question) and the parse error, returns the diagram with only its syntax fixed (ADR-0580). The cli parses the reply again before writing it. Keep the reply a single mermaid block.",
    requiredVars: ["file", "diagram", "error"],
    // `file` is a cli-built `<sequenceDir>/<ID>.md` path; the diagram and its parse error are AI-written text.
    untrustedVars: { diagram: "data", error: "data" },
  },
  {
    key: "cli.git.prResolve",
    ownerApp: "cli",
    phase: 1,
    title: "Git — resolve a pull request's conflicts",
    description:
      "Resolves the conflicts left by merging the target branch into a pull request's head branch, then commits the merge (the cli pushes it). Keep the final JSON status block intact.",
    requiredVars: ["number", "head", "base", "conflictPaths"],
    untrustedVars: { title: "data", conflictPaths: "data" },
  },
  {
    key: "server.automation.custom",
    ownerApp: "server",
    phase: 2,
    title: "Rule action — custom prompt",
    description: "A rule's own read-only instruction, run on the project's worker with the triggering event as data.",
    requiredVars: ["instruction", "eventJson"],
    untrustedVars: { eventJson: "data" },
  },
  {
    key: "server.automation.checklist",
    ownerApp: "server",
    phase: 2,
    title: "Rule action — run a checklist with AI",
    description: "Read-only evaluation of a checklist's items against the event's subject. Keep the final JSON results block intact.",
    requiredVars: ["checklistName", "items", "subject", "eventJson"],
    untrustedVars: { eventJson: "data" },
  },
  {
    key: "server.generators",
    ownerApp: "server",
    phase: 1,
    title: "Document generator (doc types)",
    description: "Produces a Markdown document of one doc type from the project spec: the type's instructions, the chosen template and the declared params. Keep the Markdown-only output rule.",
    requiredVars: ["what", "instructions", "specContext"],
    untrustedVars: { specContext: "data", templateBlock: "data", paramsBlock: "request" },
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
    key: "web.evidenceGuide",
    ownerApp: "web",
    phase: 2,
    title: "Evidence guide (EVIDENCE_GUIDE.md)",
    description:
      "Writes/refines the project's evidence guide from the spec and the user's description (ADR-0532). Keep the six fixed section headings; output the whole Markdown document only.",
    requiredVars: ["specContext"],
    untrustedVars: { baseBlock: "request", extraBlock: "request", specContext: "data" },
  },
  {
    key: "web.ciWorkflowGenerate",
    ownerApp: "web",
    phase: 2,
    title: "CI/CD workflow generate (GitHub Actions / GitLab CI)",
    description:
      "Read-only agent: reads the repo, writes the workflow YAML for the request, lints it (actionlint / glab ci lint) and returns it in a <ci-workflows> JSON block for the user to review and save as a PR (ADR-0606/0607). It never edits or pushes.",
    requiredVars: ["provider", "kind", "request", "existing"],
    untrustedVars: { request: "request", existing: "data" },
  },
  {
    key: "web.evidenceGuideSection",
    ownerApp: "web",
    phase: 2,
    title: "Evidence guide — one section",
    description: "Rewrites ONE section of EVIDENCE_GUIDE.md from the user's description (ADR-0532); returns the section body only, without its heading.",
    requiredVars: ["section", "specContext"],
    untrustedVars: { current: "request", guide: "data", extraBlock: "request", specContext: "data" },
  },
  {
    key: "web.guideAdapt",
    ownerApp: "web",
    phase: 2,
    title: "Adapt a marketplace guide (CLAUDE.md / AGENT.md)",
    description:
      "Read-only agent: rewrites the project's guide file to absorb a marketplace guide package, fitted to this repo. Keep the full-document output and the AI_SECURITY.md section.",
    requiredVars: ["file", "packageName", "guideText"],
    untrustedVars: { guideText: "data", packageDescription: "data", currentBlock: "data", extraBlock: "request" },
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
      "Read-only: drafts AI_TODO engineering tasks from the user's description (ADR-0408). Keep the JSON array output shape ({key, title, priority, group, depends, description, notes}).",
    requiredVars: ["entries", "description"],
    untrustedVars: { entries: "data", description: "request" },
  },
  {
    key: "web.bookGenerate.userTodo",
    ownerApp: "web",
    phase: 2,
    title: "AI generate — USER_TODO requests",
    description:
      "Read-only: drafts USER_TODO requests from the user's description (ADR-0408). Keep the JSON array output shape ({key, title, group, depends, request}).",
    requiredVars: ["entries", "description"],
    untrustedVars: { entries: "data", description: "request" },
  },
  {
    key: "web.bookGenerate.userQa",
    ownerApp: "web",
    phase: 2,
    title: "AI generate — USER_QA questions",
    description:
      "Read-only: drafts USER_QA questions from the user's description (ADR-0408). Keep the JSON array output shape ({key, title, group, depends, original, question}).",
    requiredVars: ["entries", "description"],
    untrustedVars: { entries: "data", description: "request" },
  },
  {
    key: "web.bookEdit.aiTodo",
    ownerApp: "web",
    phase: 2,
    title: "AI edit — AI_TODO tasks",
    description:
      "Read-only: rewrites the selected AI_TODO tasks from the user's instruction (ADR-0417). Keep the JSON array output shape ({id, title, priority, group, depends, description, notes}).",
    requiredVars: ["entries", "context", "instruction"],
    untrustedVars: { entries: "data", context: "data", instruction: "request" },
  },
  {
    key: "web.bookEdit.userTodo",
    ownerApp: "web",
    phase: 2,
    title: "AI edit — USER_TODO requests",
    description:
      "Read-only: rewrites the selected USER_TODO requests from the user's instruction (ADR-0417). Keep the JSON array output shape ({id, title, group, depends, request}).",
    requiredVars: ["entries", "context", "instruction"],
    untrustedVars: { entries: "data", context: "data", instruction: "request" },
  },
  {
    key: "web.bookEdit.userQa",
    ownerApp: "web",
    phase: 2,
    title: "AI edit — USER_QA questions",
    description:
      "Read-only: rewrites the selected USER_QA questions from the user's instruction (ADR-0417). Keep the JSON array output shape ({id, title, group, depends, original, question}).",
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
    key: "web.bookDependsSuggest",
    ownerApp: "web",
    phase: 2,
    title: "AI suggest dependencies (draft)",
    description:
      "Read-only: proposes the Depends of the target rows from every book (USER_TODO, AI_TODO, USER_QA, recent AI_DONE) — written into the grid draft for review, never saved (ADR-0613). Keep the JSON array output shape ({id, depends[], reason}).",
    requiredVars: ["targets", "books"],
    untrustedVars: { targets: "data", books: "data" },
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
  {
    key: "web.graph.review",
    ownerApp: "web",
    phase: 2,
    title: "Graph — AI structure review",
    description:
      "Read-only review of the docs/code structure from the deterministic metrics, lint issues and a tree outline (ADR-0488). Keep the Markdown sections.",
    requiredVars: ["mode", "metrics", "issues", "outline"],
    untrustedVars: { issues: "data", outline: "data" },
  },
  {
    key: "web.rag.docFind",
    ownerApp: "web",
    phase: 2,
    title: "RAG — AI doc finder",
    description:
      "Read-only agent: reads the repo and lists the documents to read for a question (ADR-0489). Keep the fenced JSON {summary, docs[{path, why, priority}]} output.",
    requiredVars: ["question", "hints"],
    untrustedVars: { question: "request", hints: "data" },
  },
  {
    key: "web.er.draft",
    ownerApp: "web",
    phase: 2,
    title: "ER — AI draft",
    description:
      "Read-only agent: drafts the project data model (module erDiagrams) from the schema in the code (ADR-0491). Keep the fenced JSON {title, rationale, modules[{name, description, diagram}]} output.",
    requiredVars: ["existing"],
    untrustedVars: { existing: "data" },
  },
  {
    key: "web.diagram.draft",
    ownerApp: "web",
    phase: 2,
    title: "System diagram — AI draft",
    description:
      "Read-only agent: drafts the project system diagram (module draw.io files: components + links) from the code (ADR-0530). Keep the fenced JSON {title, rationale, modules[{name, description, xml}]} output.",
    requiredVars: ["existing"],
    untrustedVars: { existing: "data" },
  },
];

/** Prompts whose output lands in the project repo — they carry the output-language directive. @adr 0581 */
const REPO_OUTPUT: Readonly<Record<string, RepoOutputKind>> = {
  "cli.scaffold.readme": true,
  "cli.scaffold.guide": "guide",
  "cli.scaffold.security": true,
  "cli.scaffold.evidenceGuide": true,
  "cli.autonomous.intake": true,
  "cli.autonomous.implement": true,
  "cli.autonomous.docs": true,
  "cli.autonomous.split": true,
  "cli.git.prResolve": true,
  "server.generators": true,
  "web.guide": "guide",
  "web.guideAdapt": "guide",
  "web.evidenceGuide": true,
  "web.evidenceGuideSection": true,
  "web.draft_tasks": true,
  "web.spec.compose": true,
  "web.spec.suggest": true,
  "web.spec.group_suggest": true,
  "web.spec.subagents_suggest": true,
  "web.spec.subagent_desc": true,
  "web.template.update": true,
  "web.verify": true,
  "web.verifyDone": true,
  "web.bookGenerate.aiTodo": true,
  "web.bookGenerate.userTodo": true,
  "web.bookGenerate.userQa": true,
  "web.bookEdit.aiTodo": true,
  "web.bookEdit.userTodo": true,
  "web.bookEdit.userQa": true,
  "web.git.resolve": true,
  "web.er.draft": true,
  "web.diagram.draft": true,
};

/**
 * The server-managed prompt catalog, keyed by `key` — metadata + its default template. The DB is
 * seeded fill-only from these defaults.
 */
export const AI_PROMPTS: Readonly<Record<string, PromptDef>> = Object.fromEntries(
  PROMPT_META.map((m) => [
    m.key,
    { ...m, ...(REPO_OUTPUT[m.key] ? { repoOutput: REPO_OUTPUT[m.key] } : {}), defaultTemplate: DEFAULTS[m.key] ?? "" },
  ]),
);

/** All catalog keys (stable order). */
export function listPromptKeys(): string[] {
  return PROMPT_META.map((m) => m.key);
}

/** Look up a prompt definition by key, or `undefined` if the key is not in the catalog. */
export function getPromptDef(key: string): PromptDef | undefined {
  return AI_PROMPTS[key];
}
