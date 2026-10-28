/**
 * A marketing photo run on the worker (`command.dispatch` with a `marketing` spec). Around the agent run of the same
 * command: **prepare** — fetch, keep the approved shots of the set (none ⇒ fail before any AI token), check out the
 * scenes (`marketing/` at `4pm/marketing/<base>`) and the app (`source/` at the source ref, which must be on `<base>`)
 * as detached worktrees in a shared temp dir the agent works in; **finish** (inside the command, before `done`) —
 * commit the agent's `.4pm/marketing/**` changes (sidecars and `SHOTS.md` restored) and push, start the app with
 * `run.yaml` (or use the target URL), run the set's driver capture, upload every output file, and send the report
 * (also printed as `<marketing-run>{…}</marketing-run>`). The temp dir and worktrees are always removed. The recipe
 * steps, the app and the capture run under the project's egress context with the run id, so a connection the project's
 * Networks refuse is named in the log and fails the run as `MARKETING_EGRESS_BLOCKED`; the app start + capture hold the
 * worker's render slot.
 * @adr 0640 @adr 0646 @arch 0067
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { wrapUntrusted } from "@4pm/constants";
import {
  MARKETING_ASSET_MAX_BYTES,
  MARKETING_REF_RE,
  MARKETING_ROOT,
  MARKETING_RUN_MAX_FILES,
  MARKETING_RUN_TAG,
  MARKETING_SET_RE,
  marketingBranch,
  marketingRecipeSchema,
  marketingShotHashInput,
  parseMarketingFileName,
  parseMarketingShots,
  type MarketingRecipe,
  type MarketingRunReport,
  type MarketingSetSettings,
  type MarketingShot,
} from "@4pm/dto";
import { WsChannels, type CommandDispatchPayload, type MarketingRunSpec } from "@4pm/ws";
import { parse as parseYaml } from "yaml";
import { makeAgentTempDir, removeSharedTree, shareWithAgent, unregisterAgentRoot } from "../../utils/agent-user";
import { egressEnv } from "../network/egress-env";
import { watchRefusedEgress } from "../network/egress-events";
import { readSecretValues } from "../worker/secrets";
import type { AiRunOverrides } from "../ws-client/command-dispatch";
import type { WsHandlerCtx } from "../ws-client/context";
import { clientHeaders } from "../../services/api";
import { marketingRef, mg, mgq, readMarketingFile } from "./marketing-git";
import { runShell, runStep, startShell, stopGroup, withRenderSlot, type LineSink } from "./marketing-process";
import { ensurePlaywright, ensureTerminalTools, hasCommand, marketingBinDir, playwrightEnv } from "./marketing-tools";

/** The agent run the job wraps (injected by the dispatch path). */
export type MarketingAgentRun = (prompt: string, overrides: AiRunOverrides) => Promise<unknown>;

/** Step budgets. */
const BUILD_TIMEOUT_MS = 20 * 60_000;
const SEED_TIMEOUT_MS = 10 * 60_000;
const CAPTURE_TIMEOUT_MS = 15 * 60_000;
/** Capture / app lines streamed to the run log at most. */
const MAX_LOG_LINES = 400;

/** A failure with a run code. */
export class RunFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** What prepare hands to finish. */
interface Prepared {
  root: string;
  dir: string;
  marketingDir: string;
  sourceDir: string;
  outDir: string;
  sourceSha: string;
  settings: MarketingSetSettings;
  shots: MarketingShot[];
}

/** SHA-256 hex. */
export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** A line sink that stops after `max` lines (with one note). */
export function capped(sink: LineSink, max = MAX_LOG_LINES): LineSink {
  let n = 0;
  return (line) => {
    n++;
    if (n <= max) sink(line);
    else if (n === max + 1) sink("… (more output not shown)");
  };
}

