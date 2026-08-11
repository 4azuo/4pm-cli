/**
 * Worker tools (ADR-0206) — serves the machine-user Tools tab over WS (machine-0050..0053).
 * `detectWorkerTools` probes the default catalog (`--version`) + lists extra global npm packages;
 * `runWorkerToolOp` runs a **global** install/uninstall with `npm`/`pnpm`, streaming each output
 * line back via a callback so the server can relay it to the browser (SSE). The cli is the only
 * executor — the server never shells out. Package names are validated before spawning.
 */
import { spawn } from "node:child_process";
import {
  WORKER_TOOL_CATALOG,
  WORKER_TOOL_PREREQUISITE_IDS,
  type WorkerToolManager,
} from "@4pm/constants";
import type { ToolStatus, ToolsListReply } from "@4pm/ws";

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
async function listExtras(): Promise<ToolStatus[]> {
  const { out } = await run("npm", ["ls", "-g", "--depth=0", "--json"], undefined, 20_000);
  // `npm ls` exits non-zero on peer-dep warnings but still prints JSON — parse regardless.
  if (!out.trim()) return [];
  let deps: Record<string, { version?: string }> = {};
  try {
    deps = (JSON.parse(out) as { dependencies?: typeof deps }).dependencies ?? {};
  } catch {
    return [];
  }
  const catalogPkgs = new Set(
    WORKER_TOOL_CATALOG.map((t) => t.installPackage).filter((p): p is string => !!p),
  );
  return Object.entries(deps)
    .filter(([name]) => !catalogPkgs.has(name))
    .map(([name, info]) => ({
      id: name,
      label: name,
      category: "runtime" as const,
      installed: true,
      version: info.version ?? null,
      installable: true,
    }));
}

/** machine-0050 — probe the default catalog + list extra globals. */
export async function detectWorkerTools(): Promise<ToolsListReply> {
  const catalog = await Promise.all(
    WORKER_TOOL_CATALOG.map(async (t): Promise<ToolStatus> => {
      const version = await detectOne(t.id, t.versionArg);
      return {
        id: t.id,
        label: t.label,
        category: t.category,
        installed: version !== null,
        version,
        installable: t.installPackage !== null,
      };
    }),
  );
  const extras = await listExtras().catch(() => []);
  return { catalog, extras };
}

/** Resolve the npm package to (un)install for a name; validation errors return `{ error }`. */
function resolvePackage(name: string, op: "install" | "uninstall"): { pkg?: string; error?: string } {
  const entry = WORKER_TOOL_CATALOG.find((t) => t.id === name);
  if (entry) {
    if (entry.installPackage === null) {
      return { error: `"${name}" is a prerequisite and cannot be ${op}ed from here.` };
    }
    return { pkg: entry.installPackage };
  }
  if (WORKER_TOOL_PREREQUISITE_IDS.includes(name)) {
    return { error: `"${name}" is a prerequisite and cannot be ${op}ed from here.` };
  }
  if (!NPM_NAME.test(name)) return { error: `Invalid package name: "${name}".` };
  return { pkg: name };
}

/** The manager's global install/uninstall argv. */
function opArgs(op: "install" | "uninstall", manager: WorkerToolManager, pkg: string): string[] {
  if (manager === "pnpm") return [op === "install" ? "add" : "remove", "-g", pkg];
  return [op === "install" ? "install" : "uninstall", "-g", pkg];
}

/**
 * machine-0051/0052 — run a global install/uninstall, streaming each line to `onLine`.
 * Rejected names return `{ ok:false, error }` without spawning (the caller maps to a done frame).
 */
export async function runWorkerToolOp(
  op: "install" | "uninstall",
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
