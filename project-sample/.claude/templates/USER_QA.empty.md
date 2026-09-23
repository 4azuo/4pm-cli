# USER_QA — Questions & answers

> When a request is unclear, the AI adds a **row** here (instead of guessing) with an
> **ID `QA-{groupid:0000}-{qaid:0000}`**: the original request and what's unclear + options, leaving the
> `Answer` blank. You fill the `Answer`; the autonomous cycle folds it back into a re-analysis **only after
> the row is approved**. Approval + authorship (who answered / who approved, with dates) live in JSON
> sidecars, not in this table (ADR-0320): `.claude/.autonomous.approvals.json` +
> `.claude/.autonomous.authors.json` — the web USER_QA grid shows them and enforces four-eyes (the person
> who answered can't approve their own answer, except ADMIN). See `.claude/templates/USER_QA.sample.md`.
>
> **Columns (content only):** `ID` · `Group` · `Depends` (comma-separated `QA-…`) · `Original request` ·
> `Question / options` · `Answer`.

| ID | Group | Depends | Original request | Question / options | Answer |
|----|-------|---------|------------------|--------------------|--------|
| | | | | | |