/** Check out both worktrees for a run. */
async function prepare(root: string, spec: MarketingRunSpec, log: LineSink): Promise<Prepared> {
  if (!MARKETING_SET_RE.test(spec.set)) throw new RunFailure("MARKETING_SET_NOT_FOUND", "Bad set name.");
  if (spec.sourceRef && !MARKETING_REF_RE.test(spec.sourceRef)) throw new RunFailure("MARKETING_SOURCE_REF_INVALID", "Bad source ref.");
  log(`marketing: fetching ${spec.base} and ${marketingBranch(spec.base)}…`);
  await mgq(root, ["fetch", "-q", "--tags", "origin", `+refs/heads/${spec.base}:refs/remotes/origin/${spec.base}`]);
  const commit = await marketingRef(root, spec.base);
  const file = await readMarketingFile(root, commit, `photos/${spec.set}/SHOTS.md`);
  if (!commit || !file) throw new RunFailure("MARKETING_SET_NOT_FOUND", `The set ${spec.set} is not on ${marketingBranch(spec.base)}.`);
  const parsed = parseMarketingShots(file.content);
  let approvals: Record<string, { hash?: string }> = {};
  try {
    approvals = JSON.parse((await readMarketingFile(root, commit, "approvals.json"))?.content ?? "{}") as typeof approvals;
  } catch {
    approvals = {};
  }
  const shots = parsed.shots.filter((s) => approvals[`${spec.set}/${s.id}`]?.hash === sha256(marketingShotHashInput(parsed.frontMatter, s.section)));
  if (shots.length === 0) throw new RunFailure("MARKETING_NO_APPROVED_SHOTS", "No shot of this set is approved.");
  log(`marketing: ${shots.length} approved shot(s) of ${parsed.shots.length}`);

  const baseRef = `refs/remotes/origin/${spec.base}`;
  const sourceSha = (await mgq(root, ["rev-parse", "--verify", "--quiet", `${spec.sourceRef ?? baseRef}^{commit}`])).trim();
  if (!sourceSha) throw new RunFailure("MARKETING_SOURCE_REF_INVALID", `Unknown source ref ${spec.sourceRef ?? spec.base}.`);
  if (spec.sourceRef) {
    try {
      await mg(root, ["merge-base", "--is-ancestor", sourceSha, baseRef]);
    } catch {
      throw new RunFailure("MARKETING_SOURCE_REF_INVALID", `${spec.sourceRef} is not on ${spec.base}.`);
    }
  }

  const dir = makeAgentTempDir("4pm-marketing-");
  const marketingDir = join(dir, "marketing");
  const sourceDir = join(dir, "source");
  const outDir = join(dir, "out");
  await mg(root, ["worktree", "add", "-q", "--detach", marketingDir, commit]);
  await mg(root, ["worktree", "add", "-q", "--detach", sourceDir, sourceSha], undefined, 600_000);
  await mgq(sourceDir, ["submodule", "update", "--init", "-q"]);
  mkdirSync(outDir, { recursive: true });
  shareWithAgent(outDir);
  log(`marketing: source ${spec.sourceRef ?? spec.base} @ ${sourceSha.slice(0, 10)}`);
  return { root, dir, marketingDir, sourceDir, outDir, sourceSha, settings: parsed.settings, shots };
}

/** The block the cli appends to the server's prompt: paths + the approved shots (untrusted). */
function promptContext(p: Prepared, spec: MarketingRunSpec): string {
  const data = JSON.stringify({ settings: p.settings, shots: p.shots.map(({ id, title, fields }) => ({ id, title, fields })) }, null, 2);
  return [
    "",
    `Working folder: ${p.dir}`,
    `- source/ = the app at ${p.sourceSha.slice(0, 12)} (read-only)`,
    `- marketing/.4pm/marketing/ = where you write (set folder: photos/${spec.set}/)`,
    "The approved shots and the set settings (the same JSON the capture receives as MKT_SHOTS):",
    wrapUntrusted(data, { kind: "data", source: "marketing-shots" }),
  ].join("\n");
}

/**
 * Commit + push the agent's marketing changes in the `marketing/` worktree `wt`, after restoring `keep` (the users'
 * scene file) and the sidecars; the commit sha (HEAD when nothing changed).
 */
