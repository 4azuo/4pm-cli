/**
 * Branch cleanup on the worker: list a repo's dead branches (merged into the base, PR merged / closed, the 4PM
 * task gone, no commit for 30 days), delete chosen ones on the remote and locally (never the base, the books
 * branch, a branch with an open PR, a live task's WIP or the checked-out branch — re-checked right before each
 * push), keep a deletion log on the books branch (`.4pm/.autonomous.branch-deletions.json`, never pruned — it
 * costs 4PM nothing) and restore a logged branch while its commit still exists. With the project's
 * `branchCleanup` on, the first cycle of the day (any worker — the books push is the lock) deletes the dead 4PM
 * task branches older than `afterDays`.
 * @adr 0540
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { BRANCH_DELETIONS_REL, BRANCH_STALE_DAYS } from "@4pm/dto";
import type { BranchCandidatePayload, BranchDeleteResultPayload, BranchDeletionPayload, GitBranchCleanupReply, GitBranchCleanupRequest } from "@4pm/ws";
import { repoHost } from "../git/git-host";
import * as B from "./autonomous-books";
import { currentBranch, git, gitQuiet, mutateBooks, readBooksFile, resolveBases, type RepoBase } from "./autonomous-git";

const run = promisify(execFile);

/** The deletion log file on the books branch. */
interface DeletionLog {
  /** The UTC day of the last automatic cleanup (the daily lock). */
  lastAuto?: string;
  entries: BranchDeletionPayload[];
}

/** One repo of the project: where it is checked out, its base and clone url. */
interface RepoRef {
  repo: string;
  cwd: string;
  base: string;
  url: string;
}

/** Parse the deletion log text (an empty log on any error). */
function parseLog(text: string | null): DeletionLog {
  try {
    const o = JSON.parse(text || "{}") as Partial<DeletionLog>;
    return { ...(o.lastAuto ? { lastAuto: o.lastAuto } : {}), entries: Array.isArray(o.entries) ? o.entries : [] };
  } catch {
    return { entries: [] };
  }
}

/** The deletion log as on the remote books branch. */
async function readLog(root: string, base: string): Promise<DeletionLog> {
  return parseLog(await readBooksFile(root, base, BRANCH_DELETIONS_REL));
}

/** Apply `fn` to the deletion log on the books branch (a books-only commit, retried on a race). */
async function writeLog(root: string, base: string, message: string, fn: (log: DeletionLog) => boolean): Promise<boolean> {
  const res = await mutateBooks(root, base, message, async (dir) => {
    const log = parseLog(await B.readBook(dir, BRANCH_DELETIONS_REL));
    if (!fn(log)) return false;
    await B.writeBook(dir, BRANCH_DELETIONS_REL, JSON.stringify(log, null, 2) + "\n");
    return true;
  });
  return res === "pushed";
}

/** The repo `repo` ("" = the root) of the served project, or null. */
async function repoOf(root: string, repo: string): Promise<{ ref: RepoRef; rootBase: RepoBase } | null> {
  const bases = await resolveBases(root);
  if (!repo) return { ref: { repo: "", cwd: root, base: bases.root.base, url: bases.root.url }, rootBase: bases.root };
  const sub = bases.subs.find((s) => s.dir === repo);
  return sub ? { ref: { repo, cwd: join(root, sub.dir), base: sub.base, url: sub.url }, rootBase: bases.root } : null;
}

