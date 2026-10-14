/**
 * Standalone agent helper — the second build entry (`dist/agent-helper.js`). The daemon copies it into the
 * run dir at every start (`<run dir>/bin/agent-helper.mjs`) and agent processes run ONLY this file, never the
 * cli bundle, so a self-update or an install path the agent cannot read never breaks their git / gh / ssh:
 * `git-credential` (git credential helper), `git-token` (gh / glab shim token source), `net-connect` (ssh
 * `ProxyCommand`) and `self-check`. Node built-ins only; it reaches the daemon through its sockets.
 * @adr 0499
 */
import { connect } from "node:net";
import { runGitCredential, runGitToken } from "./commands/git-credential";
import { runNetConnect } from "./commands/net-connect";
import { GIT_TOKEN_SOCKET_ENV } from "./core/git/git-helper-env";

/** Give up reaching the git-token socket during a self-check after this long. */
const SELF_CHECK_TIMEOUT_MS = 5_000;

/**
 * `self-check`: prove the helper runs for the caller; when a git-token socket is set, also that the caller
 * can connect to it. Prints `ok`, or the reason on stderr with exit code 1.
 */
async function selfCheck(): Promise<void> {
  const socket = process.env[GIT_TOKEN_SOCKET_ENV];
  if (socket) {
    const error = await new Promise<string | null>((resolve) => {
      const s = connect(socket);
      const timer = setTimeout(() => {
        s.destroy();
        resolve("timed out connecting to the git-token socket");
      }, SELF_CHECK_TIMEOUT_MS);
      s.on("connect", () => {
        clearTimeout(timer);
        s.destroy();
        resolve(null);
      });
      s.on("error", (err) => {
        clearTimeout(timer);
        resolve(`cannot connect to the git-token socket: ${err.message}`);
      });
    });
    if (error) {
      process.stderr.write(`agent-helper: ${error}\n`);
      process.exitCode = 1;
      return;
    }
  }
  process.stdout.write("ok\n");
}

/** Dispatch one helper subcommand from argv. */
async function main(argv: readonly string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "git-credential":
      await runGitCredential(rest);
      break;
    case "git-token":
      await runGitToken(rest);
      break;
    case "net-connect":
      await runNetConnect(rest[0], rest[1]);
      break;
    case "self-check":
      await selfCheck();
      break;
    default:
      process.stderr.write("agent-helper: usage git-credential|git-token|net-connect|self-check …\n");
      process.exitCode = 2;
  }
}

void main(process.argv.slice(2));
