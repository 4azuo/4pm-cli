---
name: check-usage
description: Show Claude Code plan usage limits — current session % and reset time, weekly % and reset time (same data as the built-in /usage screen). Use when the user asks "how much usage left", "khi nao reset", "check usage/quota/limit", or invokes /check-usage.
---

# check-usage — Claude Code plan usage limits

Fetches the same data the built-in `/usage` screen shows (session + weekly utilization and
reset times), by calling the Anthropic OAuth usage endpoint with the local credentials.

## How to run

Run the bundled script with the Bash tool. It prints a compact bullet list to the console;
relay that output to the user.

```bash
python .claude/skills/check-usage/check_usage.py
```

On Windows if `python` is missing, try `py .claude/skills/check-usage/check_usage.py`.

Add `--json` to dump the raw API response instead of the formatted view:

```bash
python .claude/skills/check-usage/check_usage.py --json
```

## Output file
Every run (the formatted view, not `--json`) rewrites `./output/last-usage-check.json` next to
the script: it deletes the previous file then creates a fresh one with this run's result. The
record has machine-readable fields the autonomous workflow reads back:
`session_pct`, `weekly_pct`, `session_resets_at`, `weekly_resets_at`, `checked_at`, `plan`,
plus the human `summary` and the full `raw` API payload.

## Notes
- Reads the OAuth access token from `~/.claude/.credentials.json` (Claude Code keeps it refreshed).
- If the call returns HTTP 401, the token expired — tell the user to run the real `/usage` once
  inside Claude Code (or re-login) to refresh credentials, then retry.
- Reset times are printed in the machine's local timezone with a "con Xh Ym" countdown.
- Do not print the access token.
