/**
 * HostingRunner — worker hosting on the cli: runs releases of the deploy environments the server assigns
 * to this machine. A release fetches its SHA into its own checkout (`<workspaces>/.4pm-hosting/<project>/<env>/<sha>`,
 * never the served project folder, under the `hosting:<releaseId>` git-token scope), installs / builds and starts the
 * app as the agent uid (process mode; empty commands from the repo's `.4pm/host.yml`; limits by a cgroup when one is
 * delegated, else `nice` + a memory watchdog) or with docker compose on the operator's sidecar,
 * waits for the health path, then points the environment's fixed edge port at it and stops the previous instance —
 * a failed release leaves the old one serving. The app, the edge proxy and `cloudflared` run detached, so a cli
 * restart keeps serving; the state (with the release's env vars) is kept owner-only in the profile and the last live
 * release is started again after a container restart. Every change is reported on `host.status`.
 * @adr 0664 @arch 0070
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { freemem } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { HostDeployReply, HostDeployRequest, HostLimits, HostLogsReply, HostStatusPayload, HostTunnelRequest, MachineHostingReport } from "@4pm/ws";
import { logger } from "../../common/logger/logger";
import { workspaceRoot } from "../../config/profile";
import { mkdirShared } from "../../utils/agent-user";
import { execInProject, projectSpawnArgs } from "../agent/agent-spawn";
import { endGitScope } from "../git/git-auth";
import { JOB_ID_ENV } from "../git/git-helper-env";
import { ensureCloudflared, startTunnel, tunnelLogState } from "./cloudflared";
import { applyCgroupLimits, freePort, groupUsage, isAlive, readText, setEdgeTarget, startDetached, startEdge, stopGroup, tailFile, waitHealthy } from "./hosting-process";
import { parse as parseYaml } from "yaml";

const run = promisify(execFile);

/** Budget of one install / build step. */
const STEP_TIMEOUT_MS = 20 * 60_000;
/** Checkouts kept per environment (the live one + one for rollback). */
const KEEP_CHECKOUTS = 2;
/** Watchdog cadence (liveness, memory, tunnel state). */
const WATCH_MS = 15_000;
/** Restarts of a crashed instance allowed per window before it is reported failed. */
const MAX_RESTARTS = 3;
const RESTART_WINDOW_MS = 10 * 60_000;
/** The compose sidecar's host name (guide 2010). */
const SIDECAR_HOST = "4pm-host";

/** A running instance of an environment. */
interface Instance {
  releaseId: string;
  sha: string;
  dir: string;
  host: string;
  port: number;
  pid: number | null;
  runMode: "process" | "compose";
  start: string | null;
  composeProject: string | null;
  composeFile: string | null;
  envVars: Record<string, string>;
  limits: HostLimits;
  /** Limits enforced by a cgroup (else `nice` + the memory watchdog). */
  cgroup?: boolean;
}

/** The process commands a repo may declare in `.4pm/host.yml` (its `process:` block, or flat top-level keys). */
type HostYml = Partial<{ install: string; build: string; start: string; port: number; healthPath: string; healthTimeoutSec: number }>;
/** The compose settings a repo may declare in `.4pm/host.yml` (its `compose:` block). */
type HostComposeYml = Partial<{ file: string; service: string; port: number; healthPath: string }>;

/** Read the `compose:` block of `.4pm/host.yml` (unknown keys and bad values are ignored). */
export function readHostComposeYml(dir: string): HostComposeYml {
  let raw: unknown;
  try {
    raw = parseYaml(readText(join(dir, ".4pm", "host.yml")) || "{}");
  } catch {
    return {};
  }
  const c = raw && typeof raw === "object" ? (raw as Record<string, unknown>).compose : null;
  if (!c || typeof c !== "object") return {};
  const o = c as Record<string, unknown>;
  const out: HostComposeYml = {};
  for (const k of ["file", "service", "healthPath"] as const) if (typeof o[k] === "string" && (o[k] as string).trim()) out[k] = (o[k] as string).trim();
  if (typeof o.port === "number" && Number.isInteger(o.port)) out.port = o.port;
  return out;
}

