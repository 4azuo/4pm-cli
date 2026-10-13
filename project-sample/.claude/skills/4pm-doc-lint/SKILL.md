---
name: 4pm-doc-lint
description: Check and fix the project's documents against the 4PM Doc Header standard (YAML frontmatter with id, kind, title, parent, refs) and code file headers. Use when writing or editing a doc, when asked to classify, link or restructure docs, or before finishing a task that changed docs.
---

# 4PM doc lint

Every Markdown document in this project starts with a **4PM Doc Header** — YAML frontmatter that
classifies it and links it to other documents. The 4PM dashboard builds its Graph, Tree, depth score and
search filters from these headers, so a doc without one is invisible to them.

## The Doc Header

```yaml
---
id: api.project-0041          # <kind>.<slug> — unique, lower-case, [a-z0-9.-]
kind: api                     # one of the kinds below
title: Pause a project        # the human name
feature: [project-lifecycle]  # optional feature tags (search across kinds)
parent: arch.0043             # optional — the doc this one sits under (hierarchy)
refs:                         # optional typed links to other ids
  implements: [adr.0092]
  uses: [api.project-0040]
status: approved              # optional — draft | approved | deprecated
---
```

- Required: `id`, `kind`, `title`.
- Kinds: `req` (requirement / user story) · `adr` · `arch` · `flow` (business flow) · `api` · `page`
  (screen) · `component` · `data` (schema / ER) · `guide` · `test` · `report` · `other`. A project may add
  kinds in `project.settings.json` → `docs.kinds`.
- `refs` keys: `implements` · `uses` · `extends` · `supersedes` · `tests` · `related`.
- `er.<ENTITY>` (e.g. `uses: [er.ORDER]`) links a doc to an ER entity.
- Keep the tree shallow: depth (steps to the root through `parent`) should stay within
  `docs.maxDepth` (default 3). Attach tests and details to the flow / API they belong to, not under a
  long chain.
- Plain YAML only — no anchors (`&`), aliases (`*`), tags (`!`) or multi-line `|` / `>` blocks.

## Code file headers

Source files start with a header comment that names their role and the docs they implement:

```ts
/**
 * Pause/resume project lifecycle.
 * @kind service  @feature project-lifecycle
 * @api project-0041 @adr 0092 @er ORDER
 */
```

Code kinds: `entry` · `route` · `service` · `component` · `model` · `util` · `test` · `config` · `other`.
`@api x` links to the doc with id `api.x` (same for `@adr`, `@arch`, `@page`, `@flow`, `@req`, …).

## Run the check

From the project root (the script needs only Node, no network, writes nothing):

```bash
node .claude/skills/4pm-doc-lint/doc-lint.mjs              # docs
node .claude/skills/4pm-doc-lint/doc-lint.mjs --mode all   # docs + code + code→doc links
node .claude/skills/4pm-doc-lint/doc-lint.mjs --json       # machine-readable
```

(With Codex the folder is `.agents/skills/4pm-doc-lint/`.) Exit code 1 means at least one error.

| Rule | Fix |
| --- | --- |
| `header-missing` | Add a Doc Header; pick the kind from the content. |
| `header-invalid` | Fix the YAML or add the missing `id` / `kind` / `title`. |
| `kind-unknown` | Use a standard kind, or add it to `docs.kinds`. |
| `id-duplicate` | Give one of the docs a new id and update refs to it. |
| `ref-broken` | Point `parent` / `refs` / the link at an existing id or file, or create that doc. |
| `parent-cycle` | Break the loop — one doc of the chain must be the parent of the others. |
| `orphan` | Link the doc from its natural parent or a related doc, or set its `parent`. |
| `too-deep` | Re-parent the doc higher up (usually to the flow / API it belongs to). |
| `code-header-missing` | Add the header comment with `@kind` (and the doc tags it implements). |

## When editing docs

1. Keep or add the Doc Header on every doc you create or touch.
2. Choose `parent` so the doc sits next to its siblings; prefer typed `refs` over loose links.
3. Run the check and fix every **error** before you finish; mention remaining warnings.
4. Never invent ids: a ref must name a doc that exists (or one you create in the same change).
