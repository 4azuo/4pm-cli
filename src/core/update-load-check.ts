/**
 * Load check of a downloaded release before it replaces the install: extract it into a temp dir that uses
 * the running install's `node_modules` (the update keeps those), then start its entry with
 * `FOURPM_LOAD_CHECK=1` — it exits 0 once its imports loaded. A release that cannot load (e.g. a dependency
 * left out of the bundle) fails here instead of after the re-exec, where it would leave the worker offline.
 * @adr 0644
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extract } from "tar";

/** Bound for starting the staged entry. */
const LOAD_CHECK_TIMEOUT_MS = 30_000;
/** Cap of the reported reason. */
const MAX_REASON_CHARS = 300;

/** A release that downloaded and verified but does not load — the version is marked bad. */
export class ReleaseLoadError extends Error {
  constructor(readonly reason: string) {
    super(`The new version failed to load: ${reason}`);
    this.name = "ReleaseLoadError";
  }
}

/** The most telling line of the child's output: the first error line, else the last non-empty one. */
export function loadFailureReason(output: string, fallback: string): string {
  const lines = output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const line = lines.find((l) => /error/i.test(l)) ?? lines.at(-1) ?? fallback;
  return line.length > MAX_REASON_CHARS ? `${line.slice(0, MAX_REASON_CHARS)}…` : line;
}

/** Run `node <entry> --version` with the load-check flag; resolves with the exit and the captured output. */
function runEntry(entry: string, cwd: string): Promise<{ code: number | null; signal: string | null; output: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [entry, "--version"], {
      cwd,
      env: { ...process.env, FOURPM_LOAD_CHECK: "1", FOURPM_NO_UPDATE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const collect = (chunk: Buffer): void => {
      if (output.length < 64_000) output += chunk.toString("utf8");
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, LOAD_CHECK_TIMEOUT_MS);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: null, signal: null, output: `${output}\n${String(err)}`, timedOut });
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, output, timedOut });
    });
  });
}

/**
 * Extract `tarball` into a temp dir next to the running install's `node_modules` and start it. Throws
 * `ReleaseLoadError` when it does not load; any other error (extract, temp dir) is a plain failure.
 */
export async function checkReleaseLoads(tarball: string, runningRoot: string): Promise<void> {
  const staging = mkdtempSync(join(tmpdir(), "4pm-update-check-"));
  try {
    await extract({ file: tarball, cwd: staging, strip: 1 });
    const modules = join(runningRoot, "node_modules");
    // `junction` lets Windows link a dir without privileges; Unix ignores the type.
    if (existsSync(modules) && !existsSync(join(staging, "node_modules"))) {
      symlinkSync(modules, join(staging, "node_modules"), "junction");
    }
    const entry = join(staging, "dist", "index.js");
    if (!existsSync(entry)) throw new ReleaseLoadError("the release has no dist/index.js");
    const { code, signal, output, timedOut } = await runEntry(entry, staging);
    if (code === 0) return;
    const fallback = timedOut
      ? `it did not finish loading within ${LOAD_CHECK_TIMEOUT_MS / 1000}s`
      : `it exited with ${signal ?? `code ${code}`}`;
    throw new ReleaseLoadError(timedOut ? fallback : loadFailureReason(output, fallback));
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
