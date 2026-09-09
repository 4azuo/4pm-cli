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
import type { ToolRestoreFailureItem, ToolStatus, ToolsAutoUpdateReply, ToolsListReply } from "@4pm/ws";
import { readProfileConfig, writeProfileConfig } from "../config/profile";

/** The streamed worker-tool ops: install/uninstall (ADR-0206) + update-to-latest (ADR-0252). */
export type ToolOp = "install" | "uninstall" | "update";

/** npm package name shape (scoped or plain, lowercase) — guards what we hand to the manager. */
const NPM_NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

/** Default per-attempt timeout (ms) for an install/update/restore op (ADR-0258); config overrides it. */
const TOOL_INSTALL_TIMEOUT_DEFAULT_MS = 300_000;
/** Max install attempts on a retryable failure (ADR-0258): the first try + 2 retries. */
const TOOL_INSTALL_MAX_ATTEMPTS = 3;
/** Base backoff (ms) between retries — grows ~×3 per attempt (5s → 15s → 45s) with jitter. */
const TOOL_RETRY_BASE_MS = 5_000;

/** Resolve the install/update/restore timeout (ms): the config value (seconds) over the default. */
export function resolveInstallTimeoutMs(sec?: number): number {
  return sec && sec > 0 ? sec * 1000 : TOOL_INSTALL_TIMEOUT_DEFAULT_MS;
}

/** Sleep `ms`, unref'd so a pending retry never keeps the process alive on shutdown. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

/**
 * Classify an install failure (ADR-0258) — a **retryable** transient cause (our 180s→300s timeout kill
 * exit 124, or a network/registry signature in the output) is worth a backoff retry; a **permanent** one
 * (missing package, no matching version, engine refusal) fails fast so it never burns the retry window.
 */
export function classifyToolFailure(
  code: number,
  out: string,
): { reason: ToolRestoreFailureItem["reason"]; retryable: boolean } {
  if (code === 124) return { reason: "timeout", retryable: true };
  const t = out.toLowerCase();
  // Permanent: the package or version does not exist / the name is bad — retrying cannot fix it.
  if (/e404|not found|no such package|is not in this registry|404 not found/.test(t)) {
    return { reason: "not-found", retryable: false };
  }
  if (/etarget|no matching version|notarget/.test(t)) return { reason: "not-found", retryable: false };
  // Permanent: npm/pnpm refused on the Node engine (a hard error, not the EBADENGINE warning).
  if (/unsupported_engine|npm error engine|err_pnpm_unsupported_engine/.test(t)) {
    return { reason: "engine", retryable: false };
  }
  // Retryable: transient network / registry failures.
  if (
    /econnreset|etimedout|eai_again|enotfound|econnrefused|socket hang up|err_socket|network|network_request_failed|registry.*(50\d|timeout)|request to https?:\/\/.*failed/.test(
      t,
    )
  ) {
    return { reason: "network", retryable: true };
  }
  // Anything else (EACCES, disk, an unrecognized npm error) is treated as permanent — fail fast.
  return { reason: "other", retryable: false };
}

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
  timeoutMs: number = TOOL_INSTALL_TIMEOUT_DEFAULT_MS,
): Promise<{ ok: boolean; exitCode: number; error?: string }> {
  const resolved = resolvePackage(name, op);
  if (resolved.error || !resolved.pkg) {
    return { ok: false, exitCode: 1, error: resolved.error ?? "Invalid package." };
  }
  onLine(`$ ${manager} ${opArgs(op, manager, resolved.pkg).join(" ")}`);
  const { code } = await run(manager, opArgs(op, manager, resolved.pkg), onLine, timeoutMs);
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
  timeoutMs: number = TOOL_INSTALL_TIMEOUT_DEFAULT_MS,
): Promise<void> {
  for (const name of tools) {
    const res = await runWorkerToolOp("update", name, "npm", onLine, timeoutMs).catch(
      (err: unknown) => ({ ok: false, exitCode: 1, error: String(err) }),
    );
    onLine(res.ok ? `✓ ${name} updated` : `✗ ${name}: ${res.error ?? "failed"}`);
  }
}

