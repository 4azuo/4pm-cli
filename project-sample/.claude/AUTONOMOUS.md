# Autonomous mode — how it's assembled

> **Sample project — defines the workflow only, does NOT run on its own.** The files below describe an
> unattended work loop, intended to run on **WSL** (an isolated environment where the AI can be given
> full permissions).

## The pieces
| File | Role |
|------|------|
| `.claude/hooks/autonomous-tick.sh` | Cron tick (every ~10 min); a lock so **busy ⇒ skip, idle ⇒ run**; calls `claude -p /auto-cycle`. |
| `.claude/commands/auto-cycle.md` | Defines **one cycle**: token gate → sync `${ai_dev_branch}$` → generate tasks → do one task → test → merge into `${ai_dev_branch}$`. |
| `.claude/skills/check-usage/check_usage.py` | The `check-usage` skill: prints token % and writes `output/last-usage-check.json` (deleted + recreated each run) for the token gate to read. |
| `.claude/.autonomous.approvals.json` | Approval source of truth (ADR-0152): `{ "<TSK-id>": {approved, by, at} }` — the web VERIFY tab writes it; `/auto-cycle` reads it. |
| `USER_TODO.md` | The user writes requests here; the cycle reads then clears it. |
| `AI_TODO.md` / `AI_PROGRESS.md` / `AI_DONE.md` | The task books: queue → in progress → done (ID `TSK-{group:0000}-{task:0000}`). |
| `.claude/templates/<NAME>.{empty,sample}.md` | Canonical templates for the 5 books. The "has work" gate + `/auto-cycle` **compare against `*.empty.md`** to tell empty/has-work and reset correctly (see `README.md` in that folder). |
| `.claude/settings.json` | The "bypass all" permission profile for autonomous mode (see the note below). |

## Lifecycle (1 tick)
```
cron ~10min → autonomous-tick.sh
  ├─ locked?  → log "skip", exit (wait for the next tick)
  └─ idle → claude -p /auto-cycle
       0. usage: session<80% & weekly<90%?  (no → stop)
       1. checkout/fetch/pull the `${ai_dev_branch}$` branch
       2. USER_TODO.md → generate tasks into AI_TODO.md (with IDs) → clear USER_TODO.md
       3. pick one APPROVED task (approvals + dependencies) → AI_PROGRESS.md, remove from AI_TODO.md, commit
       4. task/TSK-… branch → implement → commit → run the project's tests
       5. back to `${ai_dev_branch}$` → merge task (resolve conflicts if any) → AI_DONE.md, remove from AI_PROGRESS.md, commit
       6. report on the `conversation` branch (CONVERSATION.md, ≤50 entries) for later agents
       7. recheck usage → stop
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
Requirements: `claude` logged in (has `~/.claude/.credentials.json`), plus `git` and `python3`, and the
project's test tooling (per `CLAUDE.md`).

## Note on permissions (important)
- Claude Code only auto-loads `.claude/settings.json` and `.claude/settings.local.json`. To make a
  full-permission profile take effect, one of:
  1. The tick already passes `--permission-mode bypassPermissions --dangerously-skip-permissions` (in use).
  2. Or copy the profile into `.claude/settings.local.json`.
  3. Or point `CLAUDE_CONFIG_DIR` at the profile dir when running headless.
- Only enable full permissions in an isolated environment (WSL/CI). Never on a machine with sensitive data.
