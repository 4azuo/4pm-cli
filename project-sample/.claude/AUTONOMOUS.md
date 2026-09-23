# Autonomous mode — how it's assembled

> **Sample project — defines the workflow only, does NOT run on its own.** The files below describe an
> unattended work loop (ADR-0152 + **ADR-0319**), intended to run on **WSL** (an isolated environment
> where the AI can be given full permissions). Under ADR-0319 the cycle runs **through the 4PM cli**,
> not a raw `claude -p`.

## The pieces
| File | Role |
|------|------|
| `.claude/hooks/autonomous-tick.sh` | Cron tick (every ~5–10 min): a run lock + the CHEAP local gates (pause / quiet-hours / max-ticks / **has-work**), then runs **`4pm auto-run`**. No token spend when there's no approved work. |
| `4pm auto-run` (cli) | Asks the running **`4pm start`** daemon to run **one** cycle over the control socket; the cycle rides the daemon's live WS session (failover ADR-0182, metering ADR-0072, folder-scope ADR-0181, timeout ADR-0243). |
| cli `buildAutonomousCyclePrompt` | The cli-owned cycle instructions (was `.claude/commands/auto-cycle.md`, now retired): sync branch → analyse **approved** USER_TODO → fold **approved** USER_QA → do ONE approved task → **PR** into the base branch. |
| `.claude/.autonomous.approvals.json` | Approval source of truth (ADR-0152): `{ "<REQ/QA/TSK-id>": {approved, by, at} }` — the web AI-content grids write it; the cycle reads it. |
| `USER_TODO.md` / `USER_QA.md` | User requests / the AI's questions back — each row approved before the cycle acts on it (ADR-0319). |
| `AI_TODO.md` / `AI_PROGRESS.md` / `AI_DONE.md` | The task books: queue → in progress → done (ID `TSK-{group:0000}-{task:0000}`). |
| `.claude/templates/<NAME>.{empty,sample}.md` | Canonical templates for the books. The has-work gate + the cycle **compare against `*.empty.md`** to tell empty/has-work and reset correctly. |
| `.claude/settings.json` | The "bypass all" permission profile for autonomous mode (see the note below). |

## Lifecycle (1 tick)
```
cron ~5–10min → autonomous-tick.sh
  ├─ locked? / paused? / quiet-hours? / max-ticks? → log "skip", exit
  ├─ has-work? (approved USER_TODO/USER_QA/AI_TODO, or AI_PROGRESS non-empty) — no → skip (daemon NOT woken)
  └─ 4pm auto-run → the running daemon runs ONE cycle:
       1. sync the primary repo's current branch (base branch — ADR-0292)
       2. analyse APPROVED USER_TODO requests → AI_TODO tasks (unclear ⇒ ask via USER_QA)
       3. fold APPROVED USER_QA answers back into AI_TODO
       4. take ONE approved task (deps met) → AI_PROGRESS, commit
       5. implement + test on task/TSK-… branch
       6. rebase + push + open a PULL REQUEST into the base branch (no direct merge)
       7. update the books (AI_DONE), commit + push the base branch
  └─ record success/failure (N consecutive failures → pause); the EXIT trap releases the lock
```

## Install on WSL
```bash
chmod +x .claude/hooks/autonomous-tick.sh
crontab -e
# add the line (fix /path):
*/10 * * * * /path/to/project/.claude/hooks/autonomous-tick.sh
# watch:
tail -f .claude/logs/autonomous-tick-$(date +%F).log
```
Requirements: the **`4pm`** cli on PATH with a **running `4pm start` daemon** serving this project (it
holds the AI credentials + WS session), plus `git`, `python3`, and `gh`/`glab` for the PR step.

## Note on permissions (important)
- The daemon runs the cycle as a **write-capable agent** (`--permission-mode bypassPermissions`,
  ADR-0271) so file + git/`gh`/`glab` writes run headless. It stays bounded by the folder-scope guard
  (ADR-0181) + the AI-run timeout (ADR-0243).
- Only enable full permissions in an isolated environment (WSL/CI). Never on a machine with sensitive data.