/**
 * Install a package at an EXACT version (`npm i -g name@version`) — the restore/copy op (ADR-0254),
 * now with **retry + backoff** on a transient failure (ADR-0258). Retries up to
 * `TOOL_INSTALL_MAX_ATTEMPTS` on a retryable cause (timeout/network) with exponential backoff + jitter,
 * and **fails fast** on a permanent one (missing package / no version / engine). Returns the classified
 * failure so `reconcileTools` can report it.
 */
async function installPinned(
  name: string,
  version: string,
  manager: WorkerToolManager,
  onLine: (line: string) => void,
  timeoutMs: number = TOOL_INSTALL_TIMEOUT_DEFAULT_MS,
): Promise<{ ok: boolean; error?: string; reason?: ToolRestoreFailureItem["reason"]; retryable?: boolean }> {
  const resolved = resolvePackage(name, "update");
  if (resolved.error || !resolved.pkg) {
    return { ok: false, error: resolved.error ?? "Invalid package.", reason: "other", retryable: false };
  }
  const target = `${resolved.pkg}@${version}`;
  const args = manager === "pnpm" ? ["add", "-g", target] : ["install", "-g", target];
  for (let attempt = 1; attempt <= TOOL_INSTALL_MAX_ATTEMPTS; attempt++) {
    const suffix = attempt > 1 ? ` (attempt ${attempt}/${TOOL_INSTALL_MAX_ATTEMPTS})` : "";
    onLine(`$ ${manager} ${args.join(" ")}${suffix}`);
    const { code, out } = await run(manager, args, onLine, timeoutMs);
    if (code === 0) return { ok: true };
    const { reason, retryable } = classifyToolFailure(code, out);
    // Fail fast on a permanent cause, or once the attempts are spent.
    if (!retryable || attempt === TOOL_INSTALL_MAX_ATTEMPTS) {
      return { ok: false, error: `${manager} exited ${code}`, reason, retryable };
    }
    // Exponential backoff (5s → 15s → 45s) with ±20% jitter so retries don't thundering-herd.
    const base = TOOL_RETRY_BASE_MS * 3 ** (attempt - 1);
    const wait = Math.round(base * (0.8 + Math.random() * 0.4));
    onLine(`retrying in ${Math.round(wait / 1000)}s (${reason})…`);
    await sleep(wait);
  }
  // Unreachable (the loop always returns), but satisfies the type checker.
  return { ok: false, error: `${manager} failed`, reason: "other", retryable: false };
}

/**
 * Reconcile the worker's installed tools to a manifest of exact versions (ADR-0254) — the
 * restore-on-boot / copy-apply op. Detects the current set once, then installs each manifest entry
 * whose version is missing or differs (`npm i -g name@version`, with retry/backoff — ADR-0258).
 * Best-effort: a per-tool failure is logged, never fatal, so one bad entry never blocks the rest.
 * Prerequisites are skipped by `resolvePackage`. Returns the tools that stayed missing/mismatched
 * (classified `restoreFailed` — ADR-0258); an empty array means the reconcile fully satisfied the manifest.
 */
export async function reconcileTools(
  manifest: { name: string; version: string; manager: WorkerToolManager }[],
  onLine: (line: string) => void,
  timeoutMs: number = TOOL_INSTALL_TIMEOUT_DEFAULT_MS,
): Promise<ToolRestoreFailureItem[]> {
  const failed: ToolRestoreFailureItem[] = [];
  if (manifest.length === 0) return failed;
  const { catalog, extras } = await detectWorkerTools();
  const versionByName = new Map(
    [...catalog, ...extras]
      .filter((r) => r.installed && r.version)
      .map((r) => [r.id, r.version as string]),
  );
  for (const entry of manifest) {
    const current = versionByName.get(entry.name);
    if (current && current.includes(entry.version)) continue; // already at the recorded version
    onLine(`Restoring ${entry.name}@${entry.version}…`);
    const res = await installPinned(entry.name, entry.version, entry.manager, onLine, timeoutMs).catch(
      (err: unknown): Awaited<ReturnType<typeof installPinned>> => ({
        ok: false,
        error: String(err),
        reason: "other",
        retryable: false,
      }),
    );
    if (res.ok) {
      onLine(`✓ ${entry.name}@${entry.version}`);
    } else {
      onLine(`✗ ${entry.name}: ${res.error ?? "failed"}`);
      failed.push({
        name: entry.name,
        version: entry.version,
        reason: res.reason ?? "other",
        retryable: res.retryable ?? false,
      });
    }
  }
  return failed;
}