/** The release's compose settings: the form's, with the empty ones taken from `.4pm/host.yml`. */
export function resolveCompose(form: NonNullable<HostDeployRequest["compose"]>, yml: HostComposeYml): NonNullable<HostDeployRequest["compose"]> {
  return {
    file: form.file && form.file !== "docker-compose.yml" ? form.file : (yml.file ?? form.file ?? "docker-compose.yml"),
    service: form.service || yml.service || "",
    port: form.port ?? yml.port,
    healthPath: form.healthPath && form.healthPath !== "/" ? form.healthPath : (yml.healthPath ?? form.healthPath ?? "/"),
  };
}

/** Read `.4pm/host.yml` of a checkout (unknown keys and bad values are ignored). */
export function readHostYml(dir: string): HostYml {
  const text = readText(join(dir, ".4pm", "host.yml"));
  if (!text) return {};
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch {
    return {};
  }
  if (!raw || typeof raw !== "object") return {};
  const top = raw as Record<string, unknown>;
  // Guide 2010's layout nests the commands under `process:`; flat keys are read too.
  const o = (top.process && typeof top.process === "object" ? top.process : top) as Record<string, unknown>;
  const str = (k: string) => (typeof o[k] === "string" && (o[k] as string).trim() ? (o[k] as string).trim() : undefined);
  const num = (k: string) => (typeof o[k] === "number" && Number.isInteger(o[k]) ? (o[k] as number) : undefined);
  const out: HostYml = {};
  for (const k of ["install", "build", "start", "healthPath"] as const) if (str(k)) out[k] = str(k);
  for (const k of ["port", "healthTimeoutSec"] as const) if (num(k)) out[k] = num(k);
  return out;
}

/** The release's process commands: the form's fields, with the empty ones taken from `.4pm/host.yml`. */
export function resolveProcess(form: NonNullable<HostDeployRequest["process"]>, yml: HostYml): NonNullable<HostDeployRequest["process"]> {
  return {
    install: form.install || yml.install,
    build: form.build || yml.build,
    start: form.start || yml.start || "",
    port: form.port ?? yml.port,
    healthPath: form.healthPath && form.healthPath !== "/" ? form.healthPath : (yml.healthPath ?? form.healthPath ?? "/"),
    healthTimeoutSec: yml.healthTimeoutSec && form.healthTimeoutSec === 60 ? yml.healthTimeoutSec : form.healthTimeoutSec,
  };
}

/** What the runner keeps per environment. */
interface EnvState {
  environmentId: string;
  environmentName: string;
  projectId: string;
  edgePort: number;
  edgePid: number | null;
  live: Instance | null;
  tunnel: { kind: "quick" | "named"; token: string | null; pid: number | null } | null;
  restarts: number[];
}

/** The status sender (set by the ws client while connected). */
type Sender = (payload: HostStatusPayload) => void;

export class HostingRunner {
  private envs = new Map<string, EnvState>();
  /** Environments with a release in progress → its id + whether it was cancelled. */
  private busy = new Map<string, { releaseId: string; cancelled: boolean }>();
  private sender: Sender | null = null;
  private watch: NodeJS.Timeout | null = null;
  private composeOk: { at: number; ok: boolean } | null = null;

  constructor(
    private readonly profileDir: string,
    /** The served project's root (the origin URL is read there); null while idle. */
    private readonly physicRoot: () => string | null,
  ) {
    this.load();
  }

  // ── lifecycle ────────────────────────────────────────────────────────────────────────────────────────

  /** Set (or clear) the status sender; on connect every environment is reported. */
  setSender(sender: Sender | null): void {
    this.sender = sender;
    if (sender) for (const env of this.envs.values()) void this.report(env, env.live?.releaseId ?? null, env.live ? "live" : "stopped");
  }

  /** Start the watchdog and bring back what a container restart stopped (the last live releases, edges, tunnels). */
  async start(): Promise<void> {
    for (const env of this.envs.values()) {
      try {
        if (env.live && env.live.runMode === "process" && !isAlive(env.live.pid)) await this.restartInstance(env, "boot");
        this.ensureEdge(env);
        if (env.tunnel && !isAlive(env.tunnel.pid)) await this.runTunnel(env);
      } catch (err) {
        logger.warn("hosting.restore.failed", { environmentId: env.environmentId, error: String(err) });
      }
    }
    this.watch ??= setInterval(() => void this.tick(), WATCH_MS);
    this.watch.unref();
  }

