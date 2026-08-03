#!/usr/bin/env bash
# Cron tick for the autonomous workflow — install on WSL. The schedule & control flags live in
# .claude/.autonomous.settings.json (paused, max_session_pct, max_weekly_pct, cron_schedule, …);
# read EVERY tick, so changes take effect on the next tick (cron_schedule auto-syncs into the crontab).
#
#   Install once:  crontab -e   →   */10 * * * * /path/to/project/.claude/hooks/autonomous-tick.sh
#   After that, change the cadence/priority by editing cron_schedule in .autonomous.settings.json.
#
# "Busy ⇒ wait for the next tick" via the EXISTENCE of the file `.autonomous.lock` (not flock):
#   - If the lock file exists  → another tick is running → log "skip" and exit.
#   - If it doesn't            → create the lock → call Claude headless to run /auto-cycle.
# Removing the lock is /auto-cycle's job (on success or error). The trap below is only a SAFETY NET:
# if the process dies before /auto-cycle removes it, the wrapper cleans it up on exit.
set -euo pipefail

# Project root = two levels above this file (.claude/hooks → .claude → root)
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOCK="$PROJECT_DIR/.claude/.autonomous.lock"
# State + cron history COMBINED into ONE JSON file (replacing the 3 old cron-applied/fails/ticks files).
HIST="$PROJECT_DIR/.claude/.autonomous.histories.json"
HIST_PY="$PROJECT_DIR/.claude/hooks/autonomous-history.py"
LOG_DIR="$PROJECT_DIR/.claude/logs"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/autonomous-tick-$(date +%F).log"   # per-DAY log (so log_retention_days is meaningful)
ts() { date '+%F %T'; }

# Create the lock atomically: `noclobber` makes `> file` FAIL if the file exists, closing the race
# where two ticks both pass a separate "does it exist?" check.
if ! ( set -o noclobber; : > "$LOCK" ) 2>/dev/null; then
  echo "$(ts) [skip] busy (.autonomous.lock exists) — waiting for the next tick" >> "$LOG"
  exit 0
fi
# Safety net: ensure the lock is cleaned when the wrapper exits, even if Claude dies silently.
trap 'rm -f "$LOCK"' EXIT

cd "$PROJECT_DIR"

# IMPORTANT: cron runs with a minimal PATH (/usr/bin:/bin) and does NOT load ~/.bashrc/~/.profile.
# `claude` is installed NATIVELY in WSL. Add common WSL install dirs so cron can find the claude binary:
#   - $HOME/.local/bin      : native installer (curl … | sh)
#   - $HOME/.npm-global/bin : npm global with a custom prefix
#   - /usr/local/bin        : default npm global when installed with sudo
export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:/usr/local/bin:$PATH"

# --- Python (needed for: reading settings + the token gate) ------------------------------------
PY_BIN="$(command -v python3 || command -v python || true)"
if [ -z "$PY_BIN" ]; then
  echo "$(ts) [error] python/python3 not found — skipping this tick" >> "$LOG"
  exit 0
fi

# --- Claude config dir (CLAUDE_CONFIG_DIR) from project.settings.json (MULTIPLE accounts) --------
# claudeConfigDir is a LIST of absolute paths, tried in fallback order. Pick the FIRST account whose
# token is still valid; if none is valid, pick the first account WITH credentials and mark it for
# refresh (calling 'claude /usage' once CLAUDE_BIN is known). Empty/missing -> keep the default (~/.claude).
SEL="$("$PY_BIN" - "$PROJECT_DIR/project.settings.json" <<'PY'
import json, os, sys, time
def exp_at(d):
    try:
        o = json.load(open(os.path.join(d, ".credentials.json"), encoding="utf-8")).get("claudeAiOauth", {})
        return o.get("expiresAt")
    except Exception:
        return None
try:
    s = json.load(open(sys.argv[1], encoding="utf-8"))
    dirs = s.get("claudeConfigDir", []) if isinstance(s, dict) else []
except Exception:
    dirs = []
if isinstance(dirs, str):
    dirs = [dirs]
dirs = [str(x).strip() for x in dirs if str(x).strip().startswith("/")]
now = time.time() * 1000
chosen, expired = "", "0"
for d in dirs:                 # prefer an account whose token is still valid
    e = exp_at(d)
    if e and e > now:
        chosen = d
        break
else:
    for d in dirs:             # none valid -> first account with credentials (will refresh)
        if exp_at(d) is not None:
            chosen, expired = d, "1"
            break
