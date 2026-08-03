#!/usr/bin/env python3
"""Fetch Claude Code plan-usage limits (same data as the built-in /usage screen).

Reads the OAuth access token from ~/.claude/.credentials.json and queries the
Anthropic usage endpoint, then prints session + weekly utilization and reset times
in the local timezone.
"""
import json
import os
import subprocess
import sys
import urllib.request
import urllib.error
from datetime import datetime, timezone

# Windows consoles default to cp1252 which can't encode the emoji/bar glyphs.
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")
    except Exception:
        pass

CRED_PATH = os.path.expanduser("~/.claude/.credentials.json")
URL = "https://api.anthropic.com/api/oauth/usage"


class UsageError(Exception):
    """Recoverable failure while loading the token or calling the usage API.
    Raised (instead of exiting) so the caller can refresh the token and retry once."""


def load_token():
    try:
        with open(CRED_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError:
        raise UsageError(f"Credentials not found: {CRED_PATH} (log in to Claude Code first).")
    oauth = data.get("claudeAiOauth", data)
    token = oauth.get("accessToken")
    if not token:
        raise UsageError("No accessToken in credentials.")
    exp = oauth.get("expiresAt")
    if exp and datetime.now(timezone.utc).timestamp() * 1000 > exp:
        print("Warning: token may be expired — run /usage once in Claude Code to refresh.\n",
              file=sys.stderr)
    return token, oauth.get("subscriptionType", "?")


def fetch(token):
    req = urllib.request.Request(URL, headers={
        "Authorization": f"Bearer {token}",
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": "claude-cli/2.0.0 (external, cli)",
    })
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")[:300]
        raise UsageError(f"API error HTTP {e.code}: {body}")
    except urllib.error.URLError as e:
        raise UsageError(f"Could not reach API: {e.reason}")


def get_usage():
    """Load the token and query the usage API. Raises UsageError on any failure."""
    token, sub = load_token()
    return fetch(token), sub


def refresh_token():
    """Best-effort token refresh: run `claude /usage`, which refreshes the OAuth
    token on startup. On Windows we go through `wsl` (the credentials this script
    reads live in WSL); on POSIX we call `claude` directly. Output is discarded and
    the call is bounded by a timeout so it can never hang the usage check."""
    cmd = ["wsl", "claude", "/usage"] if sys.platform == "win32" else ["claude", "/usage"]
    print(f"Refreshing token via: {' '.join(cmd)}", file=sys.stderr)
    try:
        subprocess.run(
            cmd, timeout=60,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except Exception as e:
        print(f"Token refresh attempt failed: {e}", file=sys.stderr)


def fmt_reset(iso):
    if not iso:
        return "?"
    dt = datetime.fromisoformat(iso).astimezone()  # -> local tz
    return f"{dt:%a %d/%m %H:%M}"


def save_last_result(record):
    """Delete the previous ./output/last-usage-check.json, then write a fresh one
    holding this run's result. Console output is still printed by the caller."""
    out_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "output")
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, "last-usage-check.json")
    # Remove the stale file first, then recreate it from scratch.
    try:
        os.remove(out_path)
    except FileNotFoundError:
        pass
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(record, f, ensure_ascii=False, indent=2)
    return out_path


def main():
    try:
        data, sub = get_usage()
    except UsageError as e:
        # First attempt failed — try to refresh the token once, then retry once.
        print(f"Usage check failed: {e}", file=sys.stderr)
        refresh_token()
        try:
            data, sub = get_usage()
        except UsageError as e2:
            print(f"Still failing after token refresh — skipping: {e2}", file=sys.stderr)
            sys.exit(1)

    if "--json" in sys.argv:
        print(json.dumps(data, indent=2))
        return

    fh = data.get("five_hour") or {}
    sd = data.get("seven_day") or {}

    lines = [
        f"- Plan: {sub}",
        f"- Session: {fh.get('utilization', 0):.0f}% — reset {fmt_reset(fh.get('resets_at'))}",
        f"- Weekly: {sd.get('utilization', 0):.0f}% — reset {fmt_reset(sd.get('resets_at'))}",
    ]
    extra = data.get("extra_usage") or {}
    if extra.get("is_enabled") and extra.get("used_credits"):
        dp = extra.get("decimal_places", 2)
        lines.append(f"- Extra: {extra['used_credits'] / (10 ** dp):.2f} {extra.get('currency', 'USD')}")

    summary = "\n".join(lines)
    print(summary)  # keep the console output

    # Persist this run's result so the autonomous workflow can read it back.
    record = {
        "checked_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "plan": sub,
        "session_pct": fh.get("utilization", 0),
        "weekly_pct": sd.get("utilization", 0),
        "session_resets_at": fh.get("resets_at"),
        "weekly_resets_at": sd.get("resets_at"),
        "summary": summary,
        "raw": data,
    }
    out_path = save_last_result(record)
    print(f"\nSaved result to: {out_path}")


if __name__ == "__main__":
    main()
