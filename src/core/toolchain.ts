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
 */
import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
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
/** Download + extract budget for one binary release. */
const DOWNLOAD_TIMEOUT_MS = 180_000;

/** In-flight installs, so concurrent callers share one run per tool. */
const inFlight = new Map<SelfInstallTool, Promise<boolean>>();
/** Tools known present this process (skips re-probing on every AI run). */
const present = new Set<SelfInstallTool>();
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

/** Download the latest `tool` release, extract its binary into the tool dir. Throws on any failure. */
async function installReleaseBinary(tool: "gh" | "glab", onLine: (line: string) => void): Promise<void> {
  const url = await releaseUrl(tool);
  onLine(`Downloading ${url}…`);
  const res = await fetch(url, { headers: { "user-agent": "4pm-cli" }, signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  const tmp = await mkdtemp(join(tmpdir(), `4pm-${tool}-`));
  try {
    const archive = join(tmp, url.endsWith(".zip") ? "pkg.zip" : "pkg.tar.gz");
    await writeFile(archive, Buffer.from(await res.arrayBuffer()));
    const out = join(tmp, "x");
    await mkdir(out);
    // `tar` reads both .tar.gz and (bsdtar on macOS/Windows) .zip.
    await run("tar", [archive.endsWith(".zip") ? "-xf" : "-xzf", archive, "-C", out], { timeout: 60_000 });
    const binName = process.platform === "win32" ? `${tool}.exe` : tool;
    const bin = await findFile(out, binName);
    if (!bin) throw new Error(`${binName} not found in the archive.`);
    await mkdir(toolBinDir(), { recursive: true });
    const dest = join(toolBinDir(), binName);
    await copyFile(bin, dest);
    await chmod(dest, 0o755);
    onLine(`Installed ${tool} → ${dest}`);
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Install `tool` now (single-flight) — release binary for gh/glab, `npm i -g` for claude/codex. Resolves
 * true on success; never throws (a failure is logged and reported through `onLine`).
 */
export function installTool(tool: SelfInstallTool, onLine: (line: string) => void = () => undefined): Promise<boolean> {
  const running = inFlight.get(tool);
  if (running) return running;
  const job = (async (): Promise<boolean> => {
    try {
      if (BINARY_TOOLS.has(tool)) {
        await installReleaseBinary(tool as "gh" | "glab", onLine);
      } else {
        const res = await runWorkerToolOp("install", tool, "npm", onLine);
        if (!res.ok) throw new Error(res.error ?? "npm install failed");
      }
      present.add(tool);
      logger.info("toolchain.installed", { tool });
      reporter?.();
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
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
  if (!autoInstallOn(profileDir)) return false;
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
  for (const tool of ["gh", "glab", ...usedAiTools(profileDir)] as SelfInstallTool[]) {
    await ensureTool(profileDir, tool, onLine).catch(() => false);
  }
}

/** On-use (ADR-0396): before an AI run, install the missing AI CLIs among the plan's commands. */
export async function ensureAiClisFor(profileDir: string, cmds: string[], onLine: (line: string) => void = () => undefined): Promise<void> {
  const tools = new Set(cmds.map(aiToolOfCommand).filter((t): t is SelfInstallTool => t !== null));
  for (const tool of tools) await ensureTool(profileDir, tool, onLine);
}