  /** Stop the watchdog (the detached processes keep running). */
  stop(): void {
    if (this.watch) clearInterval(this.watch);
    this.watch = null;
  }

  /** The hosting part of machine.status. */
  async machineReport(): Promise<MachineHostingReport> {
    return { modes: await this.modes(), instances: [...this.envs.values()].filter((e) => e.live).length, freeMemMb: Math.round(freemem() / 1024 / 1024) };
  }

  /** Send one environment's `host.status`. */
  private async report(env: EnvState, releaseId: string | null, state: HostStatusPayload["state"], extra: Partial<HostStatusPayload> = {}): Promise<void> {
    const log = tunnelLogState(this.file(env.environmentId, "tunnel.log"));
    const tunnelState = !env.tunnel ? "down" : !isAlive(env.tunnel.pid) ? "down" : log.connected ? "connected" : "starting";
    const usage = env.live?.pid ? await groupUsage(env.live.pid) : null;
    this.sender?.({
      environmentId: env.environmentId,
      releaseId: releaseId ?? null,
      state,
      ...(env.live ? { port: env.live.port } : {}),
      tunnel: { state: tunnelState, ...(log.url && env.tunnel?.kind === "quick" ? { url: log.url } : {}) },
      ...(usage ? { cpu: usage.cpu, memMb: usage.memMb } : {}),
      ...extra,
    });
  }

  // ── server requests ──────────────────────────────────────────────────────────────────────────────────

  /** `host.deploy`: take the release (refused while another release of the environment runs), run it in the background. */
  deploy(req: HostDeployRequest): HostDeployReply {
    if (this.busy.has(req.environmentId)) return { accepted: false, reason: "busy" };
    if (req.runMode === "compose" && !this.composeOk?.ok) return { accepted: false, reason: "mode_unsupported" };
    const env = this.envOf(req);
    this.busy.set(req.environmentId, { releaseId: req.releaseId, cancelled: false });
    void this.release(env, req).finally(() => this.busy.delete(req.environmentId));
    return { accepted: true };
  }

  /** `host.stop`: cancel a release in progress (with `releaseId`), or stop the environment entirely. */
  async stopEnv(environmentId: string, releaseId?: string): Promise<void> {
    const env = this.envs.get(environmentId);
    const b = this.busy.get(environmentId);
    if (releaseId) {
      if (b?.releaseId === releaseId) b.cancelled = true;
      return;
    }
    if (b) b.cancelled = true;
    if (!env) return;
    if (env.live) await this.stopInstance(env.live);
    await stopGroup(env.tunnel?.pid);
    await stopGroup(env.edgePid);
    const last = env.live?.releaseId ?? null;
    env.live = null;
    env.tunnel = null;
    env.edgePid = null;
    await this.report(env, last, "stopped");
    this.envs.delete(environmentId);
    this.save();
  }

  /** `host.tunnel.start` / `host.tunnel.stop`. */
  async tunnel(req: HostTunnelRequest, on: boolean): Promise<void> {
    const env = this.envs.get(req.environmentId);
    if (!env) return;
    await stopGroup(env.tunnel?.pid);
    env.tunnel = on ? { kind: req.kind, token: req.token ?? null, pid: null } : null;
    if (on) await this.runTunnel(env);
    this.save();
    await this.report(env, env.live?.releaseId ?? null, env.live ? "live" : "running");
  }

  /** `host.logs`: the tail of the app's output. */
  logs(environmentId: string, lines: number): HostLogsReply {
    const env = this.envs.get(environmentId);
    if (!env) return { text: "", truncated: false };
    if (env.live?.runMode === "compose") return tailFile(this.file(environmentId, "compose.log"), lines);
    return tailFile(this.file(environmentId, "app.log"), lines);
  }

  // ── release ──────────────────────────────────────────────────────────────────────────────────────────

