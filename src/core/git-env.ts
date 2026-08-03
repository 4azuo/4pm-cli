/**
 * Worker git + AI CLI environment probe (machine-0008, git.env channel): the
 * server asks the project cli whether `gh`/`glab` are installed & authenticated
 * and whether the Claude CLI is present — prerequisites shown before Create/Add.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GitEnvReply } from "@4pm/ws";

const run = promisify(execFile);

/** Whether a CLI binary responds (used to detect installation). */
async function hasBinary(bin: string, args: string[] = ["--version"]): Promise<boolean> {
  try {
    await run(bin, args, { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Probe the provider CLI (`gh`/`glab`) install + auth (+ account) and the Claude
 * CLI presence. Never throws — failures map to the "not available" defaults.
 */
export async function checkGitEnv(provider: string): Promise<GitEnvReply> {
  const bin = provider === "glab" ? "glab" : "gh";
  const installed = await hasBinary(bin);
  let authenticated = false;
  let account: string | null = null;
  if (installed) {
    try {
      // `auth status` exits non-zero when not logged in ⇒ caught below.
      const { stdout, stderr } = await run(bin, ["auth", "status"], { timeout: 8000 });
      const out = `${stdout}\n${stderr}`;
      authenticated = /logged in|logged into|✓/i.test(out);
      account = out.match(/as\s+([\w.-]+)/i)?.[1] ?? null;
    } catch {
      // Not authenticated — keep the defaults.
    }
  }
  const claudeCli = await hasBinary("claude");
  return { installed, authenticated, account, claudeCli };
}
