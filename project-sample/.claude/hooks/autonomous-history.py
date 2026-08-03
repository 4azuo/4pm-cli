#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Manage .claude/.autonomous.histories.json — the SINGLE file combining the autonomous workflow's state + history.

Structure:
{
  "cron_applied": "*/10 * * * *",     # the cron schedule applied last time (to detect a schedule change)
  "consecutive_fails": 0,              # number of CONSECUTIVE failed command runs (reset on success)
  "ticks": {"day": "YYYY-MM-DD", "count": N},  # count of ticks that actually invoked Claude today
  "records": [ {...}, ... ]            # cron run history, NEWEST LAST, at most 50 records
}

Each record:
{
  "ts": "YYYY-MM-DD HH:MM:SS",
  "status": "success" | "failure" | "skip",
  "rc": <int|null>,                    # the command's exit code (null if it didn't run)
  "gate": "<token-gate string>",
  "note": "<short note>",
  "command": "/auto-cycle",
  "tick": "YYYY-MM-DD #N",             # day + tick number within the day
  "config": { cron_schedule, model, max_session_pct, max_weekly_pct, quiet_hours,
              max_ticks_per_day, stop_on_consecutive_failures, paused }
}

Usage (the file path is the first arg):
  history.py <file> migrate <cron-applied> <fails> <ticks>   # one-time load from 3 old files (paths)
  history.py <file> get-cron
  history.py <file> set-cron <schedule>
  history.py <file> get-fails
  history.py <file> set-fails <n>
  history.py <file> get-ticks <today>         # print the count for 'today' (0 if a different day/missing)
  history.py <file> set-ticks <day> <count>
  history.py <file> record <ts> <status> <rc> <gate> <note>   # config is read from the CFG_* env vars

Philosophy: NEVER break on a missing/corrupt file — always initialize the default skeleton.
"""
import json
import os
import sys

MAX_RECORDS = 50

SKELETON = {
    "cron_applied": "",
    "consecutive_fails": 0,
    "ticks": {"day": "", "count": 0},
    "records": [],
}


def load(path):
    try:
        with open(path, encoding="utf-8") as f:
            d = json.load(f)
        if not isinstance(d, dict):
            raise ValueError("not an object")
    except Exception:
        d = {}
    out = dict(SKELETON)
    out.update({k: d[k] for k in SKELETON if k in d})
    if not isinstance(out.get("ticks"), dict):
        out["ticks"] = dict(SKELETON["ticks"])
    if not isinstance(out.get("records"), list):
        out["records"] = []
    return out


def save(path, d):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(d, f, ensure_ascii=False, indent=2)
        f.write("\n")
    os.replace(tmp, path)


def cfg_from_env():
    def g(k, default=""):
        return os.environ.get(k, default)
    return {
        "cron_schedule": g("CFG_CRON_SCHEDULE"),
        "model": g("CFG_MODEL"),
        "max_session_pct": g("CFG_MAX_SESSION_PCT"),
        "max_weekly_pct": g("CFG_MAX_WEEKLY_PCT"),
        "quiet_hours": g("CFG_QUIET_HOURS"),
        "max_ticks_per_day": g("CFG_MAX_TICKS_PER_DAY"),
        "stop_on_consecutive_failures": g("CFG_STOP_ON_CONSEC_FAILURES"),
        "paused": g("CFG_PAUSED"),
    }


def main():
    if len(sys.argv) < 3:
        sys.stderr.write("missing args: <file> <op> [...]\n")
        return 2
    path = sys.argv[1]
    op = sys.argv[2]
    args = sys.argv[3:]
    d = load(path)

    if op == "get-cron":
        sys.stdout.write(str(d.get("cron_applied", "")))
        return 0

    if op == "set-cron":
        d["cron_applied"] = args[0] if args else ""
        save(path, d)
        return 0

    if op == "get-fails":
        sys.stdout.write(str(int(d.get("consecutive_fails", 0) or 0)))
        return 0

    if op == "set-fails":
        d["consecutive_fails"] = int(args[0]) if args else 0
        save(path, d)
        return 0

    if op == "get-ticks":
        today = args[0] if args else ""
        t = d.get("ticks", {})
        sys.stdout.write(str(int(t.get("count", 0) or 0) if t.get("day") == today else 0))
        return 0

    if op == "set-ticks":
        day = args[0] if len(args) > 0 else ""
        count = int(args[1]) if len(args) > 1 else 0
        d["ticks"] = {"day": day, "count": count}
        save(path, d)
        return 0

    if op == "record":
        ts = args[0] if len(args) > 0 else ""
        status = args[1] if len(args) > 1 else ""
        rc_raw = args[2] if len(args) > 2 else ""
        gate = args[3] if len(args) > 3 else ""
        note = args[4] if len(args) > 4 else ""
        try:
            rc = int(rc_raw)
        except (ValueError, TypeError):
            rc = None
        t = d.get("ticks", {})
        rec = {
            "ts": ts,
            "status": status,
            "rc": rc,
            "gate": gate,
            "note": note,
            "command": os.environ.get("CFG_COMMAND", ""),
            "tick": "%s #%s" % (t.get("day", ""), t.get("count", 0)),
            "config": cfg_from_env(),
        }
        d["records"].append(rec)
        if len(d["records"]) > MAX_RECORDS:
            d["records"] = d["records"][-MAX_RECORDS:]
        save(path, d)
        return 0

    if op == "migrate":
        # Only load when histories.json has no real data yet (don't overwrite live data).
        cron_p = args[0] if len(args) > 0 else ""
        fails_p = args[1] if len(args) > 1 else ""
        ticks_p = args[2] if len(args) > 2 else ""

        def read_txt(p):
            try:
                with open(p, encoding="utf-8") as f:
                    return f.read().strip()
            except Exception:
                return ""

        if cron_p and not d.get("cron_applied"):
            v = read_txt(cron_p)
            if v:
                d["cron_applied"] = v
        if fails_p and not d.get("consecutive_fails"):
            v = read_txt(fails_p)
            if v.isdigit():
                d["consecutive_fails"] = int(v)
        if ticks_p and not d.get("ticks", {}).get("day"):
            parts = read_txt(ticks_p).split()
            if len(parts) == 2 and parts[1].isdigit():
                d["ticks"] = {"day": parts[0], "count": int(parts[1])}
        save(path, d)
        return 0

    sys.stderr.write("invalid op: %s\n" % op)
    return 2


if __name__ == "__main__":
    sys.exit(main())