/** The latest PR state per head branch (same-repo PRs), from `gh` / `glab`; empty when unknown. */
async function prStates(url: string): Promise<Map<string, { number: number; state: "open" | "merged" | "closed" }>> {
  const out = new Map<string, { number: number; state: "open" | "merged" | "closed" }>();
  const h = repoHost(url);
  if (!h.provider) return out;
  try {
    if (h.provider === "gh") {
      const repo = h.host && h.host !== "github.com" ? `${h.host}/${h.slug}` : h.slug;
      const { stdout } = await run("gh", ["pr", "list", "-R", repo, "--state", "all", "-L", "200", "--json", "number,state,headRefName,isCrossRepository"], { timeout: 60_000 });
      // gh lists newest first — keep the first (latest) PR of each head; an open one always wins.
      for (const p of JSON.parse(stdout) as Record<string, unknown>[]) {
        if (p.isCrossRepository === true) continue;
        const head = String(p.headRefName ?? "");
        const s = String(p.state ?? "").toLowerCase();
        const state = s === "open" ? "open" : s === "merged" ? "merged" : "closed";
        const cur = out.get(head);
        if (!cur || state === "open") out.set(head, { number: Number(p.number), state });
      }
      return out;
    }
    const { stdout } = await run("glab", ["mr", "list", "-R", h.slug, "--all", "-F", "json", "-P", "200"], { timeout: 60_000 });
    for (const m of JSON.parse(stdout) as Record<string, unknown>[]) {
      if (m.source_project_id !== m.target_project_id) continue;
      const head = String(m.source_branch ?? "");
      const s = String(m.state ?? "").toLowerCase();
      const state = s === "opened" ? "open" : s === "merged" ? "merged" : "closed";
      const cur = out.get(head);
      if (!cur || state === "open") out.set(head, { number: Number(m.iid), state });
    }
  } catch {
    /* no host CLI / no auth — PR reasons are just unknown */
  }
  return out;
}

/**
 * The task ids still alive in the books: in AI_TODO, under a claim, or in the AI_TODO trash within retention. A
 * group's DOC branch stays alive while any task of the group is (its tasks branch from it — ADR-0536).
 */
async function liveTaskIds(root: string, base: string): Promise<Set<string>> {
  const [todo, progress] = await Promise.all([readBooksFile(root, base, "AI_TODO.md"), readBooksFile(root, base, "AI_PROGRESS.md")]);
  const ids = new Set<string>(B.parseTasks(todo ?? "").tasks.map((t) => t.id));
  for (const c of B.parseClaims(progress ?? "").claims) ids.add(c.id);
  for (const id of B.trashedIds(todo ?? "")) ids.add(id);
  for (const id of [...ids]) {
    const g = /^TSK-(\d{6})-/.exec(id)?.[1];
    if (g) ids.add(`DOC-${g}-001`);
  }
  return ids;
}

