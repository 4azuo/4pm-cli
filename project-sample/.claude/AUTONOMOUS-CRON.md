# Set up a 10-minute cron for `autonomous-tick.sh`

How to install the **autonomous cycle** on **WSL (Ubuntu)**: cron calls
[`autonomous-tick.sh`](autonomous-tick.sh) every **10 minutes**; each run does one `claude -p /auto-cycle`
cycle then exits. A file lock (`.claude/.autonomous.lock`) ensures **no two runs overlap** (a later tick
that sees the lock skips).

> All commands below run in a **WSL shell** (Ubuntu) unless noted as PowerShell/Windows. Call the project
> root `$PROJECT` (e.g. `~/projects/<your-project>`).

## 0. Set a variable for convenience
```bash
PROJECT="$HOME/projects/<your-project>"   # fix to your path
cd "$PROJECT"
```

## 1. Check the required tools
Every line must print a path/version (not "not found"):
```bash
command -v cron   || echo "missing cron"
command -v claude || echo "missing claude (install natively in WSL)"
command -v git    || echo "missing git"
command -v python3 || echo "missing python3"
```

## 2. Make the tick executable + install the cron line
```bash
chmod +x "$PROJECT/.claude/hooks/autonomous-tick.sh"
crontab -e
# add (fix the path):
*/10 * * * * /home/<user>/projects/<your-project>/.claude/hooks/autonomous-tick.sh
```
The schedule is also driven by `cron_schedule` in `.claude/.autonomous.settings.json`; once the crontab
line exists, the tick keeps it in sync on later runs.

## 3. Enable / watch
- Set `"paused": false` in `.claude/.autonomous.settings.json` to enable (or use the web Autonomous tab).
- Watch: `tail -f .claude/logs/autonomous-tick-$(date +%F).log`
