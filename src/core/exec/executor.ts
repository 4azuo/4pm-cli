/**
 * Executor — spawn an external CLI (claude/gh/shell…) per command.dispatch,
 * collect output through OutputBatcher (backpressure) then push it
 * back to the server on the command.output channel.
 * @api command-0003
 */
import { spawn } from "node:child_process";
import {
  COMMAND_CANCELLED_EXIT_CODE,
  OutputBatcher,
  type CommandDispatchPayload,
  type CommandOutputPayload,
} from "@4pm/ws";
import { endGitScope, JOB_ID_ENV } from "../git/git-auth";
import { agentProcessEnv, agentSpawnArgs } from "../agent/agent-spawn";
import { agentUser } from "../../utils/agent-user";
import { egressEnv } from "../network/egress-env";

/** Grace period after SIGTERM before a hard SIGKILL when a run is timed out. @adr 0243 */
const KILL_GRACE_MS = 5_000;

/** Options for one command run. */
export interface RunCommandOptions {
  /**
   * Wall-clock ceiling (ms) for the spawned process. On expiry the child is killed
   * (SIGTERM → SIGKILL) and the run settles with a non-zero exit + a note chunk, so a hung/looping
   * AI CLI can't leave the dispatch waiting on a `done` frame forever. Omitted/0 ⇒ no cap.
   * @adr 0243
   */
  timeoutMs?: number;
  /**
   * Prompt to feed on the child's **stdin** instead of as an argv positional. An AI
   * prompt can be large (a full-spec review embeds all 62 fields); a single argv element is capped
   * at Linux's 128 KiB `MAX_ARG_STRLEN`, above which `spawn` throws `E2BIG`. `claude -p` / `codex
   * exec` both read a prompt from stdin, so the dispatch AI runs pass it here. Omitted ⇒ stdin is
   * closed empty (the default for non-AI console commands).
   * @adr 0251
   */
  stdin?: string;
  /**
   * Stop signal: on abort the child is killed (SIGTERM → SIGKILL after the grace period) and
   * the run settles with exit {@link COMMAND_CANCELLED_EXIT_CODE} (130).
   * @adr 0362
   */
  signal?: AbortSignal;
  /**
   * Base environment for the child instead of the cli's whole `process.env`. AI runs pass
   * the allow-listed `projectAgentEnv()` so the cli's own secrets never reach the agent; omitted ⇒
   * `process.env` (non-AI console commands). `dispatch.env` + `FOURPM_JOB_ID` are layered on top.
   * @adr 0421
   */
  baseEnv?: NodeJS.ProcessEnv;
}

/**
 * Run a single command and stream its output in batches.
 * @param dispatch payload from the server
 * @param emitRaw  send one command.output message back to the server
 * @param opts optional per-run controls (e.g. a wall-clock timeout)
 * @adr 0243
 */
export async function runCommand(
  dispatch: CommandDispatchPayload,
  emitRaw: (output: CommandOutputPayload) => void,
  opts?: RunCommandOptions,
): Promise<void> {
  let seq = 0;
  // GitHub-App git-auth (ADR-0356): the run is one token scope — revoke its tokens once it settles.
  const emit = (output: CommandOutputPayload): void => {
    emitRaw(output);
    if (output.done) void endGitScope(dispatch.commandId);
  };
  // Guard the spawn (ADR-0251): `spawn` throws **synchronously** for some failures — notably
  // `E2BIG` when an argv element exceeds `MAX_ARG_STRLEN` (128 KiB) — WITHOUT emitting an async
  // `error` event. Left unguarded, the throw becomes a rejected promise the caller never observes,
  // so the run never settles and the dispatch spins forever. Turn any such throw into a terminal
  // `done` (like the `error` handler) so failover moves on instead of hanging.
  let child: ReturnType<typeof spawn>;
  try {
    // FOURPM_JOB_ID scopes the git helper / gh shim tokens to this run (ADR-0356).
    const env0 = { ...(opts?.baseEnv ?? process.env), ...dispatch.env, [JOB_ID_ENV]: dispatch.commandId };
    // Egress (ADR-0439): this run's own proxy token, so its connections are logged under its id.
    const env = { ...env0, ...egressEnv(env0, { runId: dispatch.commandId }) };
    // Uid separation (ADR-0430): every dispatched command — AI run, raw Console command, Git-tab op — runs
    // as the agent user; a raw command's env is allow-listed like an AI run's. No-op when separation is off.
    const run = agentUser()
      ? agentSpawnArgs(dispatch.cmd, dispatch.args ?? [], opts?.baseEnv ? env : agentProcessEnv(env))
      : { cmd: dispatch.cmd, args: dispatch.args ?? [], env };
    child = spawn(run.cmd, run.args, {
      cwd: dispatch.path,
      env: run.env,
      shell: false,
    });
  } catch (err) {
    emit({
      commandId: dispatch.commandId,
      seq: seq++,
      chunk: `spawn error: ${(err as Error).message}\n`,
      done: true,
      exitCode: -1,
    });
    return;
  }
  // Feed the prompt on stdin when given (AI runs — ADR-0251), else close stdin empty so tools that
  // probe stdin (e.g. the AI CLIs) get EOF immediately instead of blocking for input. Guard the
  // stream against `EPIPE` (the child may exit before we finish writing) so it can't crash the cli.
  child.stdin?.on("error", () => {});
  if (opts?.stdin != null) {
    child.stdin?.write(opts.stdin);
  }
  child.stdin?.end();

  // Wall-clock timeout: on expiry, note it in the stream then kill the child. The
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
  // Stop (ADR-0362): kill the child on abort, like a timeout but settling with exit 130.
  let cancelled = false;
  const onAbort = (): void => {
    if (cancelled) return;
    cancelled = true;
    child.kill("SIGTERM");
    hardKillTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
    hardKillTimer.unref?.();
  };
  if (opts?.signal?.aborted) onAbort();
  else opts?.signal?.addEventListener("abort", onAbort, { once: true });
  /** Clear both timers + the abort listener once the run settles (idempotent). */
  const clearTimers = (): void => {
    if (timeoutTimer) clearTimeout(timeoutTimer);
    if (hardKillTimer) clearTimeout(hardKillTimer);
    opts?.signal?.removeEventListener("abort", onAbort);
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
        // 130 when the run was stopped (ADR-0362); 124 (the conventional timeout code) when we killed it
        // for exceeding the limit, so the server settles the command as failed and the web surfaces the
        // note instead of spinning.
        exitCode: cancelled ? COMMAND_CANCELLED_EXIT_CODE : timedOut ? 124 : (exitCode ?? -1),
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
