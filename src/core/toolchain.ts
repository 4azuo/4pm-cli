/**
 * Worker toolchain self-install (ADR-0396). A `base`-image worker (or a fresh host) may lack the tools
 * every worker needs; the cli installs them itself instead of failing later:
 *  - **gh / glab** — OS binaries (not npm): at every cli start when missing, the latest release archive for
 *    this OS/arch is downloaded and its binary extracted into `~/.4pm/tools/bin` (non-root; put first on
 *    PATH by `addToolDirToPath`). gh from the GitHub release API, glab from the GitLab one.
 *  - **claude / codex** — npm packages: at start for the providers of enabled AI profiles, and on use
 *    (before an AI run, when `ai.models` finds the CLI missing) — `npm i -g <package>`.
 * Every install is single-flight per tool, logged, and followed by a tools snapshot report. A failure
 * never stops the cli (the tool stays missing; the Tools tab offers Install). `autoInstallTools: false`
 * in config.json turns the automatic installs off (the manual Install still works).
 * Slow links are expected (a container shares the host's bandwidth with its siblings): downloads use an
 * **idle** timeout (no bytes for 2 min) instead of a total one, npm gets 30 min, an interrupted npm install's
 * leftovers are cleaned before a retry, and a failed automatic install backs off (15 min) so a polling page
 * can't turn it into a retry loop; a failed start-up install is retried in the background (5 → 15 → 30 min).
 */
import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readdir, rename, rm } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { WORKER_TOOL_CATALOG } from "@4pm/constants";
import { readProfileConfig } from "../config/profile";
import { logger } from "../common/logger/logger";
import { isToolInstalled, runWorkerToolOp } from "./worker-tools";

const run = promisify(execFile);

/** The tools the cli can install while missing (ADR-0396). */
export type SelfInstallTool = "gh" | "glab" | "claude" | "codex";
/** The release-binary tools (not npm-distributed). */
const BINARY_TOOLS = new Set<SelfInstallTool>(["gh", "glab"]);
/** A download is aborted only after this long without receiving a byte (not a total budget). */
const DOWNLOAD_IDLE_MS = 120_000;
/** Total budget for one npm AI-CLI install (claude-code pulls a large native binary). */
const NPM_INSTALL_TIMEOUT_MS = 30 * 60_000;
/** After a failed automatic install, don't start another automatic one for this long. */
const FAIL_BACKOFF_MS = 15 * 60_000;
/** Background retries of a failed start-up install. */
const BOOT_RETRY_DELAYS_MS = [5 * 60_000, 15 * 60_000, 30 * 60_000];

/** In-flight installs, so concurrent callers share one run per tool. */
const inFlight = new Map<SelfInstallTool, Promise<boolean>>();
/** Tools known present this process (skips re-probing on every AI run). */
const present = new Set<SelfInstallTool>();
/** The last failed install per tool (backs off automatic retries; surfaced by `ai.models`). */
const lastFailure = new Map<SelfInstallTool, { at: number; error: string }>();
/** Called after a successful install so the new snapshot reaches the server (set by `start`). */
let reporter: (() => void) | null = null;

/** The per-user tool dir for release binaries — on the `~/.4pm` volume in a container. */
export function toolBinDir(): string {
  return join(homedir(), ".4pm", "tools", "bin");
}

/** Put the tool dir first on this process's PATH (inherited by every child — AI runs, git, shims). */
export function addToolDirToPath(): void {
  const dir = toolBinDir();
  const parts = (process.env.PATH ?? "").split(delimiter);
  if (!parts.includes(dir)) process.env.PATH = [dir, ...parts].filter(Boolean).join(delimiter);
}

/** Register the snapshot reporter run after each successful install. */
export function setToolchainReporter(fn: (() => void) | null): void {
  reporter = fn;
}

/** Whether a self-install for `tool` is running right now. */
export function isInstalling(tool: SelfInstallTool): boolean {
  return inFlight.has(tool);
}

/** Map an AI-CLI command (as spawned) to its self-installable tool id, or null. */
export function aiToolOfCommand(cmd: string): SelfInstallTool | null {
  const base = cmd.split(/[\\/]/).pop() ?? cmd;
  if (/^claude(\.exe|\.cmd)?$/.test(base)) return "claude";
  if (/^codex(\.exe|\.cmd)?$/.test(base)) return "codex";
  return null;
}

