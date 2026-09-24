# Set up the cron tick for autonomous mode

How to install the **autonomous cron tick** on **WSL (Ubuntu)**. Under **ADR-0321** the tick is a **dumb**
one-liner (`exec 4pm auto-run`) — all logic lives in the cli/daemon, and all config lives in
`~/.4pm/profiles/<name>/autonomous.config.json` (edited from the web **Autonomous → Settings** tab), so
nothing about the loop is configured in this file or the repo.

> Run in a **WSL shell** (Ubuntu). Call the project root `$PROJECT` (e.g. `~/projects/<your-project>`).

## 1. Check the tools
```bash
command -v cron   || echo "missing cron"
command -v 4pm    || echo "missing 4pm cli (install natively in WSL; a '4pm start' daemon must be running)"
command -v git    || echo "missing git"
command -v gh     || command -v glab || echo "missing gh/glab (needed for the PR step)"
```

## 2. Install the tick
```bash
chmod +x "$PROJECT/.claude/hooks/autonomous-tick.sh"
crontab -e
# add (fix the path):
*/10 * * * * /home/<user>/projects/<your-project>/.claude/hooks/autonomous-tick.sh
```
After that, set the **schedule** and every other knob from the web **Autonomous → Settings** tab — the
cli keeps this crontab line's schedule in sync with `cronSchedule`, and **Start/Pause** + **Install/
Uninstall cron** are driven from the **Overview** tab.

## 3. Watch
The daemon writes a per-day tick log; view it from the web **Autonomous → Logs** tab (or on the worker
at `.claude/logs/autonomous-tick-$(date +%F).log`).
