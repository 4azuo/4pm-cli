/**
 * Worker tools (ADR-0206) — serves the machine-user Tools tab over WS (machine-0050..0053).
 * `detectWorkerTools` probes the default catalog (`--version`) + lists extra global npm packages;
 * `runWorkerToolOp` runs a **global** install/uninstall with `npm`/`pnpm`, streaming each output
 * line back via a callback so the server can relay it to the browser (SSE). The cli is the only
 * executor — the server never shells out. Package names are validated before spawning.
 */
import { spawn } from "node:child_process";
import {
  WORKER_TOOL_BUNDLED_GLOBALS,
  WORKER_TOOL_CATALOG,
  WORKER_TOOL_PREREQUISITE_IDS,
  type WorkerToolManager,
} from "@4pm/constants";
import type { ToolStatus, ToolsAutoUpdateReply, ToolsListReply } from "@4pm/ws";
import { readProfileConfig, writeProfileConfig } from "../config/profile";

/** The streamed worker-tool ops: install/uninstall (ADR-0206) + update-to-latest (ADR-0252). */
export type ToolOp = "install" | "uninstall" | "update";

/** npm package name shape (scoped or plain, lowercase) — guards what we hand to the manager. */
const NPM_NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

/** Run a command, capture stdout, and resolve `{ code, out }`; never rejects (bounded by timeout). */
function run(
  cmd: string,
  args: string[],
  onLine?: (line: string) => void,
  timeoutMs = 180_000,
): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    let out = "";
    let buf = "";
    let child: ReturnType<typeof spawn> | null = null;
    const done = (code: number): void => {
      clearTimeout(timer);
      if (onLine && buf.trim()) onLine(buf.trim());
      resolve({ code, out });
    };
    const timer = setTimeout(() => {
      child?.kill();
      if (onLine) onLine(`timed out after ${Math.round(timeoutMs / 1000)}s`);
      done(124);
    }, timeoutMs);
    timer.unref?.();
    // Stream stdout+stderr line-by-line to the caller so install progress is visible live.
    const feed = (d: Buffer): void => {
      const text = d.toString("utf8");
      out += text;
      if (!onLine) return;
      buf += text;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        onLine(line);
      }
    };
    try {
      child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
      child.stdout?.on("data", feed);
      child.stderr?.on("data", feed);
      child.on("exit", (code) => done(code ?? 0));
      child.on("error", () => done(127));
    } catch {
      done(127);
    }
  });
}

/** Probe one tool's `--version`; returns the first output line, or null when not installed. */
async function detectOne(cmd: string, versionArg: string): Promise<string | null> {
  const { code, out } = await run(cmd, [versionArg], undefined, 15_000);
  if (code !== 0) return null;
  const first = out.split("\n").map((l) => l.trim()).find(Boolean);
  return first ?? "";
}

/** List extra globally installed npm packages (not in the catalog) via `npm ls -g`. */
async function listExtras(autoUpdateSet: Set<string> = new Set()): Promise<ToolStatus[]> {
  const { out } = await run("npm", ["ls", "-g", "--depth=0", "--json"], undefined, 20_000);
  // `npm ls` exits non-zero on peer-dep warnings but still prints JSON — parse regardless.
  if (!out.trim()) return [];
  let deps: Record<string, { version?: string }> = {};
  try {
    deps = (JSON.parse(out) as { dependencies?: typeof deps }).dependencies ?? {};
  } catch {
    return [];
  }
  // Exclude both a tool's install package AND its id/probe name: an npm-managed prerequisite
  // (e.g. `npm` itself, installPackage null) is still a global package here and must not
  // reappear as an "extra" — dedupe against the catalog by both keys. Node-bundled globals
  // (npm/corepack) are runtime plumbing, not operator tools, so they are excluded too.
  const catalogPkgs = new Set<string>(WORKER_TOOL_BUNDLED_GLOBALS);
  for (const t of WORKER_TOOL_CATALOG) {
    catalogPkgs.add(t.id);
    if (t.installPackage) catalogPkgs.add(t.installPackage);
  }
  return Object.entries(deps)
    .filter(([name]) => !catalogPkgs.has(name))
    .map(([name, info]) => ({
      id: name,
      label: name,
      category: "runtime" as const,
      installed: true,
      version: info.version ?? null,
      installable: true,
      updatable: true,
      autoUpdate: autoUpdateSet.has(name),
    }));
}

/**
 * machine-0050 — probe the default catalog + list extra globals. `autoUpdateTools` (the worker's
 * `config.json` flags, ADR-0253) marks each row's `autoUpdate` so the panel toggle reflects state.
 */
