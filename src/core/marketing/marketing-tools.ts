/**
 * The capture tools of a marketing run. Playwright + its Chromium are self-installed on first use into the cli's tool
 * folder (`~/.4pm/tools/marketing`, browsers under `browsers/`), single-flight, then exposed read-only to the agent; a
 * capture script resolves `playwright` through `NODE_PATH`. The terminal driver's VHS + ttyd (pinned release binaries)
 * and ffmpeg (`ffmpeg-static`) are installed on first use into `bin/` — unless already on PATH — with the Playwright
 * Chromium linked there as `chromium` for VHS (go-rod looks it up on PATH). ttyd on macOS and Xvfb (Electron on Linux)
 * are only detected. The same probes report the feature tools of the Tools tab.
 * @adr 0640 @adr 0641 @adr 0396
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, rename, rm, symlink, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { exposeToAgent } from "../../utils/agent-user";
import type { FeatureToolItem } from "@4pm/ws";
import { downloadTo, findFile, toolBinDir } from "../worker/toolchain";
import { runStep, type LineSink } from "./marketing-process";

const run = promisify(execFile);

/** The Playwright version the cli installs (scripts import `playwright`). */
export const PLAYWRIGHT_VERSION = "1.64.1";
/** npm + browser download budget. */
const INSTALL_TIMEOUT_MS = 30 * 60_000;

/** The marketing tool folder. */
export function marketingToolsDir(): string {
  return join(dirname(toolBinDir()), "marketing");
}

/** The env a capture needs to find Playwright and its browsers. */
export function playwrightEnv(): Record<string, string> {
  const dir = marketingToolsDir();
  return { NODE_PATH: join(dir, "node_modules"), PLAYWRIGHT_BROWSERS_PATH: join(dir, "browsers") };
}