print(chosen)
print(expired)
PY
)"
CFG_CLAUDE_DIR="$(printf '%s\n' "$SEL" | sed -n 1p)"
CFG_CLAUDE_EXPIRED="$(printf '%s\n' "$SEL" | sed -n 2p)"
if [ -n "$CFG_CLAUDE_DIR" ]; then
  export CLAUDE_CONFIG_DIR="$CFG_CLAUDE_DIR"
  echo "$(ts) [cfg] CLAUDE_CONFIG_DIR=$CFG_CLAUDE_DIR (expired=$CFG_CLAUDE_EXPIRED)" >> "$LOG"
fi

# 'hist' wrapper: every read/write of .autonomous.histories.json goes through the Python helper.
# (get-cron/set-cron, get-fails/set-fails, get-ticks/set-ticks, record — see autonomous-history.py)
hist() { "$PY_BIN" "$HIST_PY" "$HIST" "$@"; }

# --- Read the autonomous config (.autonomous.settings.json) ------------------------------------
# User-editable; read EVERY tick so changes take effect next tick. Python prints CFG_*=<shlex-quoted>
# lines to eval; a missing/corrupt file -> use defaults (no break).
SETTINGS="$PROJECT_DIR/.claude/.autonomous.settings.json"
eval "$("$PY_BIN" - "$SETTINGS" <<'PY'
import json, sys, shlex
defaults = {"paused": False, "max_session_pct": 80, "max_weekly_pct": 90,
            "cron_schedule": "*/10 * * * *", "command": "/auto-cycle", "model": "",
            "quiet_hours": "", "max_ticks_per_day": -1, "stop_on_consecutive_failures": 3,
            "log_retention_days": 14, "notify_webhook": ""}
try:
    d = json.load(open(sys.argv[1], encoding="utf-8"))
    if not isinstance(d, dict): d = {}
except Exception:
    d = {}
def g(k): return d.get(k, defaults[k])
print("CFG_PAUSED=" + ("1" if bool(g("paused")) else "0"))
print("CFG_MAX_SESSION_PCT=" + shlex.quote(str(g("max_session_pct"))))
print("CFG_MAX_WEEKLY_PCT=" + shlex.quote(str(g("max_weekly_pct"))))
print("CFG_CRON_SCHEDULE=" + shlex.quote(str(g("cron_schedule"))))
print("CFG_COMMAND=" + shlex.quote(str(g("command"))))
print("CFG_MODEL=" + shlex.quote(str(g("model"))))
print("CFG_QUIET_HOURS=" + shlex.quote(str(g("quiet_hours"))))
print("CFG_MAX_TICKS_PER_DAY=" + shlex.quote(str(g("max_ticks_per_day"))))
print("CFG_STOP_ON_CONSEC_FAILURES=" + shlex.quote(str(g("stop_on_consecutive_failures"))))
print("CFG_LOG_RETENTION_DAYS=" + shlex.quote(str(g("log_retention_days"))))
print("CFG_NOTIFY_WEBHOOK=" + shlex.quote(str(g("notify_webhook"))))
PY
)"
# Export CFG_* so the history helper (autonomous-history.py 'record') can read the run config from env.
export CFG_CRON_SCHEDULE CFG_COMMAND CFG_MODEL CFG_MAX_SESSION_PCT CFG_MAX_WEEKLY_PCT \
       CFG_QUIET_HOURS CFG_MAX_TICKS_PER_DAY CFG_STOP_ON_CONSEC_FAILURES CFG_PAUSED

# --- Sync the crontab when cron_schedule changes ----------------------------------------------
# Compare with the last-applied schedule (cron_applied in .autonomous.histories.json); if different,
# rewrite the crontab LINE pointing at this script. Safe: only self-edit when the crontab already has
# the autonomous line (or one was applied before) -> avoid creating a crontab during a manual run.
SELF="$PROJECT_DIR/.claude/hooks/autonomous-tick.sh"
PREV_SCHED="$(hist get-cron 2>/dev/null || true)"
if [ "$CFG_CRON_SCHEDULE" != "$PREV_SCHED" ]; then
  if command -v crontab >/dev/null 2>&1; then
    CUR="$(crontab -l 2>/dev/null || true)"
    if printf '%s\n' "$CUR" | grep -qF "$SELF" || [ -n "$PREV_SCHED" ]; then
      NEWTAB="$( { printf '%s\n' "$CUR" | grep -vF "$SELF" || true; echo "$CFG_CRON_SCHEDULE $SELF"; } )"
      if printf '%s\n' "$NEWTAB" | crontab - 2>>"$LOG"; then
        hist set-cron "$CFG_CRON_SCHEDULE" 2>>"$LOG" || true
        echo "$(ts) [cron] synced schedule -> '$CFG_CRON_SCHEDULE'" >> "$LOG"
      else
        echo "$(ts) [warn] could not write crontab (keeping the old schedule)" >> "$LOG"
      fi
    else
      echo "$(ts) [cron] crontab has no autonomous line — skipping auto-install (install it once manually first)" >> "$LOG"
    fi
  else
    echo "$(ts) [cron] no 'crontab' on PATH — skipping schedule sync" >> "$LOG"
  fi
