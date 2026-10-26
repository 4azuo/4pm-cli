/**
 * Processes of a marketing run: a shell step with a timeout (its output streamed line by line), and a long-running
 * process (the app) started in its own process group so the whole tree can be stopped. Inside an agent root they run as
 * the agent with an allow-listed env plus the step's own variables (`projectSpawnArgs`). The render slot lets one
 * capture / render run at a time on this worker.
 * @adr 0640 @adr 0646
 */
import { spawn, type ChildProcess } from "node:child_process";
import { projectSpawnArgs } from "../agent/agent-spawn";

/** A line sink. */
export type LineSink = (line: string) => void;

/** The tail of the render-slot queue (one capture / render at a time on this worker). */
let slotTail: Promise<void> = Promise.resolve();
/** Whether a capture / render holds the slot. */
let slotBusy = false;

/** Run `fn` holding the worker's render slot; waits (logging once) while another run holds it. */
export async function withRenderSlot<T>(sink: LineSink, fn: () => Promise<T>): Promise<T> {
  if (slotBusy) sink("marketing: waiting for another capture / render on this worker to finish…");
  const prev = slotTail;
  let release!: () => void;
  slotTail = new Promise<void>((r) => (release = r));
  await prev;
  slotBusy = true;
  try {
    return await fn();
  } finally {
    slotBusy = false;
    release();
  }
}

/** Split a stream into lines for a sink (the last partial line is flushed on close). */
function lines(child: ChildProcess, sink: LineSink): void {
  for (const stream of [child.stdout, child.stderr]) {
    let buf = "";
    stream?.setEncoding("utf8");
    stream?.on("data", (chunk: string) => {
      buf += chunk;
      let i = buf.indexOf("\n");
      while (i >= 0) {
        sink(buf.slice(0, i).replace(/\r$/, ""));
        buf = buf.slice(i + 1);
        i = buf.indexOf("\n");
      }
    });
    stream?.on("close", () => {
      if (buf) sink(buf);
      buf = "";
    });
  }
}

/** Spawn `cmd args` in `cwd` with extra env vars, in its own process group. */
function start(cmd: string, args: string[], cwd: string, env: Record<string, string>): ChildProcess {
  const s = projectSpawnArgs(cmd, args, cwd, { ...process.env, ...env });
  return spawn(s.cmd, s.args, { cwd, env: s.env ?? process.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
}

/** Stop a process group (TERM, then KILL after 5 s). */
export async function stopGroup(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  const pid = child.pid;
  const kill = (sig: NodeJS.Signals): void => {
    try {
      process.kill(-pid, sig);
    } catch {
      try {
        child.kill(sig);
      } catch {
        /* already gone */
      }
    }
  };
  kill("SIGTERM");
  const exited = await Promise.race([
    new Promise<boolean>((r) => child.once("exit", () => r(true))),
    new Promise<boolean>((r) => setTimeout(() => r(false), 5_000)),
  ]);
  if (!exited) kill("SIGKILL");
}

/** Run a command to completion (killed after `timeoutMs`); resolves with its exit code (124 on timeout). */
export function runStep(
  cmd: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number,
  sink: LineSink,
): Promise<number> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = start(cmd, args, cwd, env);
    } catch (err) {
      sink(`cannot start ${cmd}: ${err instanceof Error ? err.message : String(err)}`);
      resolve(127);
      return;
    }
    lines(child, sink);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void stopGroup(child);
    }, timeoutMs);
    child.on("error", (err) => {
      sink(`cannot start ${cmd}: ${err.message}`);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(timedOut ? 124 : (code ?? 1));
    });
  });
}

/** Run a shell line (`sh -c`). */
export function runShell(line: string, cwd: string, env: Record<string, string>, timeoutMs: number, sink: LineSink): Promise<number> {
  return runStep("/bin/sh", ["-c", line], cwd, env, timeoutMs, sink);
}

/** Start a long-running shell line (the app); its output goes to `sink`. */
export function startShell(line: string, cwd: string, env: Record<string, string>, sink: LineSink): ChildProcess {
  const child = start("/bin/sh", ["-c", line], cwd, env);
  lines(child, sink);
  child.on("error", (err) => sink(`cannot start the app: ${err.message}`));
  return child;
}
