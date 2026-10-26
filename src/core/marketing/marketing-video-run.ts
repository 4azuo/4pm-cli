/**
 * A marketing video run on the worker (`command.dispatch` with a `marketing` spec of kind `videos`). Around the agent
 * run of the same command: **prepare** — fetch, keep the approved scenes of the video (none ⇒ fail before any AI token),
 * check out the scenes (`marketing/` at `4pm/marketing/<base>`) and the app (`source/`, read-only, for the brand) as
 * detached worktrees, download the pictures the scenes use (`photos/`), and scaffold the Remotion project from the
 * template when the video has none (or on *Update template*); **finish** — commit the agent's `.4pm/marketing/**`
 * changes and push, then, holding the worker's render slot, `npm ci` and `node render.mjs` in the project (the license
 * key only in that step's env), upload every `<video>.<locale>.mp4` / `.poster.jpg` (streamed) and send the report.
 * @adr 0646 @arch 0067
 */
import { createReadStream, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { wrapUntrusted } from "@4pm/constants";
import {
  MARKETING_POSTER_MAX_BYTES,
  MARKETING_ROOT,
  MARKETING_VIDEO_MAX_BYTES,
  MARKETING_VIDEO_RE,
  MARKETING_VIDEO_RUN_MAX_FILES,
  marketingBranch,
  marketingSceneHashInput,
  marketingSceneKey,
  parseMarketingScenes,
  parseMarketingVideoFileName,
  type MarketingRunReport,
  type MarketingScene,
  type MarketingVideoSettings,
} from "@4pm/dto";
import { WsChannels, type CommandDispatchPayload, type MarketingRunSpec, type MarketingVideoRunSpec } from "@4pm/ws";
import { execInProject } from "../agent/agent-spawn";
import { watchRefusedEgress } from "../network/egress-events";
import { makeAgentTempDir, removeSharedTree, shareWithAgent, unregisterAgentRoot } from "../../utils/agent-user";
import type { WsHandlerCtx } from "../ws-client/context";
import { marketingRef, mg, mgq, readMarketingFile } from "./marketing-git";
import { runShell, runStep, withRenderSlot, type LineSink } from "./marketing-process";
import { RunFailure, capped, commitMarketingWork, netEnv, sendReport, sha256, type MarketingAgentRun } from "./marketing-run";

/** Step budgets. */
const INSTALL_TIMEOUT_MS = 20 * 60_000;
const RENDER_TIMEOUT_MS = 60 * 60_000;

/** What prepare hands to finish. */
interface PreparedVideo {
  root: string;
  dir: string;
  marketingDir: string;
  sourceDir: string;
  photosDir: string;
  audioDir: string;
  outDir: string;
  /** `marketing/.4pm/marketing/videos/<video>/remotion`. */
  projectDir: string;
  sourceSha: string;
  settings: MarketingVideoSettings;
  scenes: MarketingScene[];
  /** The downloaded pictures, with their local file names. */
  inputs: { shot: string; file: string; theme: string | null; locale: string | null; size: string | null }[];
  templateState: string;
}

/** Download one file of the run (a picture / an audio) with the run token into `dest`. */
async function download(ctx: WsHandlerCtx, spec: MarketingRunSpec, path: string, dest: string): Promise<void> {
  const res = await fetch(`${ctx.serverUrl}${path}`, {
    headers: { Authorization: `Bearer ${spec.uploadToken}` },
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new RunFailure("MARKETING_VIDEO_NO_PHOTOS", `Download of ${path.split("/").pop()} failed (${res.status}).`);
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()), { mode: 0o644 });
}

/** Write the template files into a staging folder, then copy them into the project as the agent (so it may edit them). */
async function scaffold(p: { dir: string; projectDir: string }, template: NonNullable<MarketingVideoRunSpec["template"]>, replace: boolean, log: LineSink): Promise<void> {
  const staging = join(p.dir, "template");
  mkdirSync(staging, { recursive: true });
  shareWithAgent(staging);
  for (const f of template.files) {
    if (f.path.startsWith("/") || f.path.split("/").includes("..")) continue;
    const dest = join(staging, f.path);
    mkdirSync(join(dest, ".."), { recursive: true });
    writeFileSync(dest, Buffer.from(f.contentBase64, "base64"), { mode: 0o644 });
  }
  // Keep the brand assets the agent placed before; everything else comes from the template.
  const script = replace
    ? `set -e; mkdir -p "$2"; find "$2" -mindepth 1 -maxdepth 1 ! -name public -exec rm -rf {} +; cp -R "$1"/. "$2"/`
    : `set -e; mkdir -p "$2"; cp -R "$1"/. "$2"/`;
  await execInProject("sh", ["-c", script, "sh", staging, p.projectDir], { cwd: p.dir, timeout: 120_000 });
  log(`marketing: Remotion project ${replace ? "updated to" : "scaffolded from"} template ${template.version}`);
}

/** Check out both worktrees, download the pictures, scaffold the project when needed. */
async function prepare(ctx: WsHandlerCtx, root: string, spec: MarketingRunSpec, video: MarketingVideoRunSpec, log: LineSink): Promise<PreparedVideo> {
  if (!MARKETING_VIDEO_RE.test(spec.set)) throw new RunFailure("MARKETING_SET_NOT_FOUND", "Bad video name.");
  log(`marketing: fetching ${spec.base} and ${marketingBranch(spec.base)}…`);
  await mgq(root, ["fetch", "-q", "origin", `+refs/heads/${spec.base}:refs/remotes/origin/${spec.base}`]);
  const commit = await marketingRef(root, spec.base);
  const file = await readMarketingFile(root, commit, `videos/${spec.set}/SCENES.md`);
  if (!commit || !file) throw new RunFailure("MARKETING_SET_NOT_FOUND", `The video ${spec.set} is not on ${marketingBranch(spec.base)}.`);
  const parsed = parseMarketingScenes(file.content);
  let approvals: Record<string, { hash?: string }> = {};
  try {
    approvals = JSON.parse((await readMarketingFile(root, commit, "approvals.json"))?.content ?? "{}") as typeof approvals;
  } catch {
    approvals = {};
  }
  const scenes = parsed.scenes.filter((s) => approvals[marketingSceneKey(spec.set, s.id)]?.hash === sha256(marketingSceneHashInput(parsed.frontMatter, s.section)));
  if (scenes.length === 0) throw new RunFailure("MARKETING_NO_APPROVED_SCENES", "No scene of this video is approved.");
  log(`marketing: ${scenes.length} approved scene(s) of ${parsed.scenes.length}`);

  const sourceSha = (await mgq(root, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${spec.base}^{commit}`])).trim();
  if (!sourceSha) throw new RunFailure("MARKETING_SOURCE_REF_INVALID", `Unknown base ${spec.base}.`);
  const dir = makeAgentTempDir("4pm-marketing-video-");
  const marketingDir = join(dir, "marketing");
  const sourceDir = join(dir, "source");
  const photosDir = join(dir, "photos");
  const audioDir = join(dir, "audio");
  const outDir = join(dir, "out");
  await mg(root, ["worktree", "add", "-q", "--detach", marketingDir, commit]);
  await mg(root, ["worktree", "add", "-q", "--detach", sourceDir, sourceSha], undefined, 600_000);
  for (const d of [photosDir, audioDir, outDir]) {
    mkdirSync(d, { recursive: true });
    shareWithAgent(d);
  }
  // Pictures: one local file per input, prefixed by its set (two sets may hold the same file name).
  const inputs: PreparedVideo["inputs"] = [];
  for (const i of video.inputs) {
    const local = `${i.shot.split("/")[0]}__${i.file}`;
    await download(ctx, spec, `${video.inputPath}/${i.assetId}`, join(photosDir, local));
    inputs.push({ shot: i.shot, file: local, theme: i.theme, locale: i.locale, size: i.size });
  }
  log(`marketing: ${inputs.length} picture(s) downloaded`);
  for (const a of video.audio ?? []) await download(ctx, spec, `${video.inputPath}/audio/${a.id}`, join(audioDir, `${a.id}.${a.ext}`));

  const projectDir = join(marketingDir, MARKETING_ROOT, "videos", spec.set, "remotion");
  const hasProject = existsSync(join(projectDir, "package.json"));
  let templateState = "kept as committed";
  if (!hasProject || video.updateTemplate) {
    if (!video.template) throw new RunFailure("MARKETING_TEMPLATE_UNAVAILABLE", "The video template is not available on this 4PM server.");
    await scaffold({ dir, projectDir }, video.template, hasProject, log);
    templateState = hasProject ? `just updated to template ${video.template.version} — re-apply the brand` : `just scaffolded from template ${video.template.version}`;
  }
  log(`marketing: source ${spec.base} @ ${sourceSha.slice(0, 10)}`);
  return { root, dir, marketingDir, sourceDir, photosDir, audioDir, outDir, projectDir, sourceSha, settings: parsed.settings, scenes, inputs, templateState };
}

/** The block the cli appends to the server's prompt: paths + the approved scenes (untrusted). */
function promptContext(p: PreparedVideo, spec: MarketingRunSpec): string {
  const data = JSON.stringify({ settings: p.settings, scenes: p.scenes.map(({ section: _s, ...rest }: MarketingScene & { section?: string }) => rest) }, null, 2);
  return [
    "",
    `Working folder: ${p.dir}`,
    `- source/ = the app at ${p.sourceSha.slice(0, 12)} (read-only)`,
    `- marketing/.4pm/marketing/videos/${spec.set}/remotion/ = the video project (${p.templateState}) — where you write`,
    `- photos/ = the screenshots (read-only): ${p.inputs.map((i) => i.file).join(", ") || "none"}`,
    "The approved scenes and the video settings:",
    wrapUntrusted(data, { kind: "data", source: "marketing-scenes" }),
  ].join("\n");
}

/** Install the project's dependencies and render every locale into the out dir. */
async function render(p: PreparedVideo, spec: MarketingRunSpec, video: MarketingVideoRunSpec, emit: LineSink): Promise<void> {
  const net = netEnv(spec.runId);
  const out = capped(emit, 200);
  const install = existsSync(join(p.projectDir, "package-lock.json")) ? "npm ci --no-audit --no-fund" : "npm install --no-audit --no-fund";
  emit(`marketing: ${install}`);
  const code = await runShell(install, p.projectDir, net, INSTALL_TIMEOUT_MS, capped(emit, 60));
  if (code !== 0) throw new RunFailure("MARKETING_RENDER_FAILED", `${install} failed (exit ${code}).`);
  const videoJson = join(p.dir, "video.json");
  const { photos: _photos, ...settings } = p.settings;
  writeFileSync(
    videoJson,
    JSON.stringify({ name: spec.set, settings: { ...settings, photos: {} }, scenes: p.scenes.map(({ section: _s, ...rest }: MarketingScene & { section?: string }) => rest), inputs: p.inputs }),
    { mode: 0o644 },
  );
  emit(`marketing: rendering ${p.settings.locales.length} locale(s)…`);
  const env: Record<string, string> = {
    ...net,
    MKT_VIDEO_JSON: videoJson,
    MKT_INPUT_DIR: p.photosDir,
    MKT_AUDIO_DIR: p.audioDir,
    MKT_OUT_DIR: p.outDir,
    ...(video.licenseKey ? { REMOTION_LICENSE_KEY: video.licenseKey } : {}),
  };
  const rc = await runStep(process.execPath, ["render.mjs"], p.projectDir, env, RENDER_TIMEOUT_MS, out);
  if (rc !== 0) throw new RunFailure("MARKETING_RENDER_FAILED", `The render exited with ${rc}.`);
}

/** Upload the outputs (streamed); returns how many were stored. */
async function upload(ctx: WsHandlerCtx, p: PreparedVideo, spec: MarketingRunSpec, log: LineSink): Promise<number> {
  const names = readdirSync(p.outDir)
    .filter((n) => {
      const m = parseMarketingVideoFileName(n);
      return m !== null && m.video === spec.set && p.settings.locales.includes(m.locale);
    })
    .sort()
    .slice(0, MARKETING_VIDEO_RUN_MAX_FILES);
  let stored = 0;
  for (const name of names) {
    const path = join(p.outDir, name);
    const size = statSync(path).size;
    const cap = name.endsWith(".mp4") ? MARKETING_VIDEO_MAX_BYTES : MARKETING_POSTER_MAX_BYTES;
    if (size > cap) {
      log(`marketing: ${name} is over ${Math.round(cap / 1024 / 1024)} MB — skipped`);
      continue;
    }
    const res = await fetch(`${ctx.serverUrl}${spec.uploadPath}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${spec.uploadToken}`,
        "Content-Type": "application/octet-stream",
        "Content-Length": String(size),
        "X-Marketing-File": name,
      },
      body: createReadStream(path) as unknown as RequestInit["body"],
      // Node's fetch needs `duplex` for a stream body.
      ...({ duplex: "half" } as object),
      signal: AbortSignal.timeout(30 * 60_000),
    } as RequestInit).catch((err: unknown) => ({ ok: false, status: 0, statusText: String(err) }) as Response);
    if (res.ok) stored++;
    else log(`marketing: upload of ${name} failed (${res.status} ${res.statusText})`);
  }
  log(`marketing: ${stored} file(s) uploaded`);
  return stored;
}

/** Remove the worktrees and the temp dir. */
async function cleanup(p: PreparedVideo | null): Promise<void> {
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

/** Run a marketing video job for a dispatch: prepare, then the agent (with this job's work dir and finish step), then cleanup. */
export async function runMarketingVideoJob(ctx: WsHandlerCtx, dispatch: CommandDispatchPayload, agent: MarketingAgentRun): Promise<void> {
  const spec = dispatch.marketing!;
  const video = spec.video!;
  const commandId = dispatch.commandId;
  let seq = 0;
  const pre: LineSink = (line) => {
    ctx.bus.push({ source: "server", kind: "log", text: line });
    ctx.send(WsChannels.COMMAND_OUTPUT, { commandId, seq: seq++, chunk: `${line}\n`, log: true });
  };
  const report: MarketingRunReport = { ok: false, shots: 0, files: 0, sourceSha: null, commitSha: null };
  let reported = false;
  const refused = new Set<string>();
  let live: LineSink | null = null;
  const unwatch = watchRefusedEgress(spec.runId, (host, port) => {
    const key = `${host}:${port}`;
    if (refused.has(key) || refused.size >= 20) return;
    refused.add(key);
    live?.(`marketing: ${key} was refused by the project's Networks`);
  });
  let prepared: PreparedVideo | null = null;
  try {
    const root = ctx.physicRoot;
    if (!root) throw new RunFailure("MARKETING_WRITE_FAILED", "This worker serves no project.");
    prepared = await prepare(ctx, root, spec, video, pre);
    report.sourceSha = prepared.sourceSha;
    report.shots = prepared.scenes.length;
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
          report.commitSha = await commitMarketingWork(p.marketingDir, spec.base, `videos/${spec.set}/SCENES.md`, `chore(marketing): ${spec.set} video project (4PM run ${spec.runId})`, emit);
          await withRenderSlot(emit, () => render(p, spec, video, emit));
          report.files = await upload(ctx, p, spec, emit);
          if (report.files === 0) throw new RunFailure("MARKETING_RENDER_FAILED", "The render produced no file.");
          report.ok = true;
          return 0;
        } catch (err) {
          report.ok = false;
          report.code = err instanceof RunFailure ? err.code : "MARKETING_RENDER_FAILED";
          report.error = err instanceof Error ? err.message : String(err);
          if (refused.size > 0 && report.code === "MARKETING_RENDER_FAILED") {
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
    if (!reported) {
      report.code ??= "MARKETING_AGENT_FAILED";
      report.error ??= "The agent run did not start.";
      await sendReport(ctx, spec, report, () => undefined);
    }
    await cleanup(p);
  }
}