fi

# --- Pause flag -------------------------------------------------------------------------------
if [ "$CFG_PAUSED" = "1" ]; then
  echo "$(ts) [skip] paused=true in .autonomous.settings.json — skipping this tick" >> "$LOG"
  exit 0
fi

# --- Prune old logs by log_retention_days (logs are per-day in $LOG_DIR) -----------------------
if [ "${CFG_LOG_RETENTION_DAYS:-0}" -gt 0 ] 2>/dev/null; then
  find "$LOG_DIR" -maxdepth 1 -type f -name 'autonomous-tick-*.log' -mtime +"$CFG_LOG_RETENTION_DAYS" -delete 2>/dev/null || true
fi

# --- Quiet hours ------------------------------------------------------------------------------
# Empty = run all day. 'HH:MM-HH:MM' = skip within the window; supports a window crossing midnight.
if [ -n "$CFG_QUIET_HOURS" ]; then
  if printf '%s' "$CFG_QUIET_HOURS" | grep -Eq '^[0-9]{1,2}:[0-9]{2}-[0-9]{1,2}:[0-9]{2}$'; then
    q_start="${CFG_QUIET_HOURS%%-*}"; q_end="${CFG_QUIET_HOURS##*-}"
    _min() { echo $(( 10#${1%%:*} * 60 + 10#${1##*:} )); }   # "HH:MM" -> minutes (10# forces base 10)
    qs=$(_min "$q_start"); qe=$(_min "$q_end"); qn=$(_min "$(date +%H:%M)")
    in_q=0
    if [ "$qs" -le "$qe" ]; then
      { [ "$qn" -ge "$qs" ] && [ "$qn" -lt "$qe" ]; } && in_q=1
    else
      { [ "$qn" -ge "$qs" ] || [ "$qn" -lt "$qe" ]; } && in_q=1   # window crossing midnight
    fi
    if [ "$in_q" = 1 ]; then
      echo "$(ts) [skip] within quiet_hours ($CFG_QUIET_HOURS) — skipping this tick" >> "$LOG"
      exit 0
    fi
  else
    echo "$(ts) [warn] quiet_hours has a bad format ('$CFG_QUIET_HOURS') — ignoring the check" >> "$LOG"
  fi
fi

# --- Max ticks/day (max_ticks_per_day) --------------------------------------------------------
# -1 = unlimited. Counted per local day, stored under ticks{day,count} in .autonomous.histories.json.
TODAY="$(date +%F)"
tick_count="$(hist get-ticks "$TODAY" 2>/dev/null || echo 0)"; [ -z "$tick_count" ] && tick_count=0
if [ "${CFG_MAX_TICKS_PER_DAY:--1}" -gt 0 ] 2>/dev/null && [ "${tick_count:-0}" -ge "$CFG_MAX_TICKS_PER_DAY" ]; then
  echo "$(ts) [skip] reached max_ticks_per_day=$CFG_MAX_TICKS_PER_DAY ($tick_count ticks today) — skipping" >> "$LOG"
  exit 0
fi

# --- "Has work" gate (USER_TODO / APPROVED AI_TODO / AI_PROGRESS) -------------------------------
# Skip IMMEDIATELY (WITHOUT calling Claude — /auto-cycle would still cost tokens just to start + stop)
# UNLESS there is one of three kinds of work:
#   1) USER_TODO.md has a new request  → /auto-cycle will generate tasks (Step 2);
#   2) AI_TODO.md has AT LEAST 1 APPROVED task (approved in .autonomous.approvals.json) → Step 3 can take
#      it. Tasks not approved DON'T count as work (VERIFY gate: wait for the user to approve them first);
#   3) AI_PROGRESS.md is non-empty      → work left over from a previous tick to continue.
#
# "EMPTY" (USER_TODO / AI_PROGRESS) = COMPARE TO THE TEMPLATE: the content (normalized: trim trailing
# whitespace + leading/trailing blank lines) EQUALS the empty template in .claude/templates/. AI_TODO is
# judged separately via approvals (a full AI_TODO of unapproved tasks != the empty template but has NO work).
TPL="$PROJECT_DIR/.claude/templates"
WORK="$(AI_TODO="$PROJECT_DIR/AI_TODO.md" USER_TODO="$PROJECT_DIR/USER_TODO.md" \
        AI_PROGRESS="$PROJECT_DIR/AI_PROGRESS.md" \
        APPROVALS="$PROJECT_DIR/.claude/.autonomous.approvals.json" \
        USER_TODO_TPL="$TPL/USER_TODO.empty.md" AI_PROGRESS_TPL="$TPL/AI_PROGRESS.empty.md" \
        "$PY_BIN" - <<'PY'
import os, json
def norm(p):
    # Read + normalize; return None if the file can't be read.
    try:
        lines = [ln.rstrip() for ln in open(p, encoding="utf-8").read().splitlines()]
    except Exception:
        return None
    while lines and not lines[0]:   lines.pop(0)
    while lines and not lines[-1]:  lines.pop()
    return "\n".join(lines)
def has_work(live, tpl):
    nv = norm(live)
    if nv is None:        # no live file -> treat as NO work (safe, don't call Claude)
        return False
    nt = norm(tpl)
    if nt is None:        # no template -> can't compare -> any non-empty content counts as work
        return bool(nv)
    return nv != nt       # differs from the empty template = has work
def has_approved(aitodo_p, approvals_p):
    # At least 1 APPROVED task still in the queue (ADR-0152): the approval source is
    # .autonomous.approvals.json ("<TSK-id>": {approved:true,...}) — the ✓ column is no longer read.
    try:
        ap = json.load(open(approvals_p, encoding="utf-8"))
        approved = {k for k, v in ap.items() if isinstance(v, dict) and v.get("approved") is True}
    except Exception:
        return False
    if not approved:
        return False
    try:
        todo = open(aitodo_p, encoding="utf-8").read()
    except Exception:
        return False
    return any(tid in todo for tid in approved)   # approved AND still present in AI_TODO
user = has_work(os.environ["USER_TODO"],   os.environ["USER_TODO_TPL"])
prog = has_work(os.environ["AI_PROGRESS"], os.environ["AI_PROGRESS_TPL"])
ai   = has_approved(os.environ["AI_TODO"], os.environ["APPROVALS"])
print("WORK" if (user or prog or ai) else "EMPTY")
PY
)"
if [ "$WORK" != "WORK" ]; then
  echo "$(ts) [skip] no new request (USER_TODO), approved task (AI_TODO), or in-progress work (AI_PROGRESS) — skipping (no Claude call)" >> "$LOG"
  exit 0
fi

# Allow an override via env; if still not found, log a clear error and skip.
CLAUDE_BIN="${CLAUDE_BIN:-$(command -v claude || true)}"
if [ -z "$CLAUDE_BIN" ]; then
  echo "$(ts) [error] 'claude' not found on PATH — check the claude install in WSL (e.g. ~/.local/bin/claude)" >> "$LOG"
  exit 0
fi

# The chosen account's token expired -> try to refresh with 'claude /usage' (startup refresh).
# (Switching accounts was done in the CLAUDE_CONFIG_DIR selection above.) Best-effort, doesn't block.
if [ -n "${CLAUDE_CONFIG_DIR:-}" ] && [ "${CFG_CLAUDE_EXPIRED:-0}" = "1" ]; then
  echo "$(ts) [cfg] token expired -> refreshing with 'claude /usage'" >> "$LOG"
  "$CLAUDE_BIN" /usage >/dev/null 2>&1 || true
fi

# --- Token gate (moved from /auto-cycle Step 0 to here) ---------------------------------------
# Reason: check quota BEFORE calling Claude so we don't spend tokens just to start + self-stop when
# quota is already high. Thresholds from settings: session_pct < max_session_pct AND weekly_pct < max_weekly_pct.
USAGE_JSON="$PROJECT_DIR/.claude/skills/check-usage/output/last-usage-check.json"
if ! "$PY_BIN" "$PROJECT_DIR/.claude/skills/check-usage/check_usage.py" >> "$LOG" 2>&1; then
  echo "$(ts) [skip] check_usage.py failed (can't read quota) — skipping to be safe" >> "$LOG"
  exit 0
fi
GATE="$(MAXS="$CFG_MAX_SESSION_PCT" MAXW="$CFG_MAX_WEEKLY_PCT" "$PY_BIN" - "$USAGE_JSON" <<'PY'
import json, os, sys
try:
    d = json.load(open(sys.argv[1], encoding="utf-8"))
    s = float(d.get("session_pct", 100))
    w = float(d.get("weekly_pct", 100))
    maxs = float(os.environ.get("MAXS", "80"))
    maxw = float(os.environ.get("MAXW", "90"))
except Exception as e:
    print(f"ERR {e}")
    sys.exit(0)
print(f"{'OK' if (s < maxs and w < maxw) else 'HIGH'} session={s:.0f}% weekly={w:.0f}% (max {maxs:.0f}/{maxw:.0f})")
PY
)"
case "$GATE" in
  OK*)   echo "$(ts) [gate] tokens ok ($GATE) — continue" >> "$LOG" ;;
  HIGH*) echo "$(ts) [skip] tokens high ($GATE) — skipping this tick" >> "$LOG"
         hist record "$(ts)" skip "" "$GATE" "tokens high — skipped" 2>>"$LOG" || true; exit 0 ;;
  *)     echo "$(ts) [skip] can't read usage ($GATE) — skipping to be safe" >> "$LOG"
         hist record "$(ts)" skip "" "$GATE" "can't read usage" 2>>"$LOG" || true; exit 0 ;;