export async function commitMarketingWork(wt: string, base: string, keep: string, subject: string, log: LineSink): Promise<string | null> {
  // The scenes and the sidecars are the users' — never the agent's.
  for (const f of [`${MARKETING_ROOT}/approvals.json`, `${MARKETING_ROOT}/authors.json`, `${MARKETING_ROOT}/${keep}`]) {
    await mgq(wt, ["checkout", "HEAD", "--", f]);
  }
  await mg(wt, ["add", "-A", "--", MARKETING_ROOT]);
  if (!(await mgq(wt, ["diff", "--cached", "--name-only"])).trim()) {
    log("marketing: the marketing code is unchanged");
    return (await mgq(wt, ["rev-parse", "HEAD"])).trim() || null;
  }
  const ident = ["-c", "user.name=4PM", "-c", "user.email=4pm@users.noreply.4pm"];
  await mg(wt, [...ident, "commit", "-q", "-m", subject]);
  const branch = marketingBranch(base);
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await mg(wt, ["push", "-q", "origin", `HEAD:refs/heads/${branch}`], undefined, 180_000);
      const sha = (await mg(wt, ["rev-parse", "HEAD"])).trim();
      log(`marketing: marketing code committed (${sha.slice(0, 10)})`);
      return sha;
    } catch (err) {
      if (attempt === 3) throw new RunFailure("MARKETING_WRITE_FAILED", `Push of the marketing code failed: ${err instanceof Error ? err.message : String(err)}`);
      // Someone saved scenes meanwhile: replay the commit on top.
      await mg(wt, ["fetch", "-q", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
      await mg(wt, [...ident, "rebase", "-q", `refs/remotes/origin/${branch}`]);
    }
  }
  return null;
}

/** Read + validate the recipe the run uses. */
function readRecipe(p: Prepared): MarketingRecipe {
  let text: string;
  try {
    text = readFileSync(join(p.marketingDir, MARKETING_ROOT, "run.yaml"), "utf8");
  } catch {
    throw new RunFailure("MARKETING_INVALID_RECIPE", "run.yaml is missing — write it in Marketing ▸ Settings, or let the agent draft it.");
  }
  const checked = marketingRecipeSchema.safeParse(parseYaml(text));
  if (!checked.success) {
    const issue = checked.error.issues[0];
    throw new RunFailure("MARKETING_INVALID_RECIPE", `run.yaml: ${issue ? `${issue.path.join(".")} ${issue.message}` : "invalid"}`);
  }
  return checked.data;
}

/** The recipe env with `secret:<KEY>` values resolved from the project secrets. */
async function recipeEnv(root: string, recipe: MarketingRecipe): Promise<Record<string, string>> {
  const keys = Object.values(recipe.env).filter((v) => v.startsWith("secret:")).map((v) => v.slice(7));
  const secrets = await readSecretValues(root, keys);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(recipe.env)) {
    if (!v.startsWith("secret:")) env[k] = v;
    else if (secrets[v.slice(7)] !== undefined) env[k] = secrets[v.slice(7)]!;
    else throw new RunFailure("MARKETING_INVALID_RECIPE", `run.yaml: the project secret ${v.slice(7)} is not set.`);
  }
  return env;
}