  /** Run one release: fetch → install → build → start → health → swap; a failure leaves the old instance serving. */
  private async release(env: EnvState, req: HostDeployRequest): Promise<void> {
    const cancelled = () => this.busy.get(env.environmentId)?.cancelled === true;
    let step: HostStatusPayload["step"] = "fetch";
    let next: Instance | null = null;
    try {
      await this.report(env, req.releaseId, "running", { step });
      const dir = await this.checkout(req);
      const appLog = this.file(env.environmentId, req.runMode === "compose" ? "compose.log" : "app.log");
      writeFileSync(appLog, "", { mode: 0o600 });
      const appEnv = { ...req.envVars };
      if (req.runMode === "process") {
        // Empty form fields come from the repo's `.4pm/host.yml` at this SHA.
        const p = resolveProcess(req.process!, readHostYml(dir));
        if (!p.start) throw new Error("no start command — set it in the form or in .4pm/host.yml");
        for (const [s, cmd] of [["install", p.install], ["build", p.build]] as const) {
          if (!cmd || cancelled()) continue;
          step = s;
          await this.report(env, req.releaseId, "running", { step });
          await execInProject("sh", ["-c", cmd], { cwd: dir, env: { ...process.env, ...appEnv }, timeout: STEP_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });
        }
        if (cancelled()) throw new Error("cancelled");
        step = "start";
        await this.report(env, req.releaseId, "running", { step });
        // A fixed app port cannot run twice: stop the old instance first (a short gap); else a fresh loopback port.
        if (p.port && env.live) await this.stopInstance(env.live);
        const port = p.port ?? (await freePort());
        next = { releaseId: req.releaseId, sha: req.sha, dir, host: "127.0.0.1", port, pid: null, runMode: "process", start: p.start, composeProject: null, composeFile: null, envVars: req.envVars, limits: req.limits };
        next.pid = this.spawnApp(env, next);
        next.cgroup = await applyCgroupLimits(env.environmentId.slice(0, 8), next.pid, next.limits);
        step = "health";
        await this.report(env, req.releaseId, "running", { step });
        const healthy = await waitHealthy(`http://127.0.0.1:${port}${p.healthPath}`, p.healthTimeoutSec, () => isAlive(next?.pid) && !cancelled());
        if (!healthy) throw new Error(cancelled() ? "cancelled" : "health check failed");
      } else {
        // Empty form fields come from the repo's `.4pm/host.yml` at this SHA.
        const c = resolveCompose(req.compose!, readHostComposeYml(dir));
        if (!c.service || !c.port) throw new Error("no compose service / port — set them in the form or in .4pm/host.yml");
        const port = c.port;
        const project = `4pm-${req.projectId.slice(0, 8)}-${req.environmentName}`;
        step = "start";
        await this.report(env, req.releaseId, "running", { step });
        const envFile = this.file(env.environmentId, "compose.env");
        writeFileSync(envFile, Object.entries(appEnv).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join("\n") + "\n", { mode: 0o600 });
        const { stdout, stderr } = await run("docker", ["compose", "-p", project, "-f", c.file, "--env-file", envFile, "up", "-d", "--build", "--remove-orphans"], { cwd: dir, timeout: STEP_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });
        writeFileSync(appLog, `${stdout}\n${stderr}`, { mode: 0o600 });
        next = { releaseId: req.releaseId, sha: req.sha, dir, host: SIDECAR_HOST, port, pid: null, runMode: "compose", start: null, composeProject: project, composeFile: c.file, envVars: req.envVars, limits: req.limits };
        step = "health";
        await this.report(env, req.releaseId, "running", { step });
        if (!(await waitHealthy(`http://${SIDECAR_HOST}:${port}${c.healthPath}`, 120, () => !cancelled()))) throw new Error("health check failed");
      }
      step = "swap";
      this.ensureEdge(env);
      setEdgeTarget(this.file(env.environmentId, "edge.target"), next.host, next.port);
      const old = env.live;
      env.live = next;
      this.save();
      if (old && old.pid !== next.pid && old.runMode === "process") await this.stopInstance(old);
      if (env.tunnel && !isAlive(env.tunnel.pid)) await this.runTunnel(env);
      this.pruneCheckouts(env, next.sha, old?.sha ?? null);
      await this.report(env, req.releaseId, "live", { step });
    } catch (err) {
      if (next?.pid && env.live?.pid !== next.pid) await stopGroup(next.pid);
      const msg = err instanceof Error ? err.message : String(err);
      const tail = `${msg}\n${tailFile(this.file(env.environmentId, "app.log"), 60).text}`.slice(-4096);
      logger.warn("hosting.release.failed", { environmentId: env.environmentId, releaseId: req.releaseId, step, error: msg });
      await this.report(env, req.releaseId, msg === "cancelled" ? "stopped" : "failed", { step, tail });
    } finally {
      await endGitScope(`hosting:${req.releaseId}`).catch(() => undefined);
    }
  }

