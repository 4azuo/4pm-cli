/**
 * Claude subscription usage (ADR-0072) — the same data as the built-in `/usage` screen
 * (5h + weekly utilization). Two sources, best-effort in order:
 *   1. Anthropic OAuth usage API (fast, gives reset times) using the profile's token read
 *      from `<claudeHome profile dir>/.credentials.json`.
 *   2. Fallback: run `<aiCli> /usage` (headless) and parse the printed percentages — this
 *      also rotates an expired OAuth token. Robust when the API is unreachable.
 * Only the derived snapshot (%, reset, plan, profile) leaves the machine — never the token.
 * Fail-safe: returns null on any unrecoverable error.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { MachineUsagePayload } from "@4pm/ws";
import { profileDisplayLabel } from "../utils/ai-cli";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

/** The OAuth block inside `.credentials.json` (only the fields we read). */
interface Creds {
  accessToken?: string;
  subscriptionType?: string;
}

/** Read + parse one credentials file; null when absent or without a token. */
function readCreds(dir: string): Creds | null {
  try {
    const raw = JSON.parse(readFileSync(join(dir, ".credentials.json"), "utf8")) as Record<string, unknown>;
    const oauth = (raw.claudeAiOauth ?? raw) as Creds;
    return oauth.accessToken ? oauth : null;
  } catch {
    return null;
  }
}

/** First config dir that holds usable OAuth credentials, or null. */
function findCredsDir(dirs: string[]): string | null {
  for (const dir of dirs) if (readCreds(dir)) return dir;
  return null;
}

/** Anthropic usage API response (only the fields we read). */
interface UsageApiResponse {
  five_hour?: { utilization?: number; resets_at?: string | null };
  seven_day?: { utilization?: number; resets_at?: string | null };
  extra_usage?: { is_enabled?: boolean; used_credits?: number; decimal_places?: number; currency?: string };
}

/** Query the usage API with a bearer token; null on any HTTP/network error. */
async function fetchUsage(token: string): Promise<UsageApiResponse | null> {
  try {
    const res = await fetch(USAGE_URL, {
      headers: {
        authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
        "user-agent": "claude-cli/2.0.0 (external, cli)",
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    return (await res.json()) as UsageApiResponse;
  } catch {
    return null;
  }
}

/**
 * Run `<aiCli> /usage` headless with the profile's config dir; capture stdout (bounded).
 * Returns the printed text (also rotates an expired OAuth token as a side effect).
 */
function runUsageCli(dir: string, aiCli: string): Promise<string> {
  return new Promise((resolve) => {
    let out = "";
    let child: ReturnType<typeof spawn> | null = null;
    const finish = (): void => {
      clearTimeout(timer);
      resolve(out);
    };
    const timer = setTimeout(() => {
      child?.kill();
      resolve(out);
    }, 30_000);
    timer.unref?.();
    try {
      child = spawn(aiCli, ["/usage"], {
        env: { ...process.env, CLAUDE_CONFIG_DIR: dir },
        stdio: ["ignore", "pipe", "ignore"],
      });
      child.stdout?.on("data", (d: Buffer) => {
        out += d.toString("utf8");
      });
      child.on("exit", finish);
      child.on("error", finish);
    } catch {
      finish();
    }
  });
}

/** Parse the `/usage` screen text → session + weekly utilization %, or null. */
function parseUsageText(text: string): { session: number; weekly: number } | null {
  const session = /current session:\s*(\d+)%/i.exec(text);
  const weekly = /current week[^:]*:\s*(\d+)%/i.exec(text);
  if (!session && !weekly) return null;
  return { session: Number(session?.[1] ?? 0), weekly: Number(weekly?.[1] ?? 0) };
}

/** Build the wire snapshot from an API response. */
function fromApi(data: UsageApiResponse, creds: Creds | null, dir: string, aiCli: string): MachineUsagePayload {
  const fh = data.five_hour ?? {};
  const sd = data.seven_day ?? {};
  const payload: MachineUsagePayload = {
    plan: creds?.subscriptionType ?? "?",
    aiCli,
    profile: profileDisplayLabel(dir),
    session: { utilizationPct: Math.round(fh.utilization ?? 0), resetsAt: fh.resets_at ?? null },
    weekly: { utilizationPct: Math.round(sd.utilization ?? 0), resetsAt: sd.resets_at ?? null },
    checkedAt: new Date().toISOString(),
  };
  const extra = data.extra_usage;
  if (extra?.is_enabled && extra.used_credits) {
    const dp = extra.decimal_places ?? 2;
    payload.extra = { usedCredits: extra.used_credits / 10 ** dp, currency: extra.currency ?? "USD" };
  }
  return payload;
}

/** Build the wire snapshot from parsed `/usage` text (% only; no reset times). */
function fromText(parsed: { session: number; weekly: number }, creds: Creds | null, dir: string, aiCli: string): MachineUsagePayload {
  return {
    plan: creds?.subscriptionType ?? "?",
    aiCli,
    profile: profileDisplayLabel(dir),
    session: { utilizationPct: parsed.session, resetsAt: null },
    weekly: { utilizationPct: parsed.weekly, resetsAt: null },
    checkedAt: new Date().toISOString(),
  };
}

/**
 * Resolve the subscription usage snapshot: OAuth API first (with a `/usage` token refresh
 * + retry), then a `/usage` text parse. Returns null only when no source yields data.
 */
export async function checkClaudeUsage(dirs: string[], aiCli = "claude"): Promise<MachineUsagePayload | null> {
  const dir = findCredsDir(dirs) ?? dirs[0];
  if (!dir) return null;
  const creds = readCreds(dir);

  // 1. OAuth API with the current token.
  if (creds?.accessToken) {
    const api = await fetchUsage(creds.accessToken);
    if (api) return fromApi(api, creds, dir, aiCli);
  }

  // 2. Run `/usage` (rotates the token + prints the numbers). Only claude supports it.
  if (!aiCli.includes("claude")) return null;
  const text = await runUsageCli(dir, aiCli);

  // 2a. Token may have been refreshed ⇒ retry the API (gives reset times).
  const refreshed = readCreds(dir);
  if (refreshed?.accessToken && refreshed.accessToken !== creds?.accessToken) {
    const api2 = await fetchUsage(refreshed.accessToken);
    if (api2) return fromApi(api2, refreshed, dir, aiCli);
  }

  // 2b. Fall back to parsing the printed percentages.
  const parsed = parseUsageText(text);
  return parsed ? fromText(parsed, refreshed ?? creds, dir, aiCli) : null;
}
