/**
 * `4pm git-credential <get|store|erase>` + `4pm git-token` — the worker side of GitHub-App
 * git-auth. git runs `git-credential` as its credential helper (configured by the daemon through its
 * process env, scoped to the App host); the `gh` shim runs `git-token`. Both ask the running `4pm start`
 * daemon — found via `FOURPM_PROFILE_DIR` — over its control socket for a short-lived token under the job
 * scope (`FOURPM_JOB_ID`). They print nothing when no token applies, so git / gh fall back to the worker's
 * own credentials. Never prints anything but the credential (stdout is the git protocol). On Self-managed
 * git auth the helper / shim name their host (`--host`, `--kind`) — several hosts may be active at once.
 * @adr 0356 @adr 0467
 */
import { connect } from "node:net";
import { join } from "node:path";
import { CONTROL_SOCKET_FILE, createFrameParser, encodeFrame, type ControlServerFrame } from "../core/control/control-protocol";
import { readControlToken } from "../core/control/control-token";
import { GIT_HOST_ENV, GIT_HOST_KIND_ENV, JOB_ID_ENV, PROFILE_DIR_ENV } from "../core/git/git-auth";
import { GIT_TOKEN_SOCKET_ENV } from "../core/git/git-token-server";

/** Give up on the daemon after this long (git would otherwise hang on the helper). */
const REQUEST_TIMEOUT_MS = 20_000;

/**
 * Ask the daemon for a token for `host`/`path`; null when unavailable. Under uid separation the
 * helper runs as the agent and uses the token-only socket (no control token — the group is the gate);
 * otherwise the control socket with its per-run token.
 * @adr 0430
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

/** Split `[--host h] [--kind k] [action]` into the fixed host/kind (Self-managed helper) and the rest. */
function parseFixed(args: readonly string[]): { host: string; kind: string; rest: string[] } {
  let host = "";
  let kind = "";
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === "--host") host = args[++i] ?? "";
    else if (a === "--kind") kind = args[++i] ?? "";
    else rest.push(a);
  }
  return { host: host.toLowerCase(), kind, rest };
}

/**
 * git credential helper: answer `get` for https on the helper's host with `x-access-token:<token>`
 * (`oauth2` for GitLab); `store`/`erase` are no-ops (the daemon owns the tokens). The host is the App host
 * from the env, or the `--host` a Self-managed helper was configured with.
 */
export async function runGitCredential(args: readonly string[]): Promise<void> {
  const fixed = parseFixed(args);
  const action = fixed.rest[0];
  if (action !== "get") {
    // Drain stdin so git doesn't see a broken pipe.
    await readCredentialInput().catch(() => undefined);
    return;
  }
  const input = await readCredentialInput();
  const host = (input.host ?? "").toLowerCase();
  const expected = fixed.host || (process.env[GIT_HOST_ENV] ?? "").toLowerCase();
  if (input.protocol !== "https" || !host || host !== expected) return;
  const token = await requestToken(host, input.path ?? "");
  // GitLab accepts the token as the password with username `oauth2` (ADR-0382); GitHub uses x-access-token.
  const kind = fixed.host ? fixed.kind : (process.env[GIT_HOST_KIND_ENV] ?? "");
  const username = kind === "gitlab" ? "oauth2" : "x-access-token";
  if (token) process.stdout.write(`username=${username}\npassword=${token}\n`);
}

/** `gh` / `glab` shim helper: print a token for the App host (or the shim's `--host`) — empty ⇒ nothing. */
export async function runGitToken(args: readonly string[]): Promise<void> {
  const host = parseFixed(args).host || (process.env[GIT_HOST_ENV] ?? "");
  if (!host) return;
  const token = await requestToken(host, "");
  if (token) process.stdout.write(`${token}\n`);
}
