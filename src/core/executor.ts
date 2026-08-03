/**
 * Executor — spawn an external CLI (claude/gh/shell…) per command.dispatch,
 * collect output through OutputBatcher (backpressure — command-0003) then push it
 * back to the server on the command.output channel.
 */
import { spawn } from "node:child_process";
import { OutputBatcher, type CommandDispatchPayload, type CommandOutputPayload } from "@4pm/ws";

/**
 * Run a single command and stream its output in batches.
 * @param dispatch payload from the server
 * @param emit     send one command.output message back to the server
 */
export async function runCommand(
  dispatch: CommandDispatchPayload,
  emit: (output: CommandOutputPayload) => void,
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
      batcher.flush();
      emit({
        commandId: dispatch.commandId,
        seq: seq++,
        chunk: "",
        done: true,
        exitCode: exitCode ?? -1,
      });
      resolve();
    });
    child.on("error", (err) => {
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
