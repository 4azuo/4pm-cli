/**
 * Autonomous runs across submodules: the root-push guard (no root branch names a submodule commit its remote lacks),
 * the files a run changed inside submodules, and the follow-up of a root PR that waits for submodule PRs — each
 * pointer moves to the commit the submodule merge produced, the draft turns ready, and a root PR that only moves
 * pointers is merged (or set to auto-merge) by the cli.
 * @adr 0579
 */
import { join } from "node:path";
import { POINTERS_SIDECAR_REL, parsePointers, type DeliveryState, type PointerEntry, type PointersSidecar } from "@4pm/dto";
import { markPrReady, mergePullRequest, prMergeCommitOf } from "../git/git-host";
import * as B from "./autonomous-books";
import { git, gitQuiet, pushBranch, type RepoBase } from "./autonomous-git";

const IDENT = ["-c", "user.name=4PM", "-c", "user.email=noreply@4pm.app"];

/** A submodule with the run's branch in it. */
export interface SubBranch {
  sub: RepoBase;
  branch: string;
}

// ── Sidecar ──────────────────────────────────────────────────────────────────────────────────────

/** Read the pointers sidecar of a books checkout (`{}` when absent). */
export async function readPointers(bdir: string): Promise<PointersSidecar> {
  return parsePointers(await B.readBook(bdir, POINTERS_SIDECAR_REL));
}

/** Write the pointers sidecar (sorted, pretty); an empty sidecar is written as `{}`. */
export async function writePointers(bdir: string, p: PointersSidecar): Promise<void> {
  const sorted = Object.fromEntries(Object.entries(p).sort(([a], [b]) => a.localeCompare(b)));
  await B.writeBook(bdir, POINTERS_SIDECAR_REL, `${JSON.stringify(sorted, null, 2)}\n`);
}

/** Record a root PR that waits for submodule PRs (inside a books publish). */
export async function recordPointerEntry(bdir: string, rootBranch: string, entry: PointerEntry): Promise<void> {
  const p = await readPointers(bdir);
  p[rootBranch] = entry;
  await writePointers(bdir, p);
}

// ── Guard ────────────────────────────────────────────────────────────────────────────────────────

/** The submodule links of `ref` that differ from `origin/<base>`: folder + the commit named (deletions left out). */
async function changedGitlinks(root: string, base: string, ref: string): Promise<{ dir: string; sha: string }[]> {
  const raw = (await gitQuiet(root, ["diff", "--raw", "--no-abbrev", "--no-renames", `origin/${base}`, ref])).split("\n");
  const out: { dir: string; sha: string }[] = [];
  for (const line of raw) {
    // `:<old mode> <new mode> <old sha> <new sha> <status>\t<path>`
    const m = /^:\d{6} (160000) [0-9a-f]+ ([0-9a-f]{40}) \w+\t(.+)$/.exec(line);
    if (m && !/^0+$/.test(m[2]!)) out.push({ dir: m[3]!, sha: m[2]! });
  }
  return out;
}

/** Is `sha` reachable from a remote branch of the submodule at `cwd` (after a fetch)? */
async function onRemote(cwd: string, sha: string): Promise<boolean> {
  await gitQuiet(cwd, ["fetch", "-q", "origin"], 180_000);
  return (await gitQuiet(cwd, ["branch", "-r", "--contains", sha])).trim().length > 0;
}

/**
 * Before a root push: every submodule link of `ref` that differs from `origin/<base>` must name a commit on that
 * submodule's remote. When it is not there yet but sits on the run's branch in that submodule, that branch is pushed;
 * otherwise this throws (`submodule commit … is not on its remote`) and nothing is pushed.
 */
export async function ensureSubmoduleCommitsPushed(root: string, base: string, ref: string, subs: readonly SubBranch[]): Promise<void> {
  for (const link of await changedGitlinks(root, base, ref)) {
    const cwd = join(root, link.dir);
    if (await onRemote(cwd, link.sha)) continue;
    const s = subs.find((x) => x.sub.dir === link.dir);
    const onBranch = s ? await git(cwd, ["merge-base", "--is-ancestor", link.sha, s.branch]).then(() => true, () => false) : false;
    if (s && onBranch) {
      await pushBranch(cwd, s.branch);
      continue;
    }
    throw new Error(`submodule commit ${link.sha.slice(0, 10)} in ${link.dir} is not on its remote`);
  }
}

