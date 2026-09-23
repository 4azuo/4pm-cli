#!/usr/bin/env bash
# Cron tick for the autonomous workflow (ADR-0152 + ADR-0319) — install on WSL. Control flags live in
# .claude/.autonomous.settings.json (paused, cron_schedule, quiet_hours, max_ticks_per_day, …); read
# EVERY tick, so changes take effect next tick (cron_schedule auto-syncs into the crontab).
#
#   Install once:  crontab -e   →   */10 * * * * /path/to/project/.claude/hooks/autonomous-tick.sh
#
# What changed with ADR-0319: the tick no longer runs `claude -p /auto-cycle` directly. It runs
# `4pm auto-run`, which asks the ALREADY-RUNNING `4pm start` daemon to run one cycle through its live
# WS session — so the cycle reuses the cli's profile/quota failover (ADR-0182), token metering
# (ADR-0072), folder-scope (ADR-0181) and AI-run timeout (ADR-0243). Account selection + the token/quota
# gate now live in the cli (they need the live usage snapshot), NOT in this shell.
#
# This tick keeps only the CHEAP local gates (no token spend): a run lock, pause, quiet-hours,
# max-ticks/day, and a "has-work" check — so the daemon is only woken when there is approved work.
#
# "Busy ⇒ wait for the next tick" via the EXISTENCE of `.autonomous.lock` (not flock):
#   - lock file exists → another tick is running → log "skip" and exit.
#   - it doesn't       → create the lock → run one cycle via the daemon.
# The EXIT trap removes the lock whether the cycle succeeds or dies.
set -euo pipefail

# Project root = two levels above this file (.claude/hooks → .claude → root)
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOCK="$PROJECT_DIR/.claude/.autonomous.lock"
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
# The lock is released when this wrapper exits, whether the cycle succeeded, errored, or was skipped.
trap 'rm -f "$LOCK"' EXIT

cd "$PROJECT_DIR"

# cron runs with a minimal PATH and does NOT load ~/.bashrc. Add common WSL install dirs so cron can
# find the `4pm` binary (native install / npm global) + python3.
export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:/usr/local/bin:$PATH"

# --- Python (needed for: reading settings + the has-work gate + history) -----------------------
PY_BIN="$(command -v python3 || command -v python || true)"
if [ -z "$PY_BIN" ]; then
  echo "$(ts) [error] python/python3 not found — skipping this tick" >> "$LOG"
  exit 0
fi

# 'hist' wrapper: every read/write of .autonomous.histories.json goes through the Python helper.
hist() { "$PY_BIN" "$HIST_PY" "$HIST" "$@"; }

# --- Read the autonomous config (.autonomous.settings.json) ------------------------------------
# User-editable; read EVERY tick so changes take effect next tick. A missing/corrupt file -> defaults.
SETTINGS="$PROJECT_DIR/.claude/.autonomous.settings.json"
eval "$("$PY_BIN" - "$SETTINGS" <<'PY'
import json, sys, shlex
defaults = {"paused": False, "cron_schedule": "*/10 * * * *", "command": "auto-run", "profile": "",
            "quiet_hours": "", "max_ticks_per_day": -1, "stop_on_consecutive_failures": 3,
            "log_retention_days": 14, "notify_webhook": ""}
try:
    d = json.load(open(sys.argv[1], encoding="utf-8"))
    if not isinstance(d, dict): d = {}
except Exception:
    d = {}
def g(k): return d.get(k, defaults[k])
print("CFG_PAUSED=" + ("1" if bool(g("paused")) else "0"))
print("CFG_CRON_SCHEDULE=" + shlex.quote(str(g("cron_schedule"))))
print("CFG_PROFILE=" + shlex.quote(str(g("profile"))))
print("CFG_QUIET_HOURS=" + shlex.quote(str(g("quiet_hours"))))
print("CFG_MAX_TICKS_PER_DAY=" + shlex.quote(str(g("max_ticks_per_day"))))
print("CFG_STOP_ON_CONSEC_FAILURES=" + shlex.quote(str(g("stop_on_consecutive_failures"))))
print("CFG_LOG_RETENTION_DAYS=" + shlex.quote(str(g("log_retention_days"))))
print("CFG_NOTIFY_WEBHOOK=" + shlex.quote(str(g("notify_webhook"))))
PY
)"
# Export CFG_* so the history helper ('record') can read the run config from env.
export CFG_CRON_SCHEDULE CFG_QUIET_HOURS CFG_MAX_TICKS_PER_DAY CFG_STOP_ON_CONSEC_FAILURES CFG_PAUSED

# --- Sync the crontab when cron_schedule changes ----------------------------------------------
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

# --- Prune old logs by log_retention_days -----------------------------------------------------
if [ "${CFG_LOG_RETENTION_DAYS:-0}" -gt 0 ] 2>/dev/null; then
  find "$LOG_DIR" -maxdepth 1 -type f -name 'autonomous-tick-*.log' -mtime +"$CFG_LOG_RETENTION_DAYS" -delete 2>/dev/null || true
fi

