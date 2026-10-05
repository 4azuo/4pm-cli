# Autonomous mode — how it's assembled

> **Sample project — describes the workflow only; it does NOT run on its own.** Intended for an isolated
> environment (WSL / a per-project container) where the AI can be given full permissions.
>
> **ADR-0321: the autonomous LOGIC lives in the 4PM cli, not in this repo.** The project repo carries
> only the **data** books — never the algorithm or the schedule — so the logic can't be read from, or
> tampered with in, a checkout. **ADR-0392:** ticks come from the daemon's own in-process scheduler —
> no OS cron, no tick script, nothing to install. The **config** is not in the repo either: it lives in the
> **profile dir** (`~/.4pm/profiles/<name>/autonomous.config.json`) and is edited from the web
> **Autonomous → Settings** tab.

## The pieces
| Where | Role |
|-------|------|
| cli daemon scheduler | Fires on `cronSchedule` inside the running **`4pm start`** daemon (ADR-0392) and starts one cycle unless `paused`. |
| `4pm auto-run` (cli) | Optional manual trigger: asks the running daemon to run **one** cycle now over the control socket (token-authenticated — ADR-0320/0321). |
| cli daemon (`runAutonomousCycle`) | Owns **all** logic: reads `autonomous.config.json`; the gates (paused / quiet-hours / max-ticks / **has-work** / **quota**); run histories + auto-pause; serialize one cycle at a time; model; usage via the live snapshot (ADR-0072). Runs the cycle as a write-capable agent (bypass — ADR-0271: branch + PR). |
| `~/.4pm/profiles/<name>/autonomous.config.json` | The config knobs (paused, cronSchedule, quietHours, maxTicksPerDay, stopOnConsecutiveFailures, logRetentionDays, model, **maxSessionPct**, **maxWeeklyPct**, claimTtlHours, claimCheckMinutes, maxTaskAttempts, taskSizeHints). Clean JSON — the web Settings Form labels + explains each field. **Outside the repo.** |
| `USER_TODO.md` / `USER_QA.md` / `AI_TODO.md` / `AI_PROGRESS.md` / `AI_DONE.md` | The data books (content-only tables — ADR-0320). |
| `.claude/.autonomous.approvals.json` · `.autonomous.authors.json` | Per-row approver / writer (ADR-0320) — project data. `.autonomous.histories.json` = runtime state (gitignored). |
| `.claude/.autonomous.attempts.json` | Per-task attempt count + split-pending state (ADR-0371) — committed on the base branch with the books. |

## Branches & claims (ADR-0371)
- The **books** (the five `.md` files + the `.claude/.autonomous.*.json` sidecars) always live on the
  **base branch** and are the only files pushed to it directly; a claim is a books commit + push, and a
  rejected (non-fast-forward) push means another worker won — the cli re-syncs and re-picks.
- **Code** always goes through a task branch + a pull request into the base branch (submodules too).
- A failed task returns to `AI_TODO` (attempt + 1); out of tokens keeps the claim until the reset, but a
  claim older than `claimTtlHours` may be taken over. After `maxTaskAttempts` the task is split into
  smaller unapproved children (a split child that fails again becomes a `USER_QA` question).
- A task that needs a decision parks on a new `USER_QA` row listed in its `Depends`.

## Lifecycle (1 tick)
```
daemon scheduler (cronSchedule, skipped while paused) → the running daemon:
  ├─ paused / quiet-hours / max-ticks / has-work / quota over caps? → log "skip", done
  └─ run ONE cycle (write-capable agent):
       protected-base guard → sync <base> → resume/verify our claim → fold answered task-QAs →
       intake (APPROVED USER_TODO + USER_QA → AI_TODO, sized S/M, L split) → CLAIM one eligible task
       (books commit + push on <base> = the lock) → a task branch per task (root + subs)
       → implement + test → PULL REQUESTS into <base> → move the task to AI_DONE (ADR-0371)
  └─ record history (N consecutive failures → auto-pause); serialized (one cycle at a time)
```

## Turning it on
Nothing to install on the worker: press **Start** in the web **Autonomous → Overview** tab (and **Pause**
to stop). Requirements: a **running `4pm start` daemon** serving this project, plus `git` and
`gh`/`glab` for the PR step. The **schedule** and every other knob are set from the web Autonomous →
Settings tab; a schedule change applies at once.

## Permissions
The daemon runs the cycle as a write-capable agent (`--permission-mode bypassPermissions`, ADR-0271),
bounded by the folder-scope guard (ADR-0181) + the AI-run timeout (ADR-0243). Only enable full
permissions in an isolated environment (WSL / a per-project container). Never on a machine with
sensitive data.
