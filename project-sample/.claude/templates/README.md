# Autonomous book templates

Canonical templates for the 5 "book" files used by the autonomous loop. Each book has two templates:

- `<NAME>.empty.md` — the EMPTY state. The tick's "has work" gate + `/auto-cycle` compare a live book
  against this (equal ⇒ empty). When clearing/resetting a book, overwrite it with **exactly** this file
  (`cp .claude/templates/<NAME>.empty.md <NAME>`).
- `<NAME>.sample.md` — an example WITH DATA, showing the expected format when adding entries.

Books: `USER_TODO`, `AI_TODO`, `AI_PROGRESS`, `AI_DONE`, `USER_QA` (+ `AI_PLACEHOLDER`). Keep the
header/blockquote when filling a book in; match the sample's format.

All templates are written in English by default; the project's own docs/source language is decided by the
project `CLAUDE.md`.
