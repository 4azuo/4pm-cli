/**
 * Executor — spawn an external CLI (claude/gh/shell…) per command.dispatch,
 * collect output through OutputBatcher (backpressure — command-0003) then push it
 * back to the server on the command.output channel.
 */
import { spawn } from "node:child_process";
import { OutputBatcher, type CommandDispatchPayload, type CommandOutputPayload } from "@4pm/ws";

/** Grace period after SIGTERM before a hard SIGKILL when a run is timed out (ADR-0243). */
const KILL_GRACE_MS = 5_000;

/** Options for one command run. */
export interface RunCommandOptions {
  /**
   * Wall-clock ceiling (ms) for the spawned process (ADR-0243). On expiry the child is killed
   * (SIGTERM → SIGKILL) and the run settles with a non-zero exit + a note chunk, so a hung/looping
   * AI CLI can't leave the dispatch waiting on a `done` frame forever. Omitted/0 ⇒ no cap.
   */
  timeoutMs?: number;
}

/**
 * Run a single command and stream its output in batches.
 * @param dispatch payload from the server
 * @param emit     send one command.output message back to the server
 * @param opts     optional per-run controls (e.g. a wall-clock timeout — ADR-0243)
 */
export async function runCommand(
  dispatch: CommandDispatchPayload,
  emit: (output: CommandOutputPayload) => void,
  opts?: RunCommandOptions,
): Promise<void> {
  let seq = 0;
  const child = spawn(dispatch.cmd, dispatch.args ?? [], {
    cwd: dispatch.path,
    env: { ...process.env, ...dispatch.env },
    shell: false,
  });
  // No stdin is piped to spawned CLIs — close it so tools that probe stdin (e.g. the
  // AI CLIs) get EOF immediately instead of blocking for input.
  child.stdin?.end();

  // Wall-clock timeout (ADR-0243): on expiry, note it in the stream then kill the child. The
  // `close`/`error` handler below still fires and emits the terminal `done` (exit 124 = timed out),
  // which is what stops a spinning dispatcher. A hard SIGKILL follows if SIGTERM is ignored.
  const timeoutMs = opts?.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : 0;
  let timedOut = false;
  let hardKillTimer: ReturnType<typeof setTimeout> | null = null;
  const timeoutTimer =
    timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          emit({
            commandId: dispatch.commandId,
            seq: seq++,
            chunk: `\n[4PM] AI run exceeded the ${Math.round(timeoutMs / 1000)}s time limit — terminating.\n`,
          });
          child.kill("SIGTERM");
          hardKillTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
          hardKillTimer.unref?.();
        }, timeoutMs)
      : null;
  timeoutTimer?.unref?.();
  /** Clear both timers once the run settles (idempotent). */
  const clearTimers = (): void => {
    if (timeoutTimer) clearTimeout(timeoutTimer);
    if (hardKillTimer) clearTimeout(hardKillTimer);
  };

  const batcher = new OutputBatcher({
    onFlush: (chunk, truncated) => {
      emit({ commandId: dispatch.commandId, seq: seq++, chunk, truncated });
    },
    onPressure: (paused) => {
      // Backpressure: pause reading the child process's stdout/stderr
      if (paused) {
        child.stdout?.pause();
        child.stderr?.pause();
      } else {
        child.stdout?.resume();
        child.stderr?.resume();
      }
    },
  });

  child.stdout?.on("data", (data: Buffer) => batcher.push(data.toString("utf8")));
  child.stderr?.on("data", (data: Buffer) => batcher.push(data.toString("utf8")));

  await new Promise<void>((resolve) => {
    child.on("close", (exitCode) => {
      clearTimers();
      batcher.flush();
      emit({
        commandId: dispatch.commandId,
        seq: seq++,
        chunk: "",
        done: true,
        // 124 (the conventional timeout code) when we killed it for exceeding the limit, so the
        // server settles the command as failed and the web surfaces the note instead of spinning.
        exitCode: timedOut ? 124 : (exitCode ?? -1),
      });
      resolve();
    });
    child.on("error", (err) => {
      clearTimers();
      emit({
        commandId: dispatch.commandId,
        seq: seq++,
        chunk: `spawn error: ${err.message}\n`,
        done: true,
        exitCode: -1,
      });
      resolve();
    });
  });
}
