# AI_PROGRESS — Tasks in progress

> The tasks currently **claimed** by workers — **one row per claim** (ADR-0371). The 4PM cli writes this
> table on the base branch (commit + push = the claim; a lost push race means another worker won the task)
> and clears the row when the task finishes or is released. **Do not edit by hand** while a cycle runs.
> `Worker` = the claiming worker · `Claim` = a unique claim id · `Attempt` = which try this is (see
> `.claude/.autonomous.attempts.json`). A claim older than `claimTtlHours` (default 6) may be taken over.
> Per `.claude/templates/AI_PROGRESS.sample.md`.

| Started | ID | Worker | Claim | Attempt | Task description |
|---|---|---|---|---|---|
| | | | | | |