esac
# -----------------------------------------------------------------------------------------------

# Record 1 tick that ACTUALLY calls Claude (for max_ticks_per_day) — stored in ticks{day,count}.
tick_count=$(( ${tick_count:-0} + 1 ))
hist set-ticks "$TODAY" "$tick_count" 2>>"$LOG" || true

echo "$(ts) [run] starting $CFG_COMMAND (tick $tick_count/$TODAY)" >> "$LOG"
# No GUI window (cron has no desktop session). Everything goes to "$LOG"; watch it live with:
#   tail -f .claude/logs/autonomous-tick-$(date +%F).log

# Headless: -p runs one cycle then exits. No permission prompts (unattended on WSL).
# Force the model if settings has 'model' (empty array is safe under set -u via ${arr[@]+...}).
MODEL_ARGS=()
[ -n "$CFG_MODEL" ] && MODEL_ARGS=(--model "$CFG_MODEL")
set +e
"$CLAUDE_BIN" -p "$CFG_COMMAND" \
  ${MODEL_ARGS[@]+"${MODEL_ARGS[@]}"} \
  --permission-mode bypassPermissions \
  --dangerously-skip-permissions \
  >> "$LOG" 2>&1
RC=$?
set -e

# --- Record the run + count consecutive failures + auto-stop (stop_on_consecutive_failures) ----
# RC != 0 -> increment; reaching the threshold -> set paused=true (needs a manual resume). RC == 0 -> reset.
# The consecutive-failure count is stored under consecutive_fails in .autonomous.histories.json.
fails="$(hist get-fails 2>/dev/null || echo 0)"; [ -z "$fails" ] && fails=0
if [ "$RC" -ne 0 ]; then
  echo "$(ts) [warn] $CFG_COMMAND exited $RC" >> "$LOG"
  fails=$(( ${fails:-0} + 1 )); hist set-fails "$fails" 2>>"$LOG" || true
  hist record "$(ts)" failure "$RC" "$GATE" "consecutive failure #$fails" 2>>"$LOG" || true
  if [ "${CFG_STOP_ON_CONSEC_FAILURES:-0}" -gt 0 ] 2>/dev/null && [ "$fails" -ge "$CFG_STOP_ON_CONSEC_FAILURES" ]; then
    "$PY_BIN" - "$SETTINGS" <<'PY' 2>>"$LOG" || true
import json, sys
p = sys.argv[1]
try:
    d = json.load(open(p, encoding="utf-8"))
    d["paused"] = True
    with open(p, "w", encoding="utf-8") as f:
        json.dump(d, f, ensure_ascii=False, indent=2); f.write("\n")
except Exception:
    pass
PY
    echo "$(ts) [stop] $fails consecutive failures >= $CFG_STOP_ON_CONSEC_FAILURES → set paused=true (resume manually)" >> "$LOG"
  fi
else
  hist set-fails 0 2>>"$LOG" || true   # success → reset the consecutive-failure count
  hist record "$(ts)" success "$RC" "$GATE" "cycle complete" 2>>"$LOG" || true
fi

# notify_webhook: TBD — this is where a run summary would be POSTed to a webhook if CFG_NOTIFY_WEBHOOK is set.

echo "$(ts) [done] tick finished" >> "$LOG"
# The EXIT trap above removes `.autonomous.lock` if /auto-cycle didn't → the lock is released.