  /** Fetch `sha` into its own checkout (reused when present). */
  private async checkout(req: HostDeployRequest): Promise<string> {
    const base = join(workspaceRoot(this.profileDir), ".4pm-hosting", req.projectId, req.environmentName);
    const dir = join(base, req.sha);
    if (existsSync(join(dir, ".git"))) return dir;
    const root = this.physicRoot();
    if (!root) throw new Error("this worker serves no project");
    const { stdout } = await execInProject("git", ["-C", root, "remote", "get-url", "origin"], { timeout: 30_000 });
    const url = stdout.trim();
    mkdirShared(base);
    rmSync(dir, { recursive: true, force: true });
    const gitEnv = { ...process.env, [JOB_ID_ENV]: `hosting:${req.releaseId}` };
    await execInProject("git", ["init", "-q", dir], { cwd: base, env: gitEnv, timeout: 30_000 });
    await execInProject("git", ["-C", dir, "remote", "add", "origin", url], { env: gitEnv, timeout: 30_000 });
    await execInProject("git", ["-C", dir, "fetch", "-q", "--depth", "1", "origin", req.sha], { env: gitEnv, timeout: STEP_TIMEOUT_MS });
    await execInProject("git", ["-C", dir, "checkout", "-q", "--detach", "FETCH_HEAD"], { env: gitEnv, timeout: 120_000 });
    return dir;
  }

  /** Start a process-mode instance as the agent (`nice` 10), output to the environment's app log; returns its pid. */
  private spawnApp(env: EnvState, inst: Instance): number {
    const appEnv = { ...process.env, ...inst.envVars, PORT: String(inst.port), HOST: "127.0.0.1" };
    const w = projectSpawnArgs("nice", ["-n", "10", "sh", "-c", inst.start!], inst.dir, appEnv);
    return startDetached(w.cmd, w.args, { cwd: inst.dir, env: w.env, logFile: this.file(env.environmentId, "app.log") });
  }

  /** Stop an instance (process group, or `docker compose down` keeping volumes). */
  private async stopInstance(inst: Instance): Promise<void> {
    if (inst.runMode === "process") return stopGroup(inst.pid);
    if (inst.composeProject) await run("docker", ["compose", "-p", inst.composeProject, "down"], { cwd: inst.dir, timeout: 120_000 }).catch(() => undefined);
  }

  /** Start the live instance again (after a crash / container restart), within the restart budget. */
  private async restartInstance(env: EnvState, why: string): Promise<void> {
    const live = env.live;
    if (!live || live.runMode !== "process" || !existsSync(live.dir)) return;
    const now = Date.now();
    env.restarts = env.restarts.filter((t) => now - t < RESTART_WINDOW_MS);
    if (env.restarts.length >= MAX_RESTARTS) {
      await this.report(env, live.releaseId, "failed", { step: "start", tail: `stopped restarting after ${MAX_RESTARTS} crashes (${why})` });
      return;
    }
    env.restarts.push(now);
    live.pid = this.spawnApp(env, live);
    live.cgroup = await applyCgroupLimits(env.environmentId.slice(0, 8), live.pid, live.limits);
    this.save();
    logger.info("hosting.instance.restarted", { environmentId: env.environmentId, why });
  }

  /** Make sure the environment's edge proxy runs. */
  private ensureEdge(env: EnvState): void {
    if (isAlive(env.edgePid)) return;
    env.edgePid = startEdge(env.edgePort, this.file(env.environmentId, "edge.target"), this.file(env.environmentId, "edge.log"));
    this.save();
  }