/** Release asset naming for this OS/arch, or null when the platform has no prebuilt binary. */
function platformOf(): { os: "linux" | "darwin" | "windows"; arch: "amd64" | "arm64" } | null {
  const os = process.platform === "linux" ? "linux" : process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : null;
  const arch = process.arch === "x64" ? "amd64" : process.arch === "arm64" ? "arm64" : null;
  return os && arch ? { os, arch } : null;
}

/** Fetch JSON with a timeout; throws on a non-2xx. */
async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { accept: "application/json", "user-agent": "4pm-cli" }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** Resolve the latest release download url of `tool` for this platform. */
async function releaseUrl(tool: "gh" | "glab"): Promise<string> {
  const p = platformOf();
  if (!p) throw new Error(`No prebuilt ${tool} for ${process.platform}/${process.arch}.`);
  if (tool === "gh") {
    const rel = await getJson<{ tag_name?: string; assets?: { name: string; browser_download_url: string }[] }>(
      "https://api.github.com/repos/cli/cli/releases/latest",
    );
    const os = p.os === "darwin" ? "macOS" : p.os;
    const ext = p.os === "linux" ? ".tar.gz" : ".zip";
    const asset = (rel.assets ?? []).find((a) => a.name.endsWith(`_${os}_${p.arch}${ext}`));
    if (!asset) throw new Error(`No gh ${rel.tag_name ?? ""} asset for ${os}_${p.arch}.`);
    return asset.browser_download_url;
  }
  const rels = await getJson<{ tag_name?: string }[]>("https://gitlab.com/api/v4/projects/gitlab-org%2Fcli/releases?per_page=1");
  const v = (rels[0]?.tag_name ?? "").replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+$/.test(v)) throw new Error("Could not resolve the latest glab version.");
  const ext = p.os === "windows" ? ".zip" : ".tar.gz";
  return `https://gitlab.com/api/v4/projects/gitlab-org%2Fcli/packages/generic/glab/${v}/glab_${v}_${p.os}_${p.arch}${ext}`;
}

/** Find a file named `name` anywhere under `dir`. */
async function findFile(dir: string, name: string): Promise<string | null> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      const hit = await findFile(p, name);
      if (hit) return hit;
    } else if (e.name === name) return p;
  }
  return null;
}