/** Wait until the app answers (URL) or prints the ready line (log); throws on timeout / exit. */
async function waitReady(recipe: MarketingRecipe, app: ChildProcess, seen: () => string[]): Promise<void> {
  const deadline = Date.now() + recipe.ready.timeoutSec * 1000;
  while (Date.now() < deadline) {
    if (app.exitCode !== null) throw new RunFailure("MARKETING_APP_START_FAILED", `The app exited (code ${app.exitCode}) before it was ready.`);
    if (recipe.ready.log && seen().some((l) => l.includes(recipe.ready.log!))) return;
    if (recipe.ready.url) {
      try {
        const res = await fetch(recipe.ready.url, { redirect: "manual", signal: AbortSignal.timeout(5_000) });
        if (res.status < 400) return;
      } catch {
        /* not up yet */
      }
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new RunFailure("MARKETING_APP_START_FAILED", `The app was not ready within ${recipe.ready.timeoutSec} s.`);
}

/** The test accounts the shots name, from the project secrets (`user:password`). */
async function accounts(root: string, shots: MarketingShot[]): Promise<Record<string, { user: string; password: string }>> {
  const keys = [...new Set(shots.map((s) => s.fields.account).filter((k): k is string => Boolean(k)))];
  const values = await readSecretValues(root, keys);
  const out: Record<string, { user: string; password: string }> = {};
  for (const [k, v] of Object.entries(values)) {
    const i = v.indexOf(":");
    out[k] = i >= 0 ? { user: v.slice(0, i), password: v.slice(i + 1) } : { user: v, password: "" };
  }
  return out;
}

/** The egress variables of the run's processes (`{}` when the proxy is off). */
export function netEnv(runId: string): Record<string, string> {
  const env = egressEnv(process.env, { runId });
  return Object.keys(env).length > 0 ? { ...env, NODE_USE_ENV_PROXY: "1" } : {};
}

/** Run the set's driver capture into the out dir. */
async function capture(p: Prepared, spec: MarketingRunSpec, baseUrl: string | null, log: LineSink): Promise<void> {
  const captureDir = join(p.marketingDir, MARKETING_ROOT, "photos", spec.set, "capture");
  const env: Record<string, string> = {
    ...netEnv(spec.runId),
    MKT_OUT_DIR: p.outDir,
    MKT_SHOTS: JSON.stringify({ settings: p.settings, shots: p.shots.map(({ id, title, fields }) => ({ id, title, fields })) }),
    MKT_ACCOUNTS: JSON.stringify(await accounts(p.root, p.shots)),
    MKT_RUN_ID: spec.runId,
    ...(baseUrl ? { MKT_BASE_URL: baseUrl } : {}),
  };
  const out = capped(log);
  if (p.settings.driver === "terminal") {
    let toolEnv: Record<string, string>;
    try {
      toolEnv = await ensureTerminalTools(log);
    } catch (err) {
      throw new RunFailure("MARKETING_TOOL_MISSING", err instanceof Error ? err.message : String(err));
    }
    let tapes: string[] = [];
    try {
      tapes = readdirSync(captureDir).filter((f) => f.endsWith(".tape")).sort();
    } catch {
      /* no capture folder */
    }
    if (tapes.length === 0) throw new RunFailure("MARKETING_CAPTURE_FAILED", "No .tape script was written for the set.");
    for (const tape of tapes) {
      log(`marketing: vhs ${tape}`);
      const own = join(marketingBinDir(), process.platform === "win32" ? "vhs.exe" : "vhs");
      const code = await runStep(existsSync(own) ? own : "vhs", [tape], captureDir, { ...env, ...toolEnv }, CAPTURE_TIMEOUT_MS, out);
      if (code !== 0) log(`marketing: ${tape} failed (exit ${code})`);
    }
    return;
  }
  await ensurePlaywright(log);
  let cmd = "node";
  let args = ["capture.mjs"];
  if (p.settings.driver === "electron" && process.platform === "linux" && !process.env.DISPLAY) {
    if (!(await hasCommand("xvfb-run"))) throw new RunFailure("MARKETING_TOOL_MISSING", "The electron driver needs Xvfb (xvfb-run) on a Linux worker.");
    cmd = "xvfb-run";
    args = ["-a", "node", "capture.mjs"];
  }
  log(`marketing: capturing (${p.settings.driver})…`);
  const code = await runStep(cmd, args, captureDir, { ...env, ...playwrightEnv() }, CAPTURE_TIMEOUT_MS, out);
  if (code !== 0) log(`marketing: the capture exited with ${code}`);
}

/** Start the app (local target, not terminal) with the recipe, run the capture, stop the app. */
async function shoot(p: Prepared, spec: MarketingRunSpec, emit: LineSink): Promise<void> {
  let app: ChildProcess | null = null;
  const appLines: string[] = [];
  try {
    let baseUrl: string | null = spec.targetUrl;
    if (spec.target === "local" && p.settings.driver !== "terminal") {
      const recipe = readRecipe(p);
      const env = { ...netEnv(spec.runId), ...(await recipeEnv(p.root, recipe)) };
      const cwd = join(p.sourceDir, recipe.workdir);
      for (const [step, line] of [["install", recipe.install], ["build", recipe.build]] as const) {
        if (!line) continue;
        emit(`marketing: ${step}: ${line}`);
        const code = await runShell(line, cwd, env, BUILD_TIMEOUT_MS, capped(emit, 60));
        if (code !== 0) throw new RunFailure("MARKETING_APP_START_FAILED", `${step} failed (exit ${code}).`);
      }
      emit(`marketing: start: ${recipe.start}`);
      app = startShell(recipe.start, cwd, env, (l) => {
        appLines.push(l);
        if (appLines.length > 200) appLines.shift();
      });
      await waitReady(recipe, app, () => appLines);
      emit("marketing: the app is ready");
      if (recipe.seed) {
        const code = await runShell(recipe.seed, cwd, env, SEED_TIMEOUT_MS, capped(emit, 60));
        if (code !== 0) throw new RunFailure("MARKETING_APP_START_FAILED", `seed failed (exit ${code}).`);
      }
      baseUrl = recipe.url;
    }
    await capture(p, spec, baseUrl, emit);
  } catch (err) {
    if (appLines.length) for (const l of appLines.slice(-30)) emit(`app | ${l}`);
    throw err;
  } finally {
    if (app) await stopGroup(app);
  }
}

/** Upload the output files; returns how many were stored. */
async function upload(ctx: WsHandlerCtx, p: Prepared, spec: MarketingRunSpec, log: LineSink): Promise<number> {
  const ids = new Set(p.shots.map((s) => s.id));
  const names = readdirSync(p.outDir)
    .filter((n) => {
      const m = parseMarketingFileName(n);
      return m !== null && ids.has(m.shotId);
    })
    .sort()
    .slice(0, MARKETING_RUN_MAX_FILES);
  let stored = 0;
  for (const name of names) {
    const path = join(p.outDir, name);
    if (statSync(path).size > MARKETING_ASSET_MAX_BYTES) {
      log(`marketing: ${name} is over 20 MB — skipped`);
      continue;
    }
    const res = await fetch(`${ctx.serverUrl}${spec.uploadPath}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${spec.uploadToken}`, "Content-Type": "application/octet-stream", "X-Marketing-File": name, ...clientHeaders() },
      body: readFileSync(path),
      signal: AbortSignal.timeout(120_000),
    }).catch((err: unknown) => ({ ok: false, status: 0, statusText: String(err) }) as Response);
    if (res.ok) stored++;
    else log(`marketing: upload of ${name} failed (${res.status} ${res.statusText})`);
  }
  log(`marketing: ${stored} file(s) uploaded`);
  return stored;
}