# --- Quiet hours ------------------------------------------------------------------------------
if [ -n "$CFG_QUIET_HOURS" ]; then
  if printf '%s' "$CFG_QUIET_HOURS" | grep -Eq '^[0-9]{1,2}:[0-9]{2}-[0-9]{1,2}:[0-9]{2}$'; then
    q_start="${CFG_QUIET_HOURS%%-*}"; q_end="${CFG_QUIET_HOURS##*-}"
    _min() { echo $(( 10#${1%%:*} * 60 + 10#${1##*:} )); }
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

# --- Max ticks/day ----------------------------------------------------------------------------
TODAY="$(date +%F)"
tick_count="$(hist get-ticks "$TODAY" 2>/dev/null || echo 0)"; [ -z "$tick_count" ] && tick_count=0
if [ "${CFG_MAX_TICKS_PER_DAY:--1}" -gt 0 ] 2>/dev/null && [ "${tick_count:-0}" -ge "$CFG_MAX_TICKS_PER_DAY" ]; then
  echo "$(ts) [skip] reached max_ticks_per_day=$CFG_MAX_TICKS_PER_DAY ($tick_count ticks today) — skipping" >> "$LOG"
  exit 0
fi

# --- "Has work" gate --------------------------------------------------------------------------
# Skip WITHOUT waking the daemon unless there is one of:
#   1) an APPROVED USER_TODO request (REQ-… approved in .autonomous.approvals.json) — Step 2 analyses it;
#   2) an APPROVED USER_QA answer   (QA-… approved)                                 — Step 3 folds it in;
#   3) an APPROVED AI_TODO task     (TSK-… approved)                                — Step 4 can take it;
#   4) AI_PROGRESS.md non-empty (leftover work from a previous tick).
# Approval is the source of truth in .autonomous.approvals.json (ADR-0152/0319), keyed per row id.
TPL="$PROJECT_DIR/.claude/templates"
WORK="$(USER_TODO="$PROJECT_DIR/USER_TODO.md" USER_QA="$PROJECT_DIR/USER_QA.md" \
        AI_TODO="$PROJECT_DIR/AI_TODO.md" AI_PROGRESS="$PROJECT_DIR/AI_PROGRESS.md" \
        APPROVALS="$PROJECT_DIR/.claude/.autonomous.approvals.json" \
        AI_PROGRESS_TPL="$TPL/AI_PROGRESS.empty.md" \
        "$PY_BIN" - <<'PY'
import os, json
def read(p):
    try: return open(p, encoding="utf-8").read()
    except Exception: return ""
def norm(t):
    lines = [ln.rstrip() for ln in t.splitlines()]
    while lines and not lines[0]: lines.pop(0)
    while lines and not lines[-1]: lines.pop()
    return "\n".join(lines)
try:
    ap = json.load(open(os.environ["APPROVALS"], encoding="utf-8"))
    approved = {k for k, v in ap.items() if isinstance(v, dict) and v.get("approved") is True}
except Exception:
    approved = set()
def approved_in(book_env, prefix):
    text = read(os.environ[book_env])
    return any(i.startswith(prefix) and i in text for i in approved)
user  = approved_in("USER_TODO", "REQ-")
qa    = approved_in("USER_QA",   "QA-")
ai    = approved_in("AI_TODO",   "TSK-")
prog  = norm(read(os.environ["AI_PROGRESS"])) != norm(read(os.environ["AI_PROGRESS_TPL"]))
print("WORK" if (user or qa or ai or prog) else "EMPTY")
PY
)"
if [ "$WORK" != "WORK" ]; then
  echo "$(ts) [skip] no approved USER_TODO/USER_QA/AI_TODO work and AI_PROGRESS empty — skipping (daemon not woken)" >> "$LOG"
  exit 0
fi

# --- Locate the `4pm` cli ---------------------------------------------------------------------
FOURPM_BIN="${FOURPM_BIN:-$(command -v 4pm || true)}"
if [ -z "$FOURPM_BIN" ]; then
  echo "$(ts) [error] '4pm' not found on PATH — install the 4PM cli in WSL (e.g. ~/.local/bin/4pm)" >> "$LOG"
  exit 0
fi

# Record 1 tick that ACTUALLY runs a cycle (for max_ticks_per_day).
tick_count=$(( ${tick_count:-0} + 1 ))
hist set-ticks "$TODAY" "$tick_count" 2>>"$LOG" || true

# Optional profile pin (settings.profile) — else the cli resolves the single linked profile.
PROFILE_ARGS=()
[ -n "${CFG_PROFILE:-}" ] && PROFILE_ARGS=(--profile "$CFG_PROFILE")

echo "$(ts) [run] 4pm auto-run (tick $tick_count/$TODAY)" >> "$LOG"
set +e
"$FOURPM_BIN" auto-run ${PROFILE_ARGS[@]+"${PROFILE_ARGS[@]}"} >> "$LOG" 2>&1
RC=$?
set -e

# --- Record the run + count consecutive failures + auto-stop ----------------------------------
# RC != 0 (no daemon / dispatch error) -> increment; reaching the threshold -> paused=true. RC == 0 -> reset.
fails="$(hist get-fails 2>/dev/null || echo 0)"; [ -z "$fails" ] && fails=0
if [ "$RC" -ne 0 ]; then
  echo "$(ts) [warn] 4pm auto-run exited $RC" >> "$LOG"
  fails=$(( ${fails:-0} + 1 )); hist set-fails "$fails" 2>>"$LOG" || true
  hist record "$(ts)" failure "$RC" "" "consecutive failure #$fails" 2>>"$LOG" || true
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
  hist record "$(ts)" success "$RC" "" "cycle complete" 2>>"$LOG" || true
fi

# notify_webhook: TBD — a run summary would be POSTed here if CFG_NOTIFY_WEBHOOK is set.

echo "$(ts) [done] tick finished" >> "$LOG"
# The EXIT trap above removes `.autonomous.lock` → the lock is released for the next tick.