/** Is a command on PATH? */
export async function hasCommand(cmd: string): Promise<boolean> {
  try {
    await run("/bin/sh", ["-c", `command -v ${cmd}`], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

/** The Playwright version in the tool folder, or null. A different one is replaced by the pinned version. */
function installedVersion(): string | null {
  try {
    const pkg = JSON.parse(readFileSync(join(playwrightEnv().NODE_PATH!, "playwright", "package.json"), "utf8")) as { version?: string };
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

let installing: Promise<void> | null = null;

/** Install Playwright + Chromium when missing (single-flight). Throws when the install fails. */
export function ensurePlaywright(sink: LineSink): Promise<void> {
  const dir = marketingToolsDir();
  const env = playwrightEnv();
  if (installedVersion() === PLAYWRIGHT_VERSION && existsSync(env.PLAYWRIGHT_BROWSERS_PATH!)) return Promise.resolve();
  installing ??= (async () => {
    try {
      await mkdir(dir, { recursive: true });
      sink(`installing Playwright ${PLAYWRIGHT_VERSION} (first marketing run on this worker)…`);
      const npm = await runStep("npm", ["i", "--no-audit", "--no-fund", "--prefix", dir, `playwright@${PLAYWRIGHT_VERSION}`], dir, {}, INSTALL_TIMEOUT_MS, () => undefined);
      if (npm !== 0) throw new Error(`npm install playwright failed (exit ${npm})`);
      sink("downloading Chromium for Playwright…");
      const cli = join(dir, "node_modules", "playwright", "cli.js");
      const browsers = await runStep(process.execPath, [cli, "install", "chromium"], dir, env, INSTALL_TIMEOUT_MS, () => undefined);
      if (browsers !== 0) throw new Error(`playwright install chromium failed (exit ${browsers})`);
      exposeToAgent(dir);
      sink("✓ Playwright ready");
    } finally {
      installing = null;
    }
  })();
  return installing;
}

/** Pinned terminal-driver tools. */
export const VHS_VERSION = "0.12.1";
export const TTYD_VERSION = "1.7.7";
export const FFMPEG_STATIC_VERSION = "5.3.0";

/** The folder of the self-installed terminal tools (first on a terminal capture's PATH). */
export function marketingBinDir(): string {
  return join(marketingToolsDir(), "bin");
}

/** The executable name on this OS. */
function exe(name: string): string {
  return process.platform === "win32" ? `${name}.exe` : name;
}

/** First line of `<cmd> <args>`, or null when it doesn't run. */
async function versionOf(cmd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout, stderr } = await run(cmd, args, { timeout: 10_000 });
    return (stdout || stderr).split("\n")[0]!.trim().slice(0, 80) || null;
  } catch {
    return null;
  }
}

/** The VHS release archive of this platform, or null. */
function vhsAsset(): string | null {
  const os = process.platform === "linux" ? "Linux" : process.platform === "darwin" ? "Darwin" : process.platform === "win32" ? "Windows" : null;
  const arch = process.arch === "x64" ? "x86_64" : process.arch === "arm64" ? "arm64" : null;
  if (!os || !arch || (os === "Windows" && arch === "arm64")) return null;
  return `vhs_${VHS_VERSION}_${os}_${arch}.${os === "Windows" ? "zip" : "tar.gz"}`;
}

/** The ttyd release binary of this platform, or null (macOS has none). */
function ttydAsset(): string | null {
  if (process.platform === "linux") return process.arch === "x64" ? "ttyd.x86_64" : process.arch === "arm64" ? "ttyd.aarch64" : null;
  if (process.platform === "win32") return "ttyd.win32.exe";
  return null;
}

/** Copy a file into the bin folder as `name` (atomic replace), executable. */
async function placeBin(src: string, name: string): Promise<void> {
  const dest = join(marketingBinDir(), name);
  await copyFile(src, `${dest}.new`);
  await chmod(`${dest}.new`, 0o755);
  await rename(`${dest}.new`, dest);
}

/** Point `bin/<name>` at `target` (a symlink; a copy where links are not allowed). */
async function linkBin(target: string, name: string): Promise<void> {
  const dest = join(marketingBinDir(), name);
  await unlink(dest).catch(() => undefined);
  try {
    await symlink(target, dest);
  } catch {
    await placeBin(target, name);
  }
}

/** The Playwright Chromium executable, or null. */
function playwrightChromium(): string | null {
  const root = playwrightEnv().PLAYWRIGHT_BROWSERS_PATH!;
  let dirs: string[];
  try {
    dirs = readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort();
  } catch {
    return null;
  }
  const dir = dirs.at(-1);
  if (!dir) return null;
  const candidates = [
    ["chrome-linux64", "chrome"],
    ["chrome-linux", "chrome"],
    ["chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"],
    ["chrome-mac-arm64", "Chromium.app", "Contents", "MacOS", "Chromium"],
    ["chrome-win64", "chrome.exe"],
    ["chrome-win", "chrome.exe"],
  ];
  for (const c of candidates) {
    const p = join(root, dir, ...c);
    if (existsSync(p)) return p;
  }
  return null;
}

let terminalInstalling: Promise<Record<string, string>> | null = null;

/**
 * Make VHS + ttyd + ffmpeg (+ a Chromium for VHS) available for a terminal capture, installing what is missing.
 * Returns the env the capture runs with (`PATH` with the tool folder first). Throws `Error` with what to install by
 * hand when a tool has no prebuilt binary here.
 */
export function ensureTerminalTools(sink: LineSink): Promise<Record<string, string>> {
  terminalInstalling ??= (async () => {
    try {
      const bin = marketingBinDir();
      await mkdir(bin, { recursive: true });
      // VHS
      if (!existsSync(join(bin, exe("vhs"))) && !(await hasCommand("vhs"))) {
        const asset = vhsAsset();
        if (!asset) throw new Error(`VHS has no prebuilt binary for ${process.platform}/${process.arch} — install it on the worker.`);
        sink(`installing VHS ${VHS_VERSION}…`);
        const tmp = await mkdtemp(join(tmpdir(), "4pm-vhs-"));
        try {
          const archive = join(tmp, asset);
          await downloadTo(`https://github.com/charmbracelet/vhs/releases/download/v${VHS_VERSION}/${asset}`, archive);
          await run("tar", [asset.endsWith(".zip") ? "-xf" : "-xzf", archive, "-C", tmp], { timeout: 60_000 });
          const found = await findFile(tmp, exe("vhs"));
          if (!found) throw new Error("vhs not found in the release archive.");
          await placeBin(found, exe("vhs"));
        } finally {
          await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
        }
      }
      // ttyd
      if (!existsSync(join(bin, exe("ttyd"))) && !(await hasCommand("ttyd"))) {
        const asset = ttydAsset();
        if (!asset) throw new Error("ttyd has no prebuilt binary for this OS — install it on the worker (macOS: brew install ttyd).");
        sink(`installing ttyd ${TTYD_VERSION}…`);
        const tmp = await mkdtemp(join(tmpdir(), "4pm-ttyd-"));
        try {
          await downloadTo(`https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/${asset}`, join(tmp, asset));
          await placeBin(join(tmp, asset), exe("ttyd"));
        } finally {
          await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
        }
      }
      // ffmpeg (npm `ffmpeg-static` downloads the platform binary in its install script)
      if (!existsSync(join(bin, exe("ffmpeg"))) && !(await hasCommand("ffmpeg"))) {
        sink(`installing ffmpeg (ffmpeg-static ${FFMPEG_STATIC_VERSION})…`);
        const dir = marketingToolsDir();
        const code = await runStep("npm", ["i", "--no-audit", "--no-fund", "--prefix", dir, `ffmpeg-static@${FFMPEG_STATIC_VERSION}`], dir, {}, INSTALL_TIMEOUT_MS, () => undefined);
        const target = join(dir, "node_modules", "ffmpeg-static", exe("ffmpeg"));
        if (code !== 0 || !existsSync(target)) throw new Error(`installing ffmpeg-static failed (exit ${code}).`);
        await linkBin(target, exe("ffmpeg"));
      }
      // A Chromium for VHS (go-rod finds `chromium` on PATH; else it downloads its own).
      await ensurePlaywright(sink);
      const chromium = playwrightChromium();
      if (chromium) await linkBin(chromium, exe("chromium"));
      exposeToAgent(marketingToolsDir());
      return { PATH: [bin, process.env.PATH ?? ""].filter(Boolean).join(process.platform === "win32" ? ";" : ":") };
    } finally {
      terminalInstalling = null;
    }
  })();
  return terminalInstalling;
}

/** One feature-tool row: the self-installed copy, else one on PATH, else missing. */
async function probe(
  id: FeatureToolItem["id"],
  label: string,
  name: string,
  args: string[],
  missingSource: FeatureToolItem["source"] = "auto",
): Promise<FeatureToolItem> {
  const own = join(marketingBinDir(), exe(name));
  if (existsSync(own)) return { id, feature: "marketing", label, installed: true, version: await versionOf(own, args), source: "auto" };
  if (await hasCommand(name)) return { id, feature: "marketing", label, installed: true, version: await versionOf(name, args), source: "system" };
  return { id, feature: "marketing", label, installed: false, version: null, source: missingSource };
}

/** The marketing tools as Tools-tab feature tools. @adr 0641 */
export async function marketingFeatureTools(): Promise<FeatureToolItem[]> {
  const pw = installedVersion();
  const chromium = playwrightChromium();
  const build = chromium ? (/chromium-(\d+)/.exec(chromium)?.[1] ?? null) : null;
  const rows: FeatureToolItem[] = [
    { id: "playwright", feature: "marketing", label: "Playwright", installed: pw !== null, version: pw, source: "auto" },
    { id: "chromium", feature: "marketing", label: "Chromium (Playwright)", installed: chromium !== null, version: build ? `build ${build}` : null, source: "auto" },
    await probe("vhs", "VHS", "vhs", ["--version"]),
    await probe("ttyd", "ttyd", "ttyd", ["--version"], ttydAsset() ? "auto" : "detect"),
    await probe("ffmpeg", "ffmpeg", "ffmpeg", ["-version"]),
  ];
  if (process.platform === "linux") {
    const xvfb = await hasCommand("xvfb-run");
    rows.push({ id: "xvfb", feature: "marketing", label: "Xvfb", installed: xvfb, version: null, source: xvfb ? "system" : "detect" });
  }
  return rows;
}