/** Stream `url` into `dest`, aborting only when no byte arrives for `DOWNLOAD_IDLE_MS`. */
async function downloadTo(url: string, dest: string): Promise<void> {
  const ctrl = new AbortController();
  let idle = setTimeout(() => ctrl.abort(), DOWNLOAD_IDLE_MS);
  const bump = (): void => {
    clearTimeout(idle);
    idle = setTimeout(() => ctrl.abort(), DOWNLOAD_IDLE_MS);
  };
  try {
    const res = await fetch(url, { headers: { "user-agent": "4pm-cli" }, signal: ctrl.signal });
    if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`);
    const body = Readable.fromWeb(res.body as unknown as import("node:stream/web").ReadableStream);
    body.on("data", bump);
    await pipeline(body, createWriteStream(dest));
  } catch (err) {
    if (ctrl.signal.aborted) throw new Error(`Download stalled (no data for ${DOWNLOAD_IDLE_MS / 1000}s).`, { cause: err });
    throw err;
  } finally {
    clearTimeout(idle);
  }
}

/** Download the latest `tool` release, extract its binary into the tool dir. Throws on any failure. */
async function installReleaseBinary(tool: "gh" | "glab", onLine: (line: string) => void): Promise<void> {
  const url = await releaseUrl(tool);
  onLine(`Downloading ${url}…`);
  const tmp = await mkdtemp(join(tmpdir(), `4pm-${tool}-`));
  try {
    const archive = join(tmp, url.endsWith(".zip") ? "pkg.zip" : "pkg.tar.gz");
    await downloadTo(url, archive);
    const out = join(tmp, "x");
    await mkdir(out);
    // `tar` reads both .tar.gz and (bsdtar on macOS/Windows) .zip.
    await run("tar", [archive.endsWith(".zip") ? "-xf" : "-xzf", archive, "-C", out], { timeout: 60_000 });
    const binName = process.platform === "win32" ? `${tool}.exe` : tool;
    const bin = await findFile(out, binName);
    if (!bin) throw new Error(`${binName} not found in the archive.`);
    await mkdir(toolBinDir(), { recursive: true });
    const dest = join(toolBinDir(), binName);
    // Copy then rename, so a running copy of the old binary is replaced atomically ("text file busy").
    await copyFile(bin, `${dest}.new`);
    await chmod(`${dest}.new`, 0o755);
    await rename(`${dest}.new`, dest);
    onLine(`Installed ${tool} → ${dest}`);
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** The global npm `node_modules` dir (`npm root -g`), or null when npm can't tell. */
async function npmGlobalRoot(): Promise<string | null> {
  try {
    const { stdout } = await run("npm", ["root", "-g"], { timeout: 30_000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Remove what an interrupted `npm i -g <pkg>` leaves behind — the half-written package dir and npm's
 * `.<name>-XXXX` rename temp — which otherwise fails every later install with `ENOTEMPTY`.
 */
async function cleanNpmLeftovers(pkg: string, onLine: (line: string) => void): Promise<void> {
  const root = await npmGlobalRoot();
  if (!root) return;
  const [scope, name] = pkg.startsWith("@") ? pkg.split("/") : ["", pkg];
  const parent = scope ? join(root, scope) : root;
  const entries = await readdir(parent).catch(() => [] as string[]);
  for (const e of entries) {
    if (e === name || e.startsWith(`.${name}-`)) {
      onLine(`Cleaning a leftover ${join(parent, e)}…`);
      await rm(join(parent, e), { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

/** `npm i -g` an AI CLI with a long budget; on a timeout / ENOTEMPTY, clean the leftovers and retry once. */
async function installNpmTool(tool: SelfInstallTool, onLine: (line: string) => void): Promise<void> {
  const pkg = WORKER_TOOL_CATALOG.find((t) => t.id === tool)?.installPackage ?? tool;
  let res = await runWorkerToolOp("install", tool, "npm", onLine, NPM_INSTALL_TIMEOUT_MS);
  if (!res.ok && /ENOTEMPTY|exited 124|EEXIST/i.test(res.error ?? "")) {
    await cleanNpmLeftovers(pkg, onLine);
    onLine(`Retrying ${pkg}…`);
    res = await runWorkerToolOp("install", tool, "npm", onLine, NPM_INSTALL_TIMEOUT_MS);
  }
  if (!res.ok) throw new Error(res.error ?? "npm install failed");
}

/**
 * Install `tool` now (single-flight) — release binary for gh/glab, `npm i -g` for claude/codex. Resolves
 * true on success; never throws (a failure is logged, recorded for the back-off, and sent to `onLine`).
 * A manual Install (Tools tab) calls this directly, so it is never held back by the back-off.
 */
export function installTool(tool: SelfInstallTool, onLine: (line: string) => void = () => undefined): Promise<boolean> {
  const running = inFlight.get(tool);
  if (running) return running;
  const job = (async (): Promise<boolean> => {
    try {
      if (BINARY_TOOLS.has(tool)) await installReleaseBinary(tool as "gh" | "glab", onLine);
      else await installNpmTool(tool, onLine);
      present.add(tool);
      lastFailure.delete(tool);
      logger.info("toolchain.installed", { tool });
      reporter?.();
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      lastFailure.set(tool, { at: Date.now(), error: msg });
      onLine(`✗ ${tool}: ${msg}`);
      logger.warn("toolchain.install.failed", { tool, error: msg });
      return false;
    } finally {
      inFlight.delete(tool);
    }
  })();
  inFlight.set(tool, job);
  return job;
}

/** The last install failure of `tool` while its back-off is active, else null. */
export function recentInstallFailure(tool: SelfInstallTool): string | null {
  const f = lastFailure.get(tool);
  return f && Date.now() - f.at < FAIL_BACKOFF_MS ? f.error : null;
}

/**
 * Start an automatic install of a tool already known missing, unless one is running, auto-install is off,
 * or the last attempt failed recently (back-off). Returns whether an install is running afterwards — sync,
 * so `ai.models` can report `installing` truthfully.
 */
export function kickInstall(profileDir: string, tool: SelfInstallTool, onLine: (line: string) => void = () => undefined): boolean {
  if (inFlight.has(tool)) return true;
  if (!autoInstallOn(profileDir) || recentInstallFailure(tool)) return false;
  void installTool(tool, onLine);
  return true;
}

/** Whether `tool` is on PATH now (cached once found). */
export async function hasTool(tool: SelfInstallTool): Promise<boolean> {
  if (present.has(tool)) return true;
  const entry = WORKER_TOOL_CATALOG.find((t) => t.id === tool);
  const ok = await isToolInstalled(tool, entry?.versionArg ?? "--version");
  if (ok) present.add(tool);
  return ok;
}

/** Automatic installs are on unless config.json says `autoInstallTools: false`. */
function autoInstallOn(profileDir: string): boolean {
  try {
    return readProfileConfig(profileDir).autoInstallTools !== false;
  } catch {
    return true;
  }
}

/** Install `tool` when missing (and auto-install is on); resolves whether it is present afterwards. */
export async function ensureTool(profileDir: string, tool: SelfInstallTool, onLine: (line: string) => void = () => undefined): Promise<boolean> {
  if (await hasTool(tool)) return true;
  const running = inFlight.get(tool);
  if (running) return running;
  if (!autoInstallOn(profileDir) || recentInstallFailure(tool)) return false;
  onLine(`${tool} is not installed — installing it…`);
  return installTool(tool, onLine);
}

/** The AI providers used by the enabled profiles of this cli's config (unified list, else legacy). */
function usedAiTools(profileDir: string): SelfInstallTool[] {
  const config = readProfileConfig(profileDir);
  const out = new Set<SelfInstallTool>();
  if (Array.isArray(config.aiProfiles) && config.aiProfiles.length > 0) {
    for (const p of config.aiProfiles) {
      if (p.enabled === false) continue;
      if (p.provider === "claude" || p.provider === "codex") out.add(p.provider);
    }
  } else {
    if ((config.claudeHome ?? []).some((p) => p.enabled !== false)) out.add("claude");
    if ((config.codexHome ?? []).some((p) => p.enabled !== false)) out.add("codex");
    const cli = aiToolOfCommand(config.aiCli || "claude");
    if (cli) out.add(cli);
  }
  return [...out];
}

/**
 * Start-up self-heal (ADR-0396): gh + glab always, then the AI CLIs of the enabled profiles. Sequential
 * (npm installs must not race on the global prefix); best-effort; logs through `onLine`.
 */
export async function ensureToolchainAtBoot(profileDir: string, onLine: (line: string) => void): Promise<void> {
  if (!autoInstallOn(profileDir)) return;
  const tools = ["gh", "glab", ...usedAiTools(profileDir)] as SelfInstallTool[];
  const failed: SelfInstallTool[] = [];
  for (const tool of tools) if (!(await ensureTool(profileDir, tool, onLine).catch(() => false))) failed.push(tool);
  if (failed.length > 0) scheduleBootRetry(profileDir, failed, onLine, 0);
}

/** Retry the start-up installs that failed, on a widening schedule (timers never keep the process alive). */
function scheduleBootRetry(profileDir: string, tools: SelfInstallTool[], onLine: (line: string) => void, attempt: number): void {
  const delay = BOOT_RETRY_DELAYS_MS[attempt];
  if (delay === undefined) return;
  const timer = setTimeout(() => {
    void (async () => {
      const still: SelfInstallTool[] = [];
      for (const tool of tools) {
        if (await hasTool(tool)) continue;
        if (!(await installTool(tool, onLine))) still.push(tool);
      }
      if (still.length > 0) scheduleBootRetry(profileDir, still, onLine, attempt + 1);
    })();
  }, delay);
  timer.unref?.();
}

/** On-use (ADR-0396): before an AI run, install the missing AI CLIs among the plan's commands. */
export async function ensureAiClisFor(profileDir: string, cmds: string[], onLine: (line: string) => void = () => undefined): Promise<void> {
  const tools = new Set(cmds.map(aiToolOfCommand).filter((t): t is SelfInstallTool => t !== null));
  for (const tool of tools) await ensureTool(profileDir, tool, onLine);
}