/** Push a root branch after the submodule guard. */
export async function pushRootBranch(root: string, base: string, branch: string, subs: readonly SubBranch[]): Promise<void> {
  await ensureSubmoduleCommitsPushed(root, base, branch, subs);
  await pushBranch(root, branch);
}

// ── Files ────────────────────────────────────────────────────────────────────────────────────────

/** The files the run's branch changed in each submodule against its base, as root-relative paths. */
export async function submoduleFiles(root: string, subs: readonly SubBranch[]): Promise<string[]> {
  const out: string[] = [];
  for (const s of subs) {
    const cwd = join(root, s.sub.dir);
    const files = (await gitQuiet(cwd, ["diff", "--name-only", `origin/${s.sub.base}...${s.branch}`])).split("\n").filter(Boolean);
    out.push(...files.map((f) => `${s.sub.dir}/${f}`));
  }
  return out;
}

/** The root branch's changed files with each submodule link replaced by the files changed inside it. */
export function withoutGitlinks(rootFiles: readonly string[], subFiles: readonly string[], subs: readonly SubBranch[]): string[] {
  const dirs = new Set(subs.map((s) => s.sub.dir));
  return [...rootFiles.filter((f) => !dirs.has(f)), ...subFiles];
}

// ── Pointer follow-up ────────────────────────────────────────────────────────────────────────────

/**
 * Move submodule links on a pushed root branch without touching the working tree: a temporary detached worktree of
 * `origin/<branch>`, `update-index` per link, one commit, push (never forced; a moved branch is retried once).
 */
