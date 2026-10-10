/**
 * Remove git submodules from the project repo (the Git tab Configuration "Remove submodule"), and drop
 * the leftover folder of a submodule another worker removed. Never discards work: a submodule with
 * uncommitted changes or commits on no remote is refused (detach) or left in place (prune).
 * @adr 0441
 */
import { existsSync, readdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { execInProject } from "../agent/agent-spawn";

// Runs as the agent user when uid separation is on (ADR-0430).
const run = execInProject;

/** Progress callback (step id + English message). */
type Emit = (step: string, message: string) => void;

/** Run git in `cwd`, returning trimmed stdout ("" on failure). */
async function gitOut(cwd: string, args: string[]): Promise<string> {
  try {
    return (await run("git", args, { cwd, timeout: 60_000 })).stdout.trim();
  } catch {
    return "";
  }
}

/** First lines of a failed command's message, capped. */
function errText(err: unknown): string {
  const e = err as { stderr?: string; message?: string };
  const raw = (e?.stderr || e?.message || String(err)).trim();
  return raw.split("\n").filter(Boolean).slice(-3).join(" ").slice(0, 500);
}

/** The submodule paths `.gitmodules` declares, keyed by submodule name. */
async function declaredPaths(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!existsSync(join(root, ".gitmodules"))) return out;
  const lines = await gitOut(root, ["config", "-f", ".gitmodules", "--get-regexp", "^submodule\\..*\\.path$"]);
  for (const line of lines.split("\n").filter(Boolean)) {
    const sp = line.indexOf(" ");
    const key = line.slice(0, sp);
    out.set(key.replace(/^submodule\./, "").replace(/\.path$/, ""), line.slice(sp + 1));
  }
  return out;
}

/**
 * True when the submodule checkout at `dir` holds work that exists nowhere else: a dirty tree, or commits
 * reachable from HEAD that no remote-tracking ref contains. A folder that isn't a checkout has none.
 */
export async function hasLocalWork(dir: string): Promise<boolean> {
  if (!existsSync(join(dir, ".git"))) return false;
  if (await gitOut(dir, ["status", "--porcelain"])) return true;
  const unpushed = await gitOut(dir, ["rev-list", "--count", "HEAD", "--not", "--remotes"]);
  return Number(unpushed) > 0;
}

/**
 * Remove each submodule in `paths` from the repo at `root`: `deinit -f`, `git rm`, drop
 * `.git/modules/<name>`, then commit `.gitmodules` + the removed paths and push to the current branch.
 * Throws (before touching anything) when one has local work, and when the push fails — the local commit
 * is kept, so a retry only pushes. An already-removed path is skipped.
 */
export async function detachSubmodules(root: string, paths: string[], emit: Emit): Promise<void> {
  const declared = await declaredPaths(root);
  const byPath = new Map([...declared].map(([name, p]) => [p, name]));
  const targets = paths.filter((p) => byPath.has(p));
  for (const p of targets) {
    if (await hasLocalWork(join(root, p))) {
      throw new Error(`submodule ${p} has uncommitted changes or unpushed commits — commit and push or discard them first`);
    }
  }
  for (const p of targets) {
    emit("submodule", `Removing submodule ${p}…`);
    await run("git", ["submodule", "deinit", "-f", "--", p], { cwd: root, timeout: 60_000 });
    await run("git", ["rm", "-f", "--", p], { cwd: root, timeout: 60_000 });
    await rm(join(root, ".git", "modules", byPath.get(p) ?? p), { recursive: true, force: true });
    await rm(join(root, p), { recursive: true, force: true });
  }
  if (targets.length > 0) {
    const commitArgs = ["commit", "-m", `chore: remove git submodule${targets.length > 1 ? "s" : ""} ${targets.join(", ")} (4PM)`, "--", ".gitmodules", ...targets];
    try {
      await run("git", commitArgs, { cwd: root, timeout: 60_000 });
    } catch {
      // No user.name/user.email configured — retry with the 4PM fallback identity.
      await run("git", ["-c", "user.name=4PM", "-c", "user.email=noreply@4pm.app", ...commitArgs], { cwd: root, timeout: 60_000 });
    }
  }
  // Push even when nothing was left to remove: a previous attempt may have committed but failed to push.
  emit("submodule", "Pushing the submodule removal…");
  try {
    await run("git", ["push", "-u", "origin", "HEAD"], { cwd: root, timeout: 120_000 });
  } catch (err) {
    throw new Error(`submodule removal committed locally but the push failed: ${errText(err)}`, { cause: err });
  }
}

/** Every submodule git dir under `.git/modules` (a folder holding `HEAD`), as its submodule name. */
function moduleNames(root: string): string[] {
  const base = join(root, ".git", "modules");
  const names: string[] = [];
  const walk = (rel: string, depth: number): void => {
    const abs = rel ? join(base, rel) : base;
    if (rel && existsSync(join(abs, "HEAD"))) {
      names.push(rel);
      return;
    }
    if (depth > 4 || !existsSync(abs)) return;
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      if (e.isDirectory()) walk(rel ? `${rel}/${e.name}` : e.name, depth + 1);
    }
  };
  walk("", 0);
  return names;
}

/**
 * After a sync, drop what is left of submodules the repo no longer declares (another worker removed them):
 * the checkout folder and its `.git/modules` dir — only when it holds no local work; otherwise it stays and
 * a warning is emitted. Best-effort, never throws.
 */
export async function pruneStaleSubmodules(root: string, emit: Emit): Promise<void> {
  try {
    const declared = await declaredPaths(root);
    for (const name of moduleNames(root)) {
      if (declared.has(name)) continue;
      const dir = join(root, name);
      if (await hasLocalWork(dir)) {
        emit("submodule", `Submodule ${name} was removed from the project but holds local work here — left in place.`);
        continue;
      }
      emit("submodule", `Removing the leftover of submodule ${name}…`);
      await rm(dir, { recursive: true, force: true });
      await rm(join(root, ".git", "modules", name), { recursive: true, force: true });
    }
  } catch (err) {
    emit("submodule", `Could not clean removed submodules: ${errText(err)}`);
  }
}
