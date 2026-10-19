# Autonomous book templates

Canonical templates of the 5 "book" files of the autonomous loop (+ `AI_PLACEHOLDER`), kept **inside the cli** (not
copied into projects — ADR-0563). The scaffold resets a new project's tracking files to the `<NAME>.empty.md` version
(`resetTrackingFiles`, ADR-0370 §3); `<NAME>.sample.md` shows the format with data.

Books: `USER_TODO`, `AI_TODO`, `AI_PROGRESS`, `AI_DONE`, `USER_QA` (+ `AI_PLACEHOLDER`). All templates are English; a
project's own language is decided by its `CLAUDE.md`.
