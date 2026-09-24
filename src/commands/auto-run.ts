/**
 * `4pm auto-run` (ADR-0319) — run ONE autonomous cycle through the already-running `4pm start` daemon,
 * over its per-profile control socket (ADR-0192 §2). The cron tick calls this instead of the old raw
 * `claude -p /auto-cycle`, so the cycle rides the daemon's live WS session: profile/quota failover
 * (ADR-0182), token metering (ADR-0072), folder-scope (ADR-0181) and the AI-run timeout (ADR-0243).
 * Streams the daemon's transcript to stdout (the tick log captures it) and exits 0 on completion,
 * non-zero when the daemon isn't running or the cycle failed to dispatch.
 */
import { connect } from "node:net";
import { join } from "node:path";
import { readProfileConfig } from "../config/profile";
import {
  CONTROL_SOCKET_FILE,
  createFrameParser,
  encodeFrame,
  type ControlServerFrame,
} from "../core/control-protocol";
import { readControlToken } from "../core/control-token";
import { initI18n, t } from "../i18n";

/** Hard ceiling so a stuck cycle can't hang the cron tick forever (the daemon's own ADR-0243 timeout
 * bounds the AI run; this is only a last-resort net). */
const AUTO_RUN_TIMEOUT_MS = 3 * 60 * 60 * 1000;

/**
 * Connect to the daemon serving `profileName`, ask it to run one autonomous cycle, stream its output,
 * and resolve the process exit code (0 = ran, 1 = no daemon / dispatch error).
 */
export async function runAutoRun(profileDir: string, profileName: string): Promise<void> {
  initI18n(readProfileConfig(profileDir).locale);
  const socketPath = join(profileDir, CONTROL_SOCKET_FILE);
  const token = readControlToken(profileDir);

  const code = await new Promise<number>((resolve) => {
    let settled = false;
    const done = (c: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      resolve(c);
    };

    const socket = connect(socketPath);
    socket.setEncoding("utf8");

    const timer = setTimeout(() => {
      console.error(t("autoRun.timeout"));
      done(1);
    }, AUTO_RUN_TIMEOUT_MS);
    timer.unref?.();

    socket.on("connect", () => {
      // Authenticate first (ADR-0320), then trigger exactly one cycle; the daemon reports back with an
      // `autonomousDone` frame. The token must be the FIRST frame or the daemon drops the connection.
      try {
        socket.write(encodeFrame({ t: "auth", token: token ?? "" }));
        socket.write(encodeFrame({ t: "autonomousRun" }));
      } catch {
        done(1);
      }
    });

    const parse = createFrameParser<ControlServerFrame>();
    socket.on("data", (chunk: string) => {
      for (const frame of parse(chunk)) {
        if (frame.t === "transcript") {
          if (frame.entry.text) console.log(frame.entry.text);
        } else if (frame.t === "update") {
          if (frame.text) console.log(frame.text);
        } else if (frame.t === "autonomousDone") {
          if (frame.ok) console.log(t("autoRun.done"));
          else console.error(t("autoRun.failed", { note: frame.note ?? "" }));
          done(frame.ok ? 0 : 1);
        } else if (frame.t === "authError") {
          // The daemon rejected our token (ADR-0320) — treat as a failed tick.
          console.error(t("autoRun.authFailed"));
          done(1);
        }
      }
    });

    socket.on("error", () => {
      // No daemon listening (not started, or crashed) — the tick treats this as a failure.
      console.error(t("autoRun.noDaemon", { profile: profileName }));
      done(1);
    });
    socket.on("close", () => done(1));
  });

  process.exitCode = code;
}
