#!/usr/bin/env bash
# Autonomous cron tick (ADR-0321). Its ONLY job is to invoke the 4PM cli — there is NO autonomous logic
# here. All decisions (config, paused/quiet-hours/max-ticks/has-work/quota gates, cron schedule sync,
# run histories, serialization, model, usage checks) live in the cli/daemon, so the logic can't be read
# from or tampered with in the project repo. `4pm auto-run` asks the running `4pm start` daemon to run
# one cycle through its live session.
#
#   Install once:  crontab -e   →   */10 * * * * /path/to/project/.claude/hooks/autonomous-tick.sh
#   (the cli keeps this crontab line's schedule in sync with autonomous.config.json).
set -euo pipefail

# cron has a minimal PATH and does not load ~/.bashrc; add common WSL install dirs so `4pm` is found.
export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:/usr/local/bin:$PATH"

exec 4pm auto-run