export async function detectWorkerTools(autoUpdateTools: string[] = []): Promise<ToolsListReply> {
  const autoUpdateSet = new Set(autoUpdateTools);
  const catalog = await Promise.all(
    WORKER_TOOL_CATALOG.map(async (t): Promise<ToolStatus> => {
      const version = await detectOne(t.id, t.versionArg);
      return {
        id: t.id,
        label: t.label,
        category: t.category,
        installed: version !== null,
        version,
        installable: t.installable,
        updatable: t.updatable,
        autoUpdate: autoUpdateSet.has(t.id),
      };
    }),
  );
  const extras = await listExtras(autoUpdateSet).catch(() => []);
  return { catalog, extras };
}

/** English past tense for an op, used in the rejection message ("cannot be <past> from here"). */
function opPast(op: ToolOp): string {
  return op === "install" ? "installed" : op === "uninstall" ? "uninstalled" : "updated";
}

/** Resolve the npm package to install/uninstall/update for a name; validation errors return `{ error }`. */
function resolvePackage(name: string, op: ToolOp): { pkg?: string; error?: string } {
  const entry = WORKER_TOOL_CATALOG.find((t) => t.id === name);
  if (entry) {
    // A default-catalog tool is detect-only for install/uninstall (ADR-0227) but the npm-distributed
    // ones (pnpm/claude/codex) are update-to-latest-open (ADR-0252). `installPackage` stays the
    // package identity used to resolve the target for either allowed op.
    const allowed = op === "update" ? entry.updatable : entry.installable;
    if (!allowed) {
      return { error: `"${name}" is a prerequisite and cannot be ${opPast(op)} from here.` };
    }
    return { pkg: entry.installPackage ?? name };
  }
  if (WORKER_TOOL_PREREQUISITE_IDS.includes(name)) {
    return { error: `"${name}" is a prerequisite and cannot be ${opPast(op)} from here.` };
  }
  if (WORKER_TOOL_BUNDLED_GLOBALS.includes(name)) {
    return { error: `"${name}" ships with Node and cannot be ${opPast(op)} from here.` };
  }
  if (!NPM_NAME.test(name)) return { error: `Invalid package name: "${name}".` };
  return { pkg: name };
}

/** The manager's global install/uninstall/update argv (update pins `@latest` to bump to newest). */
function opArgs(op: ToolOp, manager: WorkerToolManager, pkg: string): string[] {
  if (op === "uninstall") return manager === "pnpm" ? ["remove", "-g", pkg] : ["uninstall", "-g", pkg];
  const target = op === "update" ? `${pkg}@latest` : pkg;
  return manager === "pnpm" ? ["add", "-g", target] : ["install", "-g", target];
}

/**
 * machine-0051/0052/0055 — run a global install/uninstall/update, streaming each line to `onLine`.
 * Rejected names return `{ ok:false, error }` without spawning (the caller maps to a done frame).
 */
export async function runWorkerToolOp(
  op: ToolOp,
  name: string,
  manager: WorkerToolManager,
  onLine: (line: string) => void,
): Promise<{ ok: boolean; exitCode: number; error?: string }> {
  const resolved = resolvePackage(name, op);
  if (resolved.error || !resolved.pkg) {
    return { ok: false, exitCode: 1, error: resolved.error ?? "Invalid package." };
  }
  onLine(`$ ${manager} ${opArgs(op, manager, resolved.pkg).join(" ")}`);
  const { code } = await run(manager, opArgs(op, manager, resolved.pkg), onLine);
  return { ok: code === 0, exitCode: code, error: code === 0 ? undefined : `${manager} exited ${code}` };
}

/**
 * machine-0056 (ADR-0253) — toggle a tool's per-tool auto-update flag in the worker `config.json`
 * (`autoUpdateTools`). Validates the name the same way as an update op (a detect-only prerequisite /
 * invalid package is rejected without persisting), then merges/removes it and writes the config.
 */
export function setToolAutoUpdate(profileDir: string, name: string, enabled: boolean): ToolsAutoUpdateReply {
  const resolved = resolvePackage(name, "update");
  if (resolved.error) return { ok: false, error: resolved.error };
  const current = readProfileConfig(profileDir).autoUpdateTools ?? [];
  const set = new Set(current);
  if (enabled) set.add(name);
  else set.delete(name);
  writeProfileConfig(profileDir, { autoUpdateTools: [...set] });
  return { ok: true };
}

/**
 * Update every flagged tool to `@latest` (ADR-0253) — run by the daily maintenance tick when the
 * worker is idle (ADR-0074). Uses `npm` (the panel's default manager); a rejected/invalid name is
 * skipped, not fatal, so one bad flag never blocks the rest. Best-effort; `onLine` receives progress.
 */
export async function autoUpdateFlaggedTools(
  tools: string[],
  onLine: (line: string) => void,
): Promise<void> {
  for (const name of tools) {
    const res = await runWorkerToolOp("update", name, "npm", onLine).catch(
      (err: unknown) => ({ ok: false, exitCode: 1, error: String(err) }),
    );
    onLine(res.ok ? `✓ ${name} updated` : `✗ ${name}: ${res.error ?? "failed"}`);
  }
}
