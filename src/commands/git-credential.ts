/**
 * `4pm git-credential <get|store|erase>` + `4pm git-token` (ADR-0356) — the worker side of GitHub-App
 * git-auth. git runs `git-credential` as its credential helper (configured by the daemon through its
 * process env, scoped to the App host); the `gh` shim runs `git-token`. Both ask the running `4pm start`
 * daemon — found via `FOURPM_PROFILE_DIR` — over its control socket for a short-lived token under the job
 * scope (`FOURPM_JOB_ID`). They print nothing when no token applies, so git / gh fall back to the worker's
 * own credentials. Never prints anything but the credential (stdout is the git protocol).
 */
import { connect } from "node:net";
import { join } from "node:path";
import { CONTROL_SOCKET_FILE, createFrameParser, encodeFrame, type ControlServerFrame } from "../core/control-protocol";
import { readControlToken } from "../core/control-token";
import { GIT_HOST_ENV, GIT_HOST_KIND_ENV, JOB_ID_ENV, PROFILE_DIR_ENV } from "../core/git-auth";
import { GIT_TOKEN_SOCKET_ENV } from "../core/git-token-server";

/** Give up on the daemon after this long (git would otherwise hang on the helper). */
const REQUEST_TIMEOUT_MS = 20_000;

/**
 * Ask the daemon for a token for `host`/`path`; null when unavailable. Under uid separation (ADR-0430) the
 * helper runs as the agent and uses the token-only socket (no control token — the group is the gate);
 * otherwise the control socket with its per-run token.
 */
function requestToken(host: string, path: string): Promise<string | null> {
  const tokenSocket = process.env[GIT_TOKEN_SOCKET_ENV];
  const profileDir = process.env[PROFILE_DIR_ENV];
  if (!tokenSocket && !profileDir) return Promise.resolve(null);
  const token = tokenSocket ? null : readControlToken(profileDir!);
  return new Promise((resolve) => {
    let done = false;
    const finish = (value: string | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const socket = connect(tokenSocket ?? join(profileDir!, CONTROL_SOCKET_FILE));
    socket.setEncoding("utf8");
    const timer = setTimeout(() => finish(null), REQUEST_TIMEOUT_MS);
    socket.on("connect", () => {
      try {
        if (!tokenSocket) socket.write(encodeFrame({ t: "auth", token: token ?? "", rpc: true }));
        socket.write(encodeFrame({ t: "gitToken", scope: process.env[JOB_ID_ENV] ?? "", host, path }));
      } catch {
        finish(null);
      }
    });
    const parse = createFrameParser<ControlServerFrame>();
    socket.on("data", (chunk: string) => {
      for (const frame of parse(chunk)) {
        if (frame.t === "gitToken") finish(frame.token);
        else if (frame.t === "authError") finish(null);
      }
    });
    socket.on("error", () => finish(null));
    socket.on("close", () => finish(null));
  });
}

/** Read git's `key=value` credential description from stdin. */
async function readCredentialInput(): Promise<Record<string, string>> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const out: Record<string, string> = {};
  for (const line of Buffer.concat(chunks).toString("utf8").split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1).trim();
  }
  return out;
}

/**
 * git credential helper: answer `get` for https on the App host with `x-access-token:<token>`;
 * `store`/`erase` are no-ops (tokens are short-lived and revoked by the daemon).
 */
export async function runGitCredential(action: string | undefined): Promise<void> {
  if (action !== "get") {
    // Drain stdin so git doesn't see a broken pipe.
    await readCredentialInput().catch(() => undefined);
    return;
  }
  const input = await readCredentialInput();
  const host = (input.host ?? "").toLowerCase();
  if (input.protocol !== "https" || !host || host !== (process.env[GIT_HOST_ENV] ?? "").toLowerCase()) return;
  const token = await requestToken(host, input.path ?? "");
  // GitLab accepts the token as the password with username `oauth2` (ADR-0382); GitHub uses x-access-token.
  const username = (process.env[GIT_HOST_KIND_ENV] ?? "") === "gitlab" ? "oauth2" : "x-access-token";
  if (token) process.stdout.write(`username=${username}\npassword=${token}\n`);
}

/** `gh` shim helper: print a token for the App host's primary repo (empty ⇒ nothing). */
export async function runGitToken(): Promise<void> {
  const host = process.env[GIT_HOST_ENV] ?? "";
  if (!host) return;
  const token = await requestToken(host, "");
  if (token) process.stdout.write(`${token}\n`);
}