export async function movePointers(root: string, branch: string, id: string, moves: readonly { dir: string; sha: string }[]): Promise<boolean> {
  if (!moves.length) return true;
  for (let attempt = 0; attempt < 2; attempt++) {
    await git(root, ["fetch", "-q", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
    const dir = join(root, ".git", `4pm-pointers-${process.pid}-${Date.now()}`);
    await git(root, ["worktree", "add", "-q", "--detach", dir, `origin/${branch}`]);
    try {
      for (const m of moves) await git(dir, ["update-index", "--cacheinfo", `160000,${m.sha},${m.dir}`]);
      if (!(await gitQuiet(dir, ["diff", "--cached", "--name-only"])).trim()) return true;
      const what = moves.map((m) => `${m.dir} at ${m.sha.slice(0, 10)}`).join(", ");
      await git(dir, [...IDENT, "commit", "-q", "-m", `chore(${id}): point ${what} (4PM)`]);
      try {
        await git(dir, ["push", "-q", "origin", `HEAD:refs/heads/${branch}`], 180_000);
        return true;
      } catch (err) {
        if (attempt === 0 && /non-fast-forward|fetch first/i.test(err instanceof Error ? err.message : String(err))) continue;
        return false;
      }
    } finally {
      await gitQuiet(root, ["worktree", "remove", "--force", dir]);
      await gitQuiet(root, ["worktree", "prune"]);
    }
  }
  return false;
}

/** Does the root PR change nothing but submodule links (`origin/<base>...origin/<branch>`)? */
export async function pointerOnly(root: string, base: string, branch: string): Promise<boolean> {
  await gitQuiet(root, ["fetch", "-q", "origin", base, branch]);
  const raw = (await gitQuiet(root, ["diff", "--raw", "--no-abbrev", "--no-renames", `origin/${base}...origin/${branch}`])).split("\n").filter(Boolean);
  return raw.length > 0 && raw.every((l) => /^:\d{6} 160000 /.test(l) || /^:160000 \d{6} /.test(l));
}

/** An alert the follow-up raises. */
export type PointerAlert = (kind: "submodule-pr-closed" | "pointer-pr-needs-merge", task: string, message: string) => void;

/** The PR state lookup by head branch (host CLI, else git) — `prState` of the PR states module. */
export type PrStateLookup = (url: string, branch: string, cwd?: string, base?: string) => Promise<DeliveryState | null>;

/** What the follow-up decided: the entries to write back (`null` = drop) and tick-log lines. */
export interface PointerAdvance {
  updates: Map<string, PointerEntry | null>;
  notes: string[];
}

/**
 * Advance every root PR that waits for submodule PRs: look up each open submodule PR; a merged one gets its merge
 * commit and the root branch is moved to it; once every submodule PR is merged and pointed the draft turns ready, and
 * a ready root PR that only moves pointers is merged (or set to auto-merge; else alerted once). An entry whose root PR
 * is merged / closed (or whose branch is gone) is dropped. Side effects run here, outside the books publish; `apply`
 * writes the result.
 */
export async function advancePointers(root: string, rootBase: RepoBase, sidecar: PointersSidecar, prState: PrStateLookup, notify: PointerAlert): Promise<PointerAdvance> {
  const out: PointerAdvance = { updates: new Map(), notes: [] };
  let budget = 20;
  for (const [branch, entry0] of Object.entries(sidecar)) {
    if (budget-- <= 0) break;
    const entry: PointerEntry = { ...entry0, subs: entry0.subs.map((s) => ({ ...s })), alerted: [...(entry0.alerted ?? [])] };
    const rootState = await prState(rootBase.url, branch, root, entry.base);
    if (rootState === "merged" || rootState === "closed") {
      out.updates.set(branch, null);
      out.notes.push(`[pointers] ${entry.id}: root PR ${rootState} — done`);
      continue;
    }
    let changed = false;
    for (const s of entry.subs) {
      if (s.state !== "open") continue;
      const cwd = join(root, s.dir);
      const st = await prState(s.url, s.branch, cwd, s.base);
      if (st === "merged") {
        let sha = await prMergeCommitOf(s.url, s.branch);
        if (!sha) {
          await gitQuiet(cwd, ["fetch", "-q", "origin", s.base]);
          sha = (await gitQuiet(cwd, ["rev-parse", `origin/${s.base}`])).trim() || null;
        }
        if (!sha) continue;
        s.state = "merged";
        s.sha = sha;
        changed = true;
        out.notes.push(`[pointers] ${entry.id}: ${s.dir} PR merged → ${sha.slice(0, 10)}`);
      } else if (st === "closed") {
        s.state = "closed";
        changed = true;
        const key = `submodule-pr-closed:${s.dir}`;
        if (!entry.alerted!.includes(key)) {
          entry.alerted!.push(key);
          notify("submodule-pr-closed", entry.id, `The ${s.dir} PR of ${entry.id} was closed without merge — the root PR stays a draft.`);
        }
      }
    }
    const toPoint = entry.subs.filter((s) => s.state === "merged" && s.sha && !s.pointed);
    if (toPoint.length) {
      const ok = await movePointers(root, branch, entry.id, toPoint.map((s) => ({ dir: s.dir, sha: s.sha! }))).catch(() => false);
      if (ok) {
        for (const s of toPoint) s.pointed = true;
        changed = true;
        out.notes.push(`[pointers] ${entry.id}: root branch now points ${toPoint.map((s) => s.dir).join(", ")} at the merge`);
      } else out.notes.push(`[warn] ${entry.id}: could not move the submodule pointers on ${branch}`);
    }
    const allIn = entry.subs.every((s) => s.state === "merged" && s.pointed);
    if (allIn && !entry.ready && entry.url) {
      if (await markPrReady(rootBase.url, entry.url)) {
        entry.ready = true;
        changed = true;
        out.notes.push(`[pointers] ${entry.id}: root PR ready for review`);
      }
    }
    if (allIn && entry.ready && entry.url && !entry.merge && (await pointerOnly(root, entry.base, branch))) {
      const res = await mergePullRequest(rootBase.url, entry.url);
      if ("result" in res) {
        entry.merge = res.result;
        changed = true;
        out.notes.push(`[pointers] ${entry.id}: pointer-only root PR ${res.result === "merged" ? "merged" : "set to auto-merge"}`);
      } else if (!entry.alerted!.includes("pointer-pr-needs-merge")) {
        entry.alerted!.push("pointer-pr-needs-merge");
        changed = true;
        notify("pointer-pr-needs-merge", entry.id, `The root PR of ${entry.id} only moves submodule pointers but could not be merged by the worker (${res.error.slice(0, 200)}) — merge it by hand.`);
      }
    }
    if (changed) out.updates.set(branch, entry);
  }
  return out;
}

/** Write a follow-up's result into the books checkout `bdir` (inside a books publish). True when anything changed. */
export async function applyPointerAdvance(bdir: string, adv: PointerAdvance): Promise<boolean> {
  if (!adv.updates.size) return false;
  const p = await readPointers(bdir);
  for (const [branch, e] of adv.updates) {
    if (e === null) delete p[branch];
    else if (p[branch]) p[branch] = e;
  }
  await writePointers(bdir, p);
  return true;
}
