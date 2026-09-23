# USER_TODO — User requests

> Write what you want the AI to do (in the project's language — default English), **one request per row**.
> Each row has an **ID `REQ-{groupid:0000}-{reqid:0000}`** (group = one batch of related requests) used to
> approve it and to reference it from `Depends`. The autonomous cycle analyses a request into tasks in
> `AI_TODO.md` **only after the row is approved**. Approval + authorship are kept in JSON sidecars, not in
> this table (ADR-0320): `.claude/.autonomous.approvals.json` (who/when approved) and
> `.claude/.autonomous.authors.json` (who/when wrote the row) — the web USER_TODO grid shows them and
> enforces four-eyes (the writer can't approve their own row, except ADMIN). See
> `.claude/templates/USER_TODO.sample.md`.
>
> **Columns (content only):** `ID` · `Group` · `Depends` (comma-separated `REQ-…`) · `Request`.

| ID | Group | Depends | Request |
|----|-------|---------|---------|
| | | | |
