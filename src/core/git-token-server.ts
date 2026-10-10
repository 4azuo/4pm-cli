/**
 * The git-token socket (ADR-0430 phase 2). Under uid separation the agent's git credential helper and
 * gh/glab shims (ADR-0356/0382) cannot use the control socket: that one is owner-only and also accepts
 * prompts and commands. This second socket, in the agent-readable run dir and group-connectable, answers
 * ONLY `gitToken` requests — the short-lived token for the job scope / host / repo path the helper asks for —
 * and ignores every other frame. One request per connection. Started only while separation is on.
 */
import { chmodSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { createFrameParser, encodeFrame, type ControlClientFrame, type ControlServerFrame } from "./control-protocol";
import { issueGitToken } from "./git-auth";
import { prepareAgentRunDir, readOnlyForAgent } from "../utils/agent-user";
import { logger } from "../common/logger/logger";

/** Env var naming the socket for the helper / shims (allow-listed into agent processes). */
export const GIT_TOKEN_SOCKET_ENV = "FOURPM_GIT_TOKEN_SOCKET";
/** Socket file name inside the run dir. */
const SOCKET_FILE = "git-token.sock";
/** Drop a connection that sends nothing useful within this long. */
const IDLE_MS = 30_000;

/** Write one frame, ignoring a dead socket. */
function send(sock: Socket, frame: ControlServerFrame): void {
  try {
    sock.write(encodeFrame(frame));
  } catch {
    /* closed */
  }
}

/**
 * Start the git-token socket for `profileDir` and export its path to child processes; returns stop().
 * A no-op stop when separation is off or the socket cannot be created (git then falls back to the
 * worker's own credentials, as when no token applies).
 */
export function startGitTokenServer(profileDir: string): () => void {
  const runDir = prepareAgentRunDir(profileDir);
  if (!runDir) return () => undefined;
  const socketPath = join(runDir, SOCKET_FILE);
  try {
    rmSync(socketPath, { force: true });
  } catch {
    /* stale socket from a crashed run */
  }
  const server = createServer((sock) => {
    sock.setEncoding("utf8");
    sock.setTimeout(IDLE_MS, () => sock.destroy());
    const parse = createFrameParser<ControlClientFrame>();
    let answered = false;
    sock.on("data", (chunk: string) => {
      for (const frame of parse(chunk)) {
        // Only the token request is served here — never submit / reconnect / autonomous frames.
        if (frame.t !== "gitToken" || answered) continue;
        answered = true;
        void issueGitToken(frame.scope, frame.host, frame.path)
          .catch(() => null)
          .then((token) => {
            send(sock, { t: "gitToken", token });
            sock.end();
          });
      }
    });
    sock.on("error", () => sock.destroy());
  });
  server.on("error", (err) => logger.warn("git.token.socket.error", { error: String(err) }));
  server.listen(socketPath, () => {
    try {
      // Connect needs write on the inode: owner + the shared group (the agent), nobody else.
      chmodSync(socketPath, 0o660);
      readOnlyForAgent(socketPath, 0o660);
      process.env[GIT_TOKEN_SOCKET_ENV] = socketPath;
    } catch (err) {
      logger.warn("git.token.socket.perms", { error: String(err) });
    }
  });
  return () => {
    delete process.env[GIT_TOKEN_SOCKET_ENV];
    server.close();
    try {
      rmSync(socketPath, { force: true });
    } catch {
      /* ignore */
    }
  };
}