/** The dead branches of one repo (the excluded ones are never listed). */
async function listCandidates(root: string, rootBase: RepoBase, ref: RepoRef): Promise<BranchCandidatePayload[]> {
  await git(ref.cwd, ["fetch", "-q", "--prune", "origin"], 180_000);
  const def = (await gitQuiet(ref.cwd, ["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"])).trim().replace(/^origin\//, "");
  const current = await currentBranch(ref.cwd);
  const lines = (
    await gitQuiet(ref.cwd, ["for-each-ref", "refs/remotes/origin", "--format=%(refname:lstrip=3)%09%(objectname)%09%(committerdate:iso-strict)%09%(authorname)"])
  )
    .split("\n")
    .filter(Boolean);
  const [prs, live] = await Promise.all([prStates(ref.url), liveTaskIds(root, rootBase.base)]);
  const prefix = `dev/${ref.base}/`;
  const staleBefore = Date.now() - BRANCH_STALE_DAYS * 86_400_000;
  const out: BranchCandidatePayload[] = [];
  for (const line of lines) {
    const [name = "", sha = "", date = "", author = ""] = line.split("\t");
    if (!name || name === "HEAD" || name === ref.base || name === def || name === current || name.startsWith("autonomous-books/")) continue;
    const pr = prs.get(name) ?? null;
    if (pr?.state === "open") continue;
    const is4pm = name.startsWith(prefix);
    const task = is4pm ? (name.split("/").pop() ?? "") : "";
    if (is4pm && live.has(task)) continue;
    const reasons: BranchCandidatePayload["reasons"] = [];
    const merged = await run("git", ["merge-base", "--is-ancestor", `origin/${name}`, `origin/${ref.base}`], { cwd: ref.cwd }).then(
      () => true,
      () => false,
    );
    if (merged) reasons.push("merged");
    if (pr) reasons.push("pr-closed"); // an open PR was excluded above
    if (is4pm && /^(?:TSK|DOC)-/.test(task) && !(await bookMentions(root, rootBase.base, task))) reasons.push("task-gone");
    if (Date.parse(date) < staleBefore) reasons.push("stale");
    if (reasons.length) out.push({ name, sha, kind: is4pm ? "4pm" : "other", reasons, lastCommitAt: date, author, pr });
  }
  return out;
}

/** Cache of AI_DONE per books base during one listing. */
const doneCache = new Map<string, { at: number; text: string }>();

/** Is `taskId` recorded in AI_DONE (delivered, split, …)? A task in no book at all is gone. */
async function bookMentions(root: string, base: string, taskId: string): Promise<boolean> {
  const key = `${root}\u0000${base}`;
  let hit = doneCache.get(key);
  if (!hit || Date.now() - hit.at > 30_000) {
    hit = { at: Date.now(), text: (await readBooksFile(root, base, "AI_DONE.md")) ?? "" };
    doneCache.set(key, hit);
  }
  return hit.text.includes(taskId);
}

/**
 * Delete `names` in one repo: each must still be a candidate; the remote branch is deleted (never forced past a
 * host protection), the worker's local copy too unless it holds commits the remote did not; every deletion is
 * logged on the books branch.
 */
async function deleteBranches(
  root: string,
  rootBase: RepoBase,
  ref: RepoRef,
  names: readonly string[],
  who: { by?: string; byLabel?: string; mode: "manual" | "auto" },
): Promise<BranchDeleteResultPayload[]> {
  const candidates = new Map((await listCandidates(root, rootBase, ref)).map((c) => [c.name, c]));
  const results: BranchDeleteResultPayload[] = [];
  const logged: BranchDeletionPayload[] = [];
  for (const name of names) {
    const c = candidates.get(name);
    if (!c) {
      results.push({ name, outcome: "skipped", detail: "no longer a candidate" });
      continue;
    }
    try {
      await git(ref.cwd, ["push", "-q", "origin", "--delete", name], 120_000);
    } catch (err) {
      results.push({ name, outcome: "failed", detail: (err instanceof Error ? err.message : String(err)).slice(0, 200) });
      continue;
    }
    logged.push({ id: randomUUID(), repo: ref.repo, name, sha: c.sha, reasons: c.reasons, mode: who.mode, ...(who.by ? { by: who.by } : {}), ...(who.byLabel ? { byLabel: who.byLabel } : {}), at: new Date().toISOString() });
    results.push({ name, outcome: "deleted", ...((await dropLocal(ref.cwd, name, c.sha)) ? {} : { keptLocal: true }) });
  }
  if (logged.length) {
    await writeLog(root, rootBase.base, `chore(auto): log deleted branches ${logged.map((e) => e.name).join(", ")}`.slice(0, 200), (log) => {
      log.entries.push(...logged);
      return true;
    });
  }
  return results;
}

/** Drop the local branch `name` when it is not checked out and holds nothing beyond `sha`; false = kept. */
async function dropLocal(cwd: string, name: string, sha: string): Promise<boolean> {
  if (!(await gitQuiet(cwd, ["rev-parse", "-q", "--verify", `refs/heads/${name}`])).trim()) return true;
  if ((await currentBranch(cwd)) === name) return false;
  const behind = await run("git", ["merge-base", "--is-ancestor", `refs/heads/${name}`, sha], { cwd }).then(
    () => true,
    () => false,
  );
  if (!behind) return false;
  await gitQuiet(cwd, ["branch", "-q", "-D", name]);
  return true;
}

/** Restore one logged deletion: refused when the name exists again or no copy of the commit is left. */
async function restoreBranch(root: string, rootBase: RepoBase, ref: RepoRef, id: string): Promise<GitBranchCleanupReply> {
  const entry = (await readLog(root, rootBase.base)).entries.find((e) => e.id === id && e.repo === ref.repo);
  if (!entry) return { ok: false, error: "unknown deletion" };
  if ((await gitQuiet(ref.cwd, ["ls-remote", "--heads", "origin", entry.name])).trim()) return { ok: false, code: "BRANCH_EXISTS", error: "branch exists" };
  const has = async (): Promise<boolean> => (await gitQuiet(ref.cwd, ["cat-file", "-t", entry.sha])).trim() === "commit";
  if (!(await has())) await gitQuiet(ref.cwd, ["fetch", "-q", "origin", entry.sha], 120_000);
  if (!(await has())) return { ok: false, code: "BRANCH_RESTORE_UNAVAILABLE", error: "commit no longer available" };
  try {
    await git(ref.cwd, ["push", "-q", "origin", `${entry.sha}:refs/heads/${entry.name}`], 120_000);
  } catch (err) {
    return { ok: false, error: (err instanceof Error ? err.message : String(err)).slice(0, 300) };
  }
  await writeLog(root, rootBase.base, `chore(auto): restore branch ${entry.name}`, (log) => {
    const e = log.entries.find((x) => x.id === id);
    if (!e) return false;
    e.restoredAt = new Date().toISOString();
    return true;
  });
  return { ok: true };
}

/** Serve one `git.branchCleanup` request. @api machine-0092 @api machine-0093 @api machine-0094 @api machine-0095 */
export async function handleBranchCleanup(root: string | null, req: GitBranchCleanupRequest): Promise<GitBranchCleanupReply> {
  if (!root) return { ok: false, error: "This worker has no project folder." };
  try {
    const found = await repoOf(root, req.repo);
    if (!found) return { ok: false, error: "unknown repo" };
    const { ref, rootBase } = found;
    switch (req.op) {
      case "list":
        return { ok: true, candidates: await listCandidates(root, rootBase, ref) };
      case "delete":
        return { ok: true, results: await deleteBranches(root, rootBase, ref, req.names, { by: req.by, byLabel: req.byLabel, mode: "manual" }) };
      case "log":
        return { ok: true, log: (await readLog(root, rootBase.base)).entries.filter((e) => e.repo === ref.repo).reverse() };
      case "restore":
        return await restoreBranch(root, rootBase, ref, req.id);
    }
  } catch (err) {
    return { ok: false, error: (err instanceof Error ? err.message : String(err)).slice(0, 300) };
  }
}

/**
 * Drop this worker's local copies of branches deleted elsewhere (the last 90 days of the log, not restored) —
 * only when not checked out and holding nothing beyond the deleted head. Runs at each cycle start.
 */
export async function pruneDeletedLocals(root: string, rootBase: RepoBase, subs: readonly RepoBase[]): Promise<void> {
  const since = Date.now() - 90 * 86_400_000;
  const entries = (await readLog(root, rootBase.base)).entries.filter((e) => !e.restoredAt && Date.parse(e.at) > since);
  for (const e of entries) {
    const sub = e.repo ? subs.find((s) => s.dir === e.repo) : null;
    if (e.repo && !sub) continue;
    await dropLocal(e.repo ? join(root, e.repo) : root, e.name, e.sha).catch(() => false);
  }
}

/**
 * The daily cleanup (`branchCleanup.enabled`): the first worker of the UTC day takes the day in the log (the books
 * push is the lock), then deletes, in the root and each submodule, the 4PM task branches that are merged / whose PR
 * is merged or closed / whose task is gone, with no commit for `afterDays`. Other branches are never touched.
 */
export async function autoCleanupBranches(
  root: string,
  rootBase: RepoBase,
  subs: readonly RepoBase[],
  settings: { enabled: boolean; afterDays: number },
  log: (line: string) => Promise<void>,
): Promise<void> {
  if (!settings.enabled) return;
  const day = new Date().toISOString().slice(0, 10);
  if ((await readLog(root, rootBase.base)).lastAuto === day) return;
  const taken = await writeLog(root, rootBase.base, `chore(auto): branch cleanup ${day}`, (l) => {
    if (l.lastAuto === day) return false;
    l.lastAuto = day;
    return true;
  });
  if (!taken) return;
  const olderThan = Date.now() - settings.afterDays * 86_400_000;
  const repos: RepoRef[] = [
    { repo: "", cwd: root, base: rootBase.base, url: rootBase.url },
    ...subs.filter((s) => s.base).map((s) => ({ repo: s.dir, cwd: join(root, s.dir), base: s.base, url: s.url })),
  ];
  for (const ref of repos) {
    const names = (await listCandidates(root, rootBase, ref).catch(() => []))
      .filter((c) => c.kind === "4pm" && c.reasons.some((r) => r !== "stale") && Date.parse(c.lastCommitAt) < olderThan)
      .map((c) => c.name);
    if (!names.length) continue;
    const res = await deleteBranches(root, rootBase, ref, names, { mode: "auto" });
    await log(`[cleanup] ${ref.repo || "root"}: deleted ${res.filter((r) => r.outcome === "deleted").length} of ${names.length} dead task branch(es)`);
  }
}
