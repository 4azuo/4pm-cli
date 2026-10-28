/**
 * Process helpers of worker hosting: detached supervised processes (their own process group, output to a log file,
 * so a cli restart keeps them running), liveness / stop by pid, a free loopback port, an HTTP health wait, the memory
 * and CPU of a process group, best-effort cgroup v2 limits, a log tail, and the tiny TCP edge proxy that forwards an environment's fixed edge port to its
 * live instance (re-reading the target file per connection, so a release swaps with no restart).
 * @adr 0664 @arch 0070
 */
import { spawn, execFile } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:net";
import { promisify } from "node:util";

const run = promisify(execFile);

/** The edge proxy, run with `node -e <this> <listenPort> <targetFile>`; the target file holds `host:port`. */
const EDGE_SCRIPT = `
const net = require("net"), fs = require("fs");
const [listen, file] = process.argv.slice(1);
const target = () => { try { const [h, p] = fs.readFileSync(file, "utf8").trim().split(":"); return { host: h || "127.0.0.1", port: Number(p) }; } catch { return null; } };
net.createServer((c) => {
  const t = target();
  if (!t || !t.port) return c.destroy();
  const u = net.connect(t.port, t.host);
  c.pipe(u); u.pipe(c);
  u.on("error", () => c.destroy()); c.on("error", () => u.destroy());
}).listen(Number(listen), "127.0.0.1");
`;

/** Start a detached process (own group) writing stdout + stderr to `logFile`; returns its pid. */
export function startDetached(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; logFile: string }): number {
  const fd = openSync(opts.logFile, "a");
  try {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, detached: true, stdio: ["ignore", fd, fd] });
    child.unref();
    if (!child.pid) throw new Error(`could not start ${cmd}`);
    return child.pid;
  } finally {
    closeSync(fd);
  }
}

/** Whether a pid is alive. */
export function isAlive(pid: number | null | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Stop a detached process group: SIGTERM, then SIGKILL after `graceMs`. */
export async function stopGroup(pid: number | null | undefined, graceMs = 10_000): Promise<void> {
  if (!pid || !isAlive(pid)) return;
  const signal = (s: NodeJS.Signals) => {
    try {
      process.kill(-pid, s);
    } catch {
      try {
        process.kill(pid, s);
      } catch {
        /* gone */
      }
    }
  };
  signal("SIGTERM");
  const until = Date.now() + graceMs;
  while (Date.now() < until && isAlive(pid)) await new Promise((r) => setTimeout(r, 250));
  if (isAlive(pid)) signal("SIGKILL");
}

/** A free loopback port. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/** Wait until `GET url` answers 2xx (or the timeout); true when healthy. */
export async function waitHealthy(url: string, timeoutSec: number, alive: () => boolean): Promise<boolean> {
  const until = Date.now() + timeoutSec * 1000;
  while (Date.now() < until) {
    if (!alive()) return false;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5_000), redirect: "manual" });
      if (res.status >= 200 && res.status < 400) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  return false;
}

/** The CPU (%) and resident memory (MB) of a process group, or null when unknown (non-Linux). */
export async function groupUsage(pid: number): Promise<{ cpu: number; memMb: number } | null> {
  try {
    const { stdout } = await run("ps", ["-o", "%cpu=,rss=", "-g", String(pid)], { timeout: 5_000 });
    let cpu = 0;
    let kb = 0;
    for (const line of stdout.split("\n")) {
      const [c, r] = line.trim().split(/\s+/).map(Number);
      if (Number.isFinite(c)) cpu += c!;
      if (Number.isFinite(r)) kb += r!;
    }
    return { cpu: Math.round(cpu * 10) / 10, memMb: Math.round(kb / 1024) };
  } catch {
    return null;
  }
}

/** The resident memory (MB) of a process group, or null when unknown (non-Linux). */
export async function groupMemoryMb(pid: number): Promise<number | null> {
  return (await groupUsage(pid))?.memMb ?? null;
}

/** The pids of a process group (its members). */
async function groupPids(pid: number): Promise<number[]> {
  try {
    const { stdout } = await run("ps", ["-o", "pid=", "-g", String(pid)], { timeout: 5_000 });
    return stdout.split("\n").map((l) => Number(l.trim())).filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    return [pid];
  }
}

/**
 * Put a process group under cgroup v2 limits (`memory.max`, `cpu.max`) in a child of the cli's own cgroup, when that
 * is writable (a delegated cgroup); false otherwise — the caller then falls back to `nice` + a memory watchdog.
 */
export async function applyCgroupLimits(name: string, pid: number, limits: { cpus: number; memoryMb: number }): Promise<boolean> {
  try {
    const own = /^0::(.*)$/m.exec(readFileSync("/proc/self/cgroup", "utf8"))?.[1];
    if (!own) return false;
    const base = join("/sys/fs/cgroup", own);
    const controllers = readFileSync(join(base, "cgroup.controllers"), "utf8");
    if (!/\bmemory\b/.test(controllers) || !/\bcpu\b/.test(controllers)) return false;
    // Enabling controllers for children fails while the cli itself sits in `base` (no internal processes): then give up.
    writeFileSync(join(base, "cgroup.subtree_control"), "+memory +cpu");
    const dir = join(base, `4pm-host-${name}`);
    if (!existsSync(dir)) mkdirSync(dir);
    writeFileSync(join(dir, "memory.max"), String(limits.memoryMb * 1024 * 1024));
    writeFileSync(join(dir, "cpu.max"), `${Math.max(1000, Math.round(limits.cpus * 100_000))} 100000`);
    for (const p of await groupPids(pid)) writeFileSync(join(dir, "cgroup.procs"), String(p));
    return true;
  } catch {
    return false;
  }
}

/** The last `lines` lines of a log file (≤ 256 KB read). */
export function tailFile(path: string, lines: number): { text: string; truncated: boolean } {
  if (!existsSync(path)) return { text: "", truncated: false };
  const size = statSync(path).size;
  const max = 256 * 1024;
  const fd = openSync(path, "r");
  try {
    const len = Math.min(size, max);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const all = buf.toString("utf8").split("\n");
    const out = all.slice(-lines - 1);
    return { text: out.join("\n"), truncated: size > max || all.length > out.length };
  } finally {
    closeSync(fd);
  }
}

/** Point the environment's edge proxy at `host:port`. */
export function setEdgeTarget(targetFile: string, host: string, port: number): void {
  writeFileSync(targetFile, `${host}:${port}\n`, { mode: 0o600 });
}

/** Start the edge proxy for `edgePort` (reading `targetFile`); returns its pid. */
export function startEdge(edgePort: number, targetFile: string, logFile: string): number {
  return startDetached(process.execPath, ["-e", EDGE_SCRIPT, String(edgePort), targetFile], { logFile });
}

/** Read a text file or "". */
export function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}