  /** (Re)start the environment's `cloudflared`. */
  private async runTunnel(env: EnvState): Promise<void> {
    if (!env.tunnel) return;
    if (!(await ensureCloudflared())) {
      logger.warn("hosting.tunnel.noCloudflared", { environmentId: env.environmentId });
      return;
    }
    this.ensureEdge(env);
    const logFile = this.file(env.environmentId, "tunnel.log");
    writeFileSync(logFile, "", { mode: 0o600 });
    env.tunnel.pid = startTunnel(env.tunnel.kind, env.edgePort, env.tunnel.token, logFile);
    this.save();
  }

  /** Watchdog: crashed instances restart, an instance over its memory limit restarts, a dead edge proxy / tunnel restarts, states are reported. */
  private async tick(): Promise<void> {
    for (const env of this.envs.values()) {
      if (this.busy.has(env.environmentId)) continue;
      const live = env.live;
      try {
        if (live?.runMode === "process") {
          if (!isAlive(live.pid)) await this.restartInstance(env, "crash");
          else if (!live.cgroup) {
            // Without a cgroup the memory limit is the watchdog's.
            const mem = (await groupUsage(live.pid!))?.memMb ?? null;
            if (mem !== null && mem > live.limits.memoryMb) {
              await stopGroup(live.pid);
              await this.restartInstance(env, `memory ${mem} MB > ${live.limits.memoryMb} MB`);
            }
          }
        }
        // The edge proxy is what the tunnel points at: bring it back if it died.
        if (live) this.ensureEdge(env);
        if (env.tunnel && !isAlive(env.tunnel.pid)) await this.runTunnel(env);
        await this.report(env, live?.releaseId ?? null, live ? "live" : "stopped");
      } catch (err) {
        logger.warn("hosting.watch.failed", { environmentId: env.environmentId, error: String(err) });
      }
    }
  }

  // ── state ────────────────────────────────────────────────────────────────────────────────────────────

  /** The run modes this worker serves: process always; compose when the sidecar answers (cached 5 min). */
  private async modes(): Promise<("process" | "compose")[]> {
    if (!this.composeOk || Date.now() - this.composeOk.at > 5 * 60_000) {
      let ok = false;
      if (process.env.DOCKER_HOST) {
        ok = await run("docker", ["compose", "version"], { timeout: 10_000 }).then(
          () => true,
          () => false,
        );
      }
      this.composeOk = { at: Date.now(), ok };
    }
    return this.composeOk.ok ? ["process", "compose"] : ["process"];
  }

  /** The environment's state (created on its first release). */
  private envOf(req: HostDeployRequest): EnvState {
    let env = this.envs.get(req.environmentId);
    if (!env) {
      env = { environmentId: req.environmentId, environmentName: req.environmentName, projectId: req.projectId, edgePort: req.edgePort, edgePid: null, live: null, tunnel: null, restarts: [] };
      this.envs.set(req.environmentId, env);
    }
    env.edgePort = req.edgePort;
    return env;
  }

  /** Remove checkouts other than the live and the previous one. */
  private pruneCheckouts(env: EnvState, live: string, previous: string | null): void {
    const base = join(workspaceRoot(this.profileDir), ".4pm-hosting", env.projectId, env.environmentName);
    const keep = new Set([live, previous].filter((s): s is string => !!s).slice(0, KEEP_CHECKOUTS));
    for (const d of existsSync(base) ? readdirSync(base) : []) if (!keep.has(d)) rmSync(join(base, d), { recursive: true, force: true });
  }

  /** A control file of an environment (owner-only, in the profile). */
  private file(environmentId: string, name: string): string {
    const dir = join(this.profileDir, "hosting", environmentId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return join(dir, name);
  }

  /** The state file. */
  private statePath(): string {
    mkdirSync(join(this.profileDir, "hosting"), { recursive: true, mode: 0o700 });
    return join(this.profileDir, "hosting", "state.json");
  }

  /** Read the state kept across restarts. */
  private load(): void {
    try {
      const list = JSON.parse(readFileSync(this.statePath(), "utf8")) as EnvState[];
      for (const e of list) this.envs.set(e.environmentId, { ...e, restarts: [] });
    } catch {
      /* none yet */
    }
  }

  /** Persist the state (owner-only: it holds the release env vars and a named tunnel's connector token). */
  private save(): void {
    writeFileSync(this.statePath(), JSON.stringify([...this.envs.values()]), { mode: 0o600 });
  }
}