/** Send the report to the server (best-effort) and print it. */
export async function sendReport(ctx: WsHandlerCtx, spec: MarketingRunSpec, report: MarketingRunReport, log: LineSink): Promise<void> {
  try {
    const res = await fetch(`${ctx.serverUrl}${spec.uploadPath}/report`, {
      method: "POST",
      headers: { Authorization: `Bearer ${spec.uploadToken}`, "Content-Type": "application/json", ...clientHeaders() },
      body: JSON.stringify(report),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok && res.status !== 409) log(`marketing: report not accepted (${res.status})`);
  } catch (err) {
    log(`marketing: report not sent (${err instanceof Error ? err.message : String(err)})`);
  }
  log(`<${MARKETING_RUN_TAG}>${JSON.stringify(report)}</${MARKETING_RUN_TAG}>`);
}

/** Remove the worktrees and the temp dir. */
async function cleanup(p: Prepared | null): Promise<void> {
  if (!p) return;
  await mgq(p.root, ["worktree", "remove", "--force", p.marketingDir]);
  await mgq(p.root, ["worktree", "remove", "--force", p.sourceDir]);
  try {
    removeSharedTree(p.dir);
  } catch {
    /* best-effort */
  }
  unregisterAgentRoot(p.dir);
  await mgq(p.root, ["worktree", "prune"]);
}

/**
 * Run a marketing photo job for a dispatch: prepare, then the agent (through `agent`, with this job's work dir, `seq`
 * start and finish step), then cleanup. A prepare failure closes the command itself.
 */
export async function runMarketingJob(ctx: WsHandlerCtx, dispatch: CommandDispatchPayload, agent: MarketingAgentRun): Promise<void> {
  const spec = dispatch.marketing!;
  const commandId = dispatch.commandId;
  let seq = 0;
  const pre: LineSink = (line) => {
    ctx.bus.push({ source: "server", kind: "log", text: line });
    ctx.send(WsChannels.COMMAND_OUTPUT, { commandId, seq: seq++, chunk: `${line}\n`, log: true });
  };
  const report: MarketingRunReport = { ok: false, shots: 0, files: 0, sourceSha: null, commitSha: null };
  let reported = false;
  // Hosts the project's Networks refused to this run's processes (named in the log and in a failed run's error).
  const refused = new Set<string>();
  let live: LineSink | null = null;
  const unwatch = watchRefusedEgress(spec.runId, (host, port) => {
    const key = `${host}:${port}`;
    if (refused.has(key) || refused.size >= 20) return;
    refused.add(key);
    live?.(`marketing: ${key} was refused by the project's Networks`);
  });
  let prepared: Prepared | null = null;
  try {
    const root = ctx.physicRoot;
    if (!root) throw new RunFailure("MARKETING_WRITE_FAILED", "This worker serves no project.");
    prepared = await prepare(root, spec, pre);
    report.sourceSha = prepared.sourceSha;
    report.shots = prepared.shots.length;
  } catch (err) {
    report.code = err instanceof RunFailure ? err.code : "MARKETING_PREPARE_FAILED";
    report.error = err instanceof Error ? err.message : String(err);
    pre(`✗ ${report.error}`);
    await sendReport(ctx, spec, report, pre);
    ctx.send(WsChannels.COMMAND_OUTPUT, { commandId, seq: seq++, chunk: "", done: true, exitCode: 1 });
    unwatch();
    await cleanup(prepared);
    return;
  }
  const p = prepared;
  try {
    await agent(`${dispatch.cmd}\n${promptContext(p, spec)}`, {
      cwd: p.dir,
      seqStart: seq,
      finish: async (agentRun, emit) => {
        live = emit;
        try {
          if (agentRun.neverStarted || agentRun.cancelled || agentRun.exitCode !== 0) {
            throw new RunFailure(agentRun.cancelled ? "MARKETING_RUN_CANCELLED" : "MARKETING_AGENT_FAILED", agentRun.cancelled ? "The run was stopped." : `The agent run failed (exit ${agentRun.exitCode}).`);
          }
          report.commitSha = await commitMarketingWork(p.marketingDir, spec.base, `photos/${spec.set}/SHOTS.md`, `chore(marketing): ${spec.set} capture (4PM run ${spec.runId})`, emit);
          await withRenderSlot(emit, () => shoot(p, spec, emit));
          report.files = await upload(ctx, p, spec, emit);
          if (report.files === 0) throw new RunFailure("MARKETING_CAPTURE_FAILED", "The capture produced no file.");
          report.ok = true;
          return 0;
        } catch (err) {
          report.ok = false;
          report.code = err instanceof RunFailure ? err.code : "MARKETING_CAPTURE_FAILED";
          report.error = err instanceof Error ? err.message : String(err);
          // A start / capture that failed while the project's Networks refused hosts: name them.
          if (refused.size > 0 && (report.code === "MARKETING_APP_START_FAILED" || report.code === "MARKETING_CAPTURE_FAILED")) {
            report.code = "MARKETING_EGRESS_BLOCKED";
            report.error = `${report.error} Refused by the project's Networks: ${[...refused].join(", ")} — allow them in Settings ▸ Networks.`;
          }
          emit(`✗ ${report.error}`);
          return agentRun.exitCode !== 0 ? agentRun.exitCode : 1;
        } finally {
          reported = true;
          await sendReport(ctx, spec, report, emit);
        }
      },
    });
  } finally {
    unwatch();
    // A run refused before the agent (token cap / outbound review) never reached finish.
    if (!reported) {
      report.code ??= "MARKETING_AGENT_FAILED";
      report.error ??= "The agent run did not start.";
      await sendReport(ctx, spec, report, () => undefined);
    }
    await cleanup(p);
  }
}
