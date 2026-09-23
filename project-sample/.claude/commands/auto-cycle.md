---
description: (Retired — ADR-0319) The autonomous cycle now runs through the 4PM cli, not `claude -p /auto-cycle`.
---

# /auto-cycle — retired (ADR-0319)

The autonomous work cycle is **no longer** a `claude -p /auto-cycle` slash command. Under **ADR-0319**
it runs through the 4PM cli instead:

- The cron tick (`.claude/hooks/autonomous-tick.sh`) runs **`4pm auto-run`**, which asks the already
  running **`4pm start`** daemon to run **one** cycle through its live WS session — so the cycle reuses
  the cli's profile/quota failover (ADR-0182), token metering (ADR-0072), folder-scope guard (ADR-0181)
  and AI-run timeout (ADR-0243).
- The cycle **instructions** now live in the cli (`21-apps/31-cli/src/core/autonomous-cycle.ts` →
  `buildAutonomousCyclePrompt`), not in this file. In short: sync the primary repo's current branch →
  analyse **approved** `USER_TODO` requests into `AI_TODO` tasks (unclear ⇒ ask via `USER_QA`) → fold
  **approved** `USER_QA` answers back → take ONE approved task → implement + test on a `task/TSK-…`
  branch → open a **pull request** into the base branch (no direct merge) → update the books.

Approval is the source of truth in `.claude/.autonomous.approvals.json` (ADR-0152), keyed per row id
(`REQ-…` / `QA-…` / `TSK-…`), set from the web AI-content grids.

This file is kept only as a pointer; it is not executed.
