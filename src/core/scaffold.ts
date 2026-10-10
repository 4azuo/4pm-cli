/**
 * Project scaffolding on the worker (project-0010/0011, project.create/add channels).
 * ADR-0314 (single-repo): a project has **one** repo cloned/scaffolded directly at the physic-project
 * root — the root **is** the repo (`.git` at the root, ADR-0080). **create** clones + fully scaffolds
 * it (template + spec + AI init); **add** clones it with no scaffold/AI-init (ADR-0117). 4PM never
 * creates repos — the repo is an existing one by `url` (ADR-0172). ADR-0316: any declared **git
 * submodules** are attached under the root (`git submodule add` + commit + push) after the primary —
 * submodules are attach-only (no scaffold); only the primary is scaffolded.
 */
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ProjectAddPayload,
  ProjectCreatePayload,
  ProjectJobReply,
  ProjectProgressPayload,
  ScaffoldPublishResult,
} from "@4pm/ws";
import { PROJECT_TEMPLATE, type AiGuideFile } from "@4pm/constants";
import { SCAFFOLD_TRACKING_FILES } from "@4pm/dto";
import type { AiTaskRunner } from "./ai-task";
import { resolveCliPrompt } from "./prompt-overrides";
import { attachSubmoduleBranches } from "./submodule-branch";
import { lexicalInRoot, PathEscapeError, readFileInRoot, resolveForRead, writeFileInRoot } from "../utils/safe-path";
import { projectFolder } from "../config/profile";
import { execInProject } from "./agent-spawn";

/**
 * Refuse a scaffold copy into `dir` when any path the sample template would write already exists there
 * as a link (or under a linked folder) that really leads outside `dir` (ADR-0430) — `cp` would follow it.
 */
function assertNoEscapingLinks(dir: string, sample: string): void {
  const walk = (rel: string): void => {
    for (const e of readdirSync(join(sample, rel), { withFileTypes: true })) {
      const child = rel ? join(rel, e.name) : e.name;
      const dest = lexicalInRoot(dir, child);
      if (!dest) throw new PathEscapeError(child);
      if (existsSync(dest) || isLinkSync(dest)) {
        if (!resolveForRead(dir, dest)) throw new PathEscapeError(child);
      }
      if (e.isDirectory()) walk(child);
    }
  };
  walk("");
}

/** True when `p` is a symlink (never follows it). */
function isLinkSync(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

// Project git runs as the agent user when uid separation is on (ADR-0430); unchanged otherwise.
const run = execInProject;

/** Emit a progress step to the server (project.progress channel). */
export type ProgressEmitter = (p: ProjectProgressPayload) => void;

/** A declared repo of the project (ADR-0172/0314/0316) — read loosely from the spec jsonb. */
interface RepoDecl {
  role?: string;
  primary?: boolean;
  url?: string;
  /** Submodule folder under the root (empty ⇒ the primary/root — ADR-0316). */
  subdir?: string;
  /** Branch to clone / check out (ADR-0292); empty ⇒ the repo's default branch. The project's base branch (ADR-0370). */
  branch?: string;
  /** Where a missing `branch` is created from (ADR-0370): default branch · another branch · empty (orphan). */
  base?: { kind?: "default" | "branch" | "empty"; branch?: string };
  /** Primary only (ADR-0370): reset the 4PM tracking files; absent ⇒ only when the source had a scaffold. */
  resetTracking?: boolean;
}

/** One submodule's attach outcome (ADR-0370). */
export interface SubmoduleOutcome {
  dir: string;
  ok: boolean;
  error: string | null;
}

/**
 * How to provision the repo whose folder already exists (ADR-0292):
 *  - `clone`  — clone only when missing; a present repo is left untouched (clone-on-connect / add).
 *  - `sync`   — clone when missing, else fetch + check out the configured branch + fast-forward pull.
 *  - `force`  — delete the root and clone it fresh (destructive; discards local changes).
 */
type ProvisionMode = "clone" | "sync" | "force";

/** Read the declared repos from a spec (empty when absent). */
function reposOf(spec: Record<string, unknown> | undefined): RepoDecl[] {
  const repos = spec?.repos;
  return Array.isArray(repos) ? (repos as RepoDecl[]) : [];
}

/** The single project repo (ADR-0314) — the primary, else the first; null when none declared. */
function singleRepo(repos: RepoDecl[]): RepoDecl | null {
  return repos.find((r) => r.primary) ?? repos[0] ?? null;
}

/** The git submodules to attach (ADR-0316) — every non-primary repo that has a url + a folder. */
function submodulesOf(repos: RepoDecl[]): RepoDecl[] {
  const primary = singleRepo(repos);
  return repos.filter((r) => r !== primary && !!r.url && !!(r.subdir ?? "").trim());
}

/** Whether `dir` is a registered submodule: listed in `.gitmodules`, or a gitlink (mode 160000) in the index. */
async function isRegisteredSubmodule(root: string, dir: string): Promise<boolean> {
  if (existsSync(join(root, ".gitmodules"))) {
    const paths = await gitOut(root, ["config", "-f", ".gitmodules", "--get-regexp", "^submodule\\..*\\.path$"]);
    if (paths.split("\n").some((l) => l.split(" ").slice(1).join(" ") === dir)) return true;
  }
  const staged = await gitOut(root, ["ls-files", "--stage", "--", dir]);
  return staged.split("\n").some((l) => l.startsWith("160000 "));
}

/** Every file under `abs` (relative, `/`-separated), skipping `.git`. */
async function listFiles(abs: string, rel = ""): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(join(abs, rel), { withFileTypes: true }).catch(() => [])) {
    if (e.name === ".git") continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await listFiles(abs, r)));
    else out.push(r);
  }
  return out;
}

/**
 * Clear the way for `git submodule add` at `dir` (ADR-0370 §5): untrack placeholder files the primary
 * repo committed there (e.g. the template's `docs/.gitkeep`), drop a half-attached leftover (a gitdir file
 * or `.git/modules/<dir>` that is not registered), then delete the folder. Content that is neither tracked
 * nor a `.gitkeep` placeholder is real work: refuse instead of deleting it.
 */
async function prepareSubmodulePath(root: string, dir: string, emit: (step: string, message: string) => void): Promise<void> {
  const abs = join(root, dir);
  const tracked = (await gitOut(root, ["ls-files", "--", dir])).split("\n").filter(Boolean);
  const onDisk = existsSync(abs) ? await listFiles(abs) : [];
  const trackedRel = new Set(tracked.map((f) => f.slice(dir.length + 1)));
  const foreign = onDisk.filter((f) => !trackedRel.has(f) && !f.endsWith(".gitkeep"));
  if (foreign.length > 0) {
    throw new Error(`"${dir}" already holds ${foreign.length} file(s) that are not part of the repo (e.g. ${foreign[0]}) — move them away, then retry.`);
  }
  if (tracked.length > 0) {
    emit("submodule", `Untracking the placeholder files in ${dir}…`);
    await run("git", ["rm", "-r", "-q", "--cached", "--", dir], { cwd: root, timeout: 30_000 });
  }
  const modules = join(root, ".git", "modules", dir);
  if (existsSync(modules)) {
    emit("submodule", `Cleaning up a half-attached ${dir}…`);
    await rm(modules, { recursive: true, force: true });
  }
  if (existsSync(abs)) await rm(abs, { recursive: true, force: true });
}

/**
 * Attach the project's git submodules under the primary root (ADR-0316, made reliable by ADR-0370).
 * "Registered" is decided from `.gitmodules` / gitlinks — never from an error message. A registered one
 * is `git submodule update --init`ed; otherwise the path is cleared (placeholder files untracked, a
 * half-attached leftover removed, real work refused) and `git submodule add [-b <branch>]` runs. A declared
 * branch missing on the submodule remote is created (per `base`, when credentials allow); if it cannot be,
 * the submodule is added on its default branch, `.gitmodules` records the declared branch and the branch is
 * created locally. Returns one outcome per submodule (never throws for a single submodule). `commit`: commit
 * `.gitmodules` + gitlinks and push (provision / clone-on-connect); a create leaves them to its scaffold commit.
 */
async function attachSubmodules(
  root: string,
  submodules: RepoDecl[],
  emit: (step: string, message: string) => void,
  opts: { createMissingBranch?: boolean; commit?: boolean; base?: RepoDecl["base"] } = {},
): Promise<SubmoduleOutcome[]> {
  const outcomes: SubmoduleOutcome[] = [];
  if (submodules.length === 0) return outcomes;
  // The root must be a git repo (the primary) before a submodule can be added.
  if (!existsSync(join(root, ".git"))) return outcomes;
  let added = 0;
  for (const sub of submodules) {
    const dir = (sub.subdir ?? "").trim();
    if (!dir || !sub.url) continue;
    const b = (sub.branch ?? "").trim();
    try {
      if (await isRegisteredSubmodule(root, dir)) {
        emit("submodule", `Submodule ${dir} already registered — updating…`);
        await run("git", ["submodule", "update", "--init", "--", dir], { cwd: root, timeout: 120_000 });
        // `update --init` leaves a detached HEAD — name it after the declared branch when HEAD is its tip.
        await attachSubmoduleBranches(root, [dir]);
        outcomes.push({ dir, ok: true, error: null });
        continue;
      }
      await prepareSubmodulePath(root, dir, emit);
      emit("submodule", `Adding submodule ${sub.url} → ${dir}…`);
      // Submodules follow the primary's source kind, but never "another branch" (ADR-0370 §2).
      const base = { kind: opts.base?.kind === "empty" ? ("empty" as const) : ("default" as const) };
      const branchReady = !b || (await remoteHasBranch(sub.url, b)) || (!!opts.createMissingBranch && (await ensureRemoteBranch(sub.url, b, emit, base)));
      if (branchReady) {
        await run("git", ["submodule", "add", ...(b ? ["-b", b] : []), sub.url, dir], { cwd: root, timeout: 180_000 });
      } else {
        // The declared branch can't be created on the remote (no write access) — add the default branch,
        // record the declared one in .gitmodules and create it locally.
        await run("git", ["submodule", "add", sub.url, dir], { cwd: root, timeout: 180_000 });
        await run("git", ["config", "-f", ".gitmodules", `submodule.${dir}.branch`, b], { cwd: root, timeout: 30_000 });
        await run("git", ["checkout", "-b", b], { cwd: join(root, dir), timeout: 30_000 });
        emit("git-branch-push-failed", `Submodule ${dir}: branch "${b}" created locally only — push it when credentials are available.`);
      }
      added++;
      outcomes.push({ dir, ok: true, error: null });
    } catch (err) {
      const msg = errText(err);
      emit("submodule-failed", `Submodule ${dir} was not attached: ${msg}`);
      outcomes.push({ dir, ok: false, error: msg });
    }
  }
  if (added > 0 && opts.commit) await commitAndPushSubmodules(root, submodules, emit);
  return outcomes;
}

/**
 * Commit `.gitmodules` + the added gitlinks and push to the primary's remote (ADR-0316). Commits with
 * the configured identity, falling back to a 4PM identity when none is set. Push reuses the worker's
 * git-auth (ADR-0192/0368) and is best-effort — a push failure is surfaced but the local commit is kept.
 */
async function commitAndPushSubmodules(
  root: string,
  submodules: RepoDecl[],
  emit: (step: string, message: string) => void,
): Promise<void> {
  const dirs = submodules.map((s) => (s.subdir ?? "").trim()).filter(Boolean);
  // Only stage paths that exist (`git add` throws on a missing pathspec).
  const addPaths = [
    ...(existsSync(join(root, ".gitmodules")) ? [".gitmodules"] : []),
    ...dirs.filter((d) => existsSync(join(root, d))),
  ];
  if (addPaths.length === 0) return;
  emit("submodule", "Committing .gitmodules…");
  await run("git", ["add", ...addPaths], { cwd: root, timeout: 60_000 });
  const staged = (await run("git", ["diff", "--cached", "--name-only", "--", ...addPaths], { cwd: root, timeout: 30_000 })).stdout.trim();
  if (!staged) return;
  // Commit ONLY the submodule paths (`--only` via the pathspec): whatever else the index holds — e.g. the
  // empty index of a clone whose checkout failed — must never ride along as mass deletions.
  const commitArgs = ["commit", "-m", "chore: add git submodules (4PM)", "--", ...addPaths];
  try {
    await run("git", commitArgs, { cwd: root, timeout: 60_000 });
  } catch {
    await run("git", ["-c", "user.name=4PM", "-c", "user.email=noreply@4pm.app", ...commitArgs], { cwd: root, timeout: 60_000 });
  }
  emit("submodule", "Pushing .gitmodules to the primary remote…");
  try {
    await run("git", ["push", "-u", "origin", "HEAD"], { cwd: root, timeout: 120_000 });
  } catch (err) {
    emit("submodule-push-failed", `Submodules committed locally but the push failed: ${errText(err)}`);
  }
}

/**
 * Heal a clone whose checkout never happened ("Clone succeeded, but checkout failed" — e.g. a file appeared
 * in the folder mid-clone): HEAD has a tree but the index is empty. Left as-is, the next step treats every
 * file as deleted; re-populate the index + working tree from HEAD instead. No-op on a healthy/unborn repo.
 */
async function healUncheckedClone(root: string, emit: (step: string, message: string) => void): Promise<void> {
  const headTree = await gitOut(root, ["ls-tree", "--name-only", "HEAD"]);
  if (!headTree) return; // unborn branch (or unreadable) — nothing to restore
  if (await gitOut(root, ["ls-files"])) return; // index populated — a normal clone
  emit("git", "Repository checkout was incomplete — restoring the working tree from HEAD…");
  await run("git", ["checkout", "-q", "HEAD", "--", ":/"], { cwd: root, timeout: 120_000 });
}

/** First line of a failed command's message (git/gh/glab print the reason there), capped. */
function errText(err: unknown): string {
  const e = err as { stderr?: string; message?: string };
  const raw = (e?.stderr || e?.message || String(err)).trim();
  return raw.split("\n").filter(Boolean).slice(-3).join(" ").slice(0, 500);
}

/** Run a git command in `cwd`, returning trimmed stdout ("" on failure). */
async function gitOut(cwd: string, args: string[]): Promise<string> {
  try {
    return (await run("git", args, { cwd, timeout: 30_000 })).stdout.trim();
  } catch {
    return "";
  }
}

/**
 * Commit the scaffolded working tree and push it straight into the project's base branch (ADR-0370 — no
 * pull request; the declared branch IS the base), returning the outcome (ADR-0368). Stage everything,
 * commit (4PM fallback identity; skipped when clean), then `push -u origin <branch>` (`repo.branch`, else
 * HEAD's branch — an orphan branch is created on the remote by this first push). Best-effort: a failure is
 * emitted and recorded, never thrown. Idempotent, so `project.publish` can re-run it. `opts` (ADR-0393):
 * the Add-existing spec write-back stages only `paths` (never unrelated local changes) with its own message.
 */
export async function commitAndPush(
  root: string,
  repo: RepoDecl,
  emit: (step: string, message: string) => void,
  opts: { message?: string; paths?: string[] } = {},
): Promise<ScaffoldPublishResult> {
  const result: ScaffoldPublishResult = { committed: false, pushed: false, branch: null, prUrl: null, step: null, error: null };
  const fail = (step: "commit" | "push", error: string): ScaffoldPublishResult => {
    result.step = step;
    result.error = error;
    return result;
  };

  emit("commit", "Committing the scaffolded project…");
  try {
    await run("git", ["add", ...(opts.paths?.length ? ["--", ...opts.paths] : ["-A"])], { cwd: root, timeout: 60_000 });
    const staged = (await run("git", ["diff", "--cached", "--name-only"], { cwd: root, timeout: 30_000 })).stdout.trim();
    if (staged) {
      const commitArgs = ["commit", "-m", opts.message ?? "chore: scaffold project (4PM)"];
      try {
        await run("git", commitArgs, { cwd: root, timeout: 60_000 });
      } catch {
        // No user.name/user.email configured — retry with a 4PM fallback identity so the commit lands.
        await run("git", ["-c", "user.name=4PM", "-c", "user.email=noreply@4pm.app", ...commitArgs], { cwd: root, timeout: 60_000 });
      }
    } else {
      emit("commit", "Nothing new to commit.");
    }
  } catch (err) {
    const msg = errText(err);
    emit("commit-failed", `Could not commit the scaffold: ${msg}`);
    return fail("commit", msg);
  }
  result.committed = !!(await gitOut(root, ["rev-parse", "--verify", "HEAD"]));

  const declared = (repo.branch ?? "").trim();
  const head = await gitOut(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const branch = declared || (head && head !== "HEAD" ? head : "");
  result.branch = branch || null;
  emit("push", `Pushing the scaffold to ${branch || "the current branch"}…`);
  try {
    await run("git", ["push", "-u", "origin", branch || "HEAD"], { cwd: root, timeout: 120_000 });
    result.pushed = true;
    emit("push", `Pushed to ${branch || "the current branch"}.`);
  } catch (err) {
    const msg = errText(err);
    // No write credentials (or a rejected push) — keep the local commit for a retry.
    emit("push-failed", `Scaffold committed locally but the push failed: ${msg} — retry from the project page when credentials are available.`);
    return fail("push", msg);
  }
  return result;
}

/**
 * project.publish (ADR-0368/0370, project-0074) — retry in an already-scaffolded project folder: re-attach
 * the declared submodules (from the folder's `project.spec.json`), then commit + push to the base branch.
 */
export async function publishScaffold(
  root: string,
  emit: (step: string, message: string) => void,
): Promise<ScaffoldPublishResult> {
  let repos: RepoDecl[] = [];
  try {
    const spec = JSON.parse(await readFileInRoot(root, join(root, "project.spec.json"), "utf8")) as Record<string, unknown>;
    repos = reposOf(spec);
  } catch {
    // No/invalid spec file — fall back to what git knows (no submodules).
  }
  const repo = singleRepo(repos) ?? {};
  const submodules = await attachSubmodules(root, submodulesOf(repos), emit, { createMissingBranch: true, base: repo.base });
  return withSubmodules(await commitAndPush(root, repo, emit), submodules);
}

/** Fold the submodule outcomes into a publish result: a failed one sets `step: "submodule"` unless a later step failed. */
function withSubmodules(publish: ScaffoldPublishResult, submodules: SubmoduleOutcome[]): ScaffoldPublishResult {
  const failed = submodules.filter((x) => !x.ok);
  if (failed.length > 0 && !publish.step) {
    publish.step = "submodule";
    publish.error = failed.map((x) => `${x.dir}: ${x.error ?? "failed"}`).join("; ");
  }
  return { ...publish, submodules };
}

/** Build `git clone` args honoring an optional branch (ADR-0292). */
function cloneArgs(url: string, dest: string, branch?: string): string[] {
  const b = (branch ?? "").trim();
  return b ? ["clone", "-b", b, url, dest] : ["clone", url, dest];
}

/** Whether the remote already has the branch (ADR-0326). False on any ls-remote failure. */
async function remoteHasBranch(url: string, branch: string): Promise<boolean> {
  try {
    const { stdout } = await run("git", ["ls-remote", "--heads", url, branch], { timeout: 30_000 });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Ensure the declared branch exists on the remote when creating a project (ADR-0326): a freshly
 * created project may name a branch that does not exist on the repo yet. Create it from the repo's
 * default branch in a throwaway clone and push it. Best-effort — a push that fails for lack of write
 * credentials is surfaced (not thrown), and the caller falls back to a local-only branch. Returns
 * true when the branch exists on the remote afterwards. 4PM still never creates the repo (ADR-0172).
 */
async function ensureRemoteBranch(
  url: string,
  branch: string,
  emit: (step: string, message: string) => void,
  base: { kind?: "default" | "branch" | "empty"; branch?: string } = {},
): Promise<boolean> {
  if (await remoteHasBranch(url, branch)) return true;
  const tmp = await mkdtemp(join(tmpdir(), "4pm-branch-"));
  try {
    if (base.kind === "empty") {
      // An orphan branch (ADR-0370): no history — one empty root commit so it can be pushed.
      emit("git", `Branch "${branch}" not found on ${url} — creating it empty (no history)…`);
      await run("git", ["clone", "--no-checkout", "--depth", "1", url, tmp], { timeout: 120_000 });
      await run("git", ["checkout", "--orphan", branch], { cwd: tmp, timeout: 30_000 });
      await run("git", ["rm", "-r", "-q", "--cached", "--ignore-unmatch", "."], { cwd: tmp, timeout: 30_000 });
      await run("git", ["clean", "-fdxq"], { cwd: tmp, timeout: 60_000 });
      await run("git", ["-c", "user.name=4PM", "-c", "user.email=noreply@4pm.app", "commit", "--allow-empty", "-m", "chore: start branch (4PM)"], { cwd: tmp, timeout: 30_000 });
    } else {
      const from = base.kind === "branch" && base.branch ? base.branch : "";
      emit("git", `Branch "${branch}" not found on ${url} — creating it from ${from || "the default branch"}…`);
      await run("git", ["clone", "--depth", "1", ...(from ? ["-b", from] : []), url, tmp], { timeout: 120_000 });
      await run("git", ["checkout", "-b", branch], { cwd: tmp, timeout: 30_000 });
    }
    await run("git", ["push", "-u", "origin", branch], { cwd: tmp, timeout: 120_000 });
    return true;
  } catch (err) {
    emit("git-branch-push-failed", `Could not create branch "${branch}" on ${url}: ${errText(err)}`);
    return false;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/**
 * Update an already-cloned repo in place (ADR-0292, `sync` mode): fetch the remote, check out the
 * configured branch (when set), then fast-forward pull. Never clobbers local work — a pull that
 * cannot fast-forward fails (and is surfaced as a provision error) rather than merging/resetting.
 */
async function updateRepo(
  dir: string,
  branch: string | undefined,
  emit: (step: string, message: string) => void,
): Promise<void> {
  const b = (branch ?? "").trim();
  emit("git", `Updating repository (fetch + ${b ? `checkout ${b} + ` : ""}fast-forward pull)…`);
  await run("git", ["fetch", "origin", "--prune"], { cwd: dir, timeout: 120_000 });
  if (b) await run("git", ["checkout", b], { cwd: dir, timeout: 60_000 });
  await run("git", ["pull", "--ff-only"], { cwd: dir, timeout: 120_000 });
}

/**
 * Provision the ONE project repo at the physic root (ADR-0314: the project root IS the repo).
 * 4PM never creates repos — the repo is an existing one by `url` (ADR-0172); a repo with no `url`
 * is `git init`-ed at the root (rare). `mode` (ADR-0292): `clone` skips a present repo, `sync`
 * fetch + checkout + fast-forward pulls it, `force` deletes the root and re-clones it fresh.
 */
async function provisionRepo(
  target: string,
  repo: RepoDecl,
  emit: (step: string, message: string) => void,
  opts: { mode?: ProvisionMode; createMissingBranch?: boolean } = {},
): Promise<void> {
  const mode: ProvisionMode = opts.mode ?? "clone";
  if (!repo.url) {
    // No url (rare — ADR-0172 wants an existing repo): init an empty repo at the root.
    if (!existsSync(join(target, ".git"))) {
      emit("git", "Initializing repository…");
      await mkdir(target, { recursive: true });
      await run("git", ["init"], { cwd: target, timeout: 20_000 });
    }
    return;
  }
  // The root already holds a clone — apply the requested mode (ADR-0288/0292).
  if (existsSync(join(target, ".git"))) {
    await healUncheckedClone(target, emit);
    if (mode === "sync") {
      await updateRepo(target, repo.branch, emit);
    } else if (mode === "force") {
      emit("git", `Re-cloning ${repo.url} (force)…`);
      await rm(target, { recursive: true, force: true });
      await run("git", cloneArgs(repo.url, target, repo.branch), { timeout: 120_000 });
    } else {
      emit("git", "Repository already present — skipping clone.");
    }
    return;
  }
  const b = (repo.branch ?? "").trim();
  // Create the declared base branch when creating a project and the remote lacks it (ADR-0326/0370),
  // from the chosen source: the default branch, another branch, or nothing (an orphan branch whose first
  // commit is the scaffold — pushed by the publish step).
  if (b && opts.createMissingBranch && !(await remoteHasBranch(repo.url, b))) {
    const kind = repo.base?.kind ?? "default";
    const from = kind === "branch" ? (repo.base?.branch ?? "").trim() : "";
    if (kind === "empty") {
      emit("git", `Creating "${b}" as an empty branch (no history) in ${repo.url}…`);
      await run("git", ["clone", "--no-checkout", repo.url, target], { timeout: 120_000 });
      await run("git", ["checkout", "--orphan", b], { cwd: target, timeout: 30_000 });
      await run("git", ["rm", "-r", "-q", "--cached", "--ignore-unmatch", "."], { cwd: target, timeout: 30_000 });
      // `--orphan` keeps the old tree on disk as untracked files — wipe it so the scaffold starts clean.
      await run("git", ["clean", "-fdxq"], { cwd: target, timeout: 60_000 });
      return;
    }
    emit("git", `Cloning ${repo.url} (${from || "default branch"}) to create "${b}"…`);
    await run("git", cloneArgs(repo.url, target, from || undefined), { timeout: 120_000 });
    await run("git", ["checkout", "-b", b], { cwd: target, timeout: 30_000 });
    try {
      await run("git", ["push", "-u", "origin", b], { cwd: target, timeout: 120_000 });
      emit("git", `Created and pushed branch "${b}".`);
    } catch (err) {
      emit("git-branch-push-failed", `Branch "${b}" created locally but the push failed: ${errText(err)} — the publish step retries it.`);
    }
    return;
  }
  emit("git", `Cloning ${repo.url}…`);
  await run("git", cloneArgs(repo.url, target, repo.branch), { timeout: 120_000 });
}

/**
 * Clone the project's repo into an already-known physic root when missing (ADR-0289) — the
 * clone-on-connect path. Idempotent: `provisionRepo` skips a root that already has `.git`.
 */
export async function ensureReposCloned(
  physicRoot: string,
  repos: { primary?: boolean; url?: string; subdir?: string; branch?: string }[],
  emit?: (step: string, message: string) => void,
): Promise<void> {
  const list = repos as RepoDecl[];
  const repo = singleRepo(list);
  if (!repo) return;
  const step = emit ?? (() => undefined);
  await provisionRepo(physicRoot, repo, step);
  // Attach/init the declared submodules (ADR-0316): self-heals a project whose submodules were never
  // committed (a prior push failure) and initializes those already registered after a fresh clone.
  await attachSubmodules(physicRoot, submodulesOf(list), step, { commit: true });
}

/**
 * Locate the sample-project template (override via SCAFFOLD_SAMPLE_DIR). Robust to both
 * layouts: the dev source tree (this file at `src/core/` ⇒ template two levels up) and the
 * tsup bundle (`dist/index.js` ⇒ template copied alongside as `dist/project-sample`, see
 * tsup.config `onSuccess`). The old single `../../project-sample` assumed the source layout
 * only, so from the bundled `dist/` it resolved to a non-existent path (ENOENT /project-sample).
 */
/** The sample-project template folder (exported for the repo probe — ADR-0370). */
export function projectSampleDir(): string {
  return sampleDir();
}

function sampleDir(): string {
  if (process.env.SCAFFOLD_SAMPLE_DIR) return process.env.SCAFFOLD_SAMPLE_DIR;
  const here = dirname(fileURLToPath(import.meta.url));
  const bundled = resolve(here, "project-sample"); // dist/project-sample (packaged bundle)
  for (const candidate of [bundled, resolve(here, "../project-sample"), resolve(here, "../../project-sample")]) {
    if (existsSync(candidate)) return candidate;
  }
  return bundled;
}

/**
 * project.create — scaffold into `~/.4pm/workspaces/<profile>/<projectName>` (folder = project name,
 * ADR-0064/0080; no user-chosen path). ADR-0314: the root **is** the single repo — clone it at the
 * root, then fully scaffold it (template + spec + AI init). Returns the resolved path (the root).
 */
export async function scaffoldProject(
  payload: ProjectCreatePayload,
  profileDir: string,
  onProgress?: ProgressEmitter,
  // Standard AI run path + org run slot for AI init (ADR-0362); absent ⇒ AI init writes fallbacks only.
  ai?: AiTaskRunner,
  // Re-apply the project's git-auth before the publish step (ADR-0368); absent ⇒ keep the current one.
  applyGitAuth?: (method: string | null, host: string | null) => void,
): Promise<ProjectJobReply> {
  // Track the current step so a failure reply can name what broke (ADR-0263).
  let lastStep = "start";
  const emit = (step: string, message: string): void => {
    lastStep = step;
    onProgress?.({ projectId: payload.projectId, step, message });
  };
  try {
    // The folder lives in the profile's workspace, outside the profile dir (ADR-0430); SCAFFOLD_ROOT overrides.
    const target = projectFolder(profileDir, payload.projectName);
    if (!target) throw new Error("invalid project name");
    await mkdir(target, { recursive: true });
    // Every project declares exactly one repo (ADR-0314); the spec schema enforces it — guard here too.
    const repo = singleRepo(reposOf(payload.spec));
    if (!repo) throw new Error("A project must declare one repo (ADR-0314).");
    // Clone + push must use the project's CURRENT git-auth (ADR-0368): the App may have been set up after
    // this cli connected, so re-apply the method carried by project.create (idempotent when unchanged).
    if (payload.gitAuth !== undefined) applyGitAuth?.(payload.gitAuth ?? null, payload.gitAuthHost ?? null);
    emit("git", "Cloning repository…");
    // Create mode (ADR-0326): create the declared branch on the primary + submodules when the remote
    // doesn't have it yet (a fresh project naming a new branch).
    await provisionRepo(target, repo, emit, { createMissingBranch: true });
    // Did the source already carry a 4PM scaffold? Decides the default of the tracking reset (ADR-0370 §3).
    const sourceHadScaffold = existsSync(join(target, ".4pm", ".4pm.json"));
    // Scaffold the repo at the root (template + spec + AI init). Create resets the template-managed
    // `.claude` config first (ADR-0329) so it never inherits a stale committed/leftover one.
    await scaffoldRepo(target, payload.projectName, payload.spec, emit, { resetClaude: true, ai });
    if (repo.resetTracking ?? sourceHadScaffold) await resetTrackingFiles(target, emit);
    // Attach the declared git submodules under the root (ADR-0316/0370) — committed with the scaffold.
    const submodules = await attachSubmodules(target, submodulesOf(reposOf(payload.spec)), emit, {
      createMissingBranch: true,
      base: repo.base,
    });
    // Stamp the template-version marker (ADR-0262) at the root so the web can later detect drift.
    emit("version", "Writing .4pm/.4pm.json…");
    await writeTemplateMarker(target);
    // Commit + push straight into the base branch (ADR-0370, no PR) — best-effort: a failed push is
    // surfaced + recorded (ADR-0368) but never fails the create (the local commit is kept for a retry).
    const publish = withSubmodules(await commitAndPush(target, repo, emit), submodules);
    onProgress?.({ projectId: payload.projectId, step: "done", message: "Scaffold complete.", done: true });
    return { ok: true, path: target, publish };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), step: lastStep };
  }
}

/**
 * Scaffold the repo at the project root (ADR-0314): copy the `project-sample` template **without
 * clobbering** files the clone already tracks (`force:false`), write `project.spec.json`, then run AI
 * init (README + the project's guide file + subagents). Best-effort AI init — a missing AI CLI must
 * not fail the scaffold.
 */
async function scaffoldRepo(
  dir: string,
  label: string,
  spec: Record<string, unknown> | undefined,
  emit: (step: string, message: string) => void,
  // `ai` (ADR-0362): the standard AI run path + org run slot for AI init; absent ⇒ fallbacks only.
  opts: { resetClaude?: boolean; ai?: AiTaskRunner } = {},
): Promise<void> {
  await mkdir(dir, { recursive: true });
  // On create (ADR-0329), reset the template-managed `.claude` config BEFORE the copy so a create
  // yields the current template — not a stale one kept alive by `force:false` (a reused worker folder
  // or a repo that committed the old `.claude`). `add` never resets (opts.resetClaude falsy).
  if (opts.resetClaude) await resetTemplateManagedClaude(dir, label, emit);
  emit("copy", `Copying the sample template into ${label}…`);
  // Symlink-safe (ADR-0430): a cloned repo whose links would route the sample copy outside the project
  // is refused before anything is written.
  assertNoEscapingLinks(dir, sampleDir());
  // force:false ⇒ keep any files the clone already has instead of clobbering them.
  await cp(sampleDir(), dir, { recursive: true, force: false, errorOnExist: false });
  if (spec) {
    await applyDefaultModel(dir, spec, emit);
    emit("spec", `Writing project.spec.json into ${label}…`);
    await writeFileInRoot(dir, join(dir, "project.spec.json"), JSON.stringify(spec, null, 2));
    // AI init (ADR-0080): subagent files + README + the project's guide file from the spec.
    await aiInit(dir, spec, emit, opts.ai);
  }
}

/**
 * Reset the template-managed `.claude` config before a create copy (ADR-0329). `cp(force:false)`
 * never overwrites an existing file nor deletes one no longer in the template, so a committed/leftover
 * `.claude/settings.json` + `.claude/skills/**` (both are committed — not gitignored) would survive a
 * create and keep an old `deny`/`defaultMode` or a removed skill (e.g. `check-usage`) alive. Remove
 * exactly those two drift-prone, template-owned paths so the fresh bundle refills them; everything
 * else — the gitignored runtime/local files inside `.claude` (`settings.local.json`, `logs/`, `rag/`,
 * `.autonomous.*`, cron), `.claude/agents` (spec subagents are written by `aiInit` after the copy),
 * and all non-`.claude` source files — is preserved.
 */
async function resetTemplateManagedClaude(
  dir: string,
  label: string,
  emit: (step: string, message: string) => void,
): Promise<void> {
  const claude = join(dir, ".claude");
  if (!existsSync(claude)) return;
  emit("copy", `Resetting template .claude config in ${label}…`);
  await rm(join(claude, "settings.json"), { force: true });
  await rm(join(claude, "skills"), { recursive: true, force: true });
}

/**
 * Reset the 4PM tracking files (ADR-0370 §3) to the template's empty versions
 * (`.claude/templates/<NAME>.empty.md`), so a project started from a branch that already carried a
 * scaffold does not inherit the previous run's tasks and progress. Code and other files are untouched.
 */
async function resetTrackingFiles(target: string, emit: (step: string, message: string) => void): Promise<void> {
  const templates = join(sampleDir(), ".claude", "templates");
  const reset: string[] = [];
  for (const file of SCAFFOLD_TRACKING_FILES) {
    const empty = join(templates, file.replace(/\.md$/, ".empty.md"));
    if (!existsSync(empty)) continue;
    await cp(empty, join(target, file), { force: true });
    reset.push(file);
  }
  if (reset.length > 0) emit("copy", `Reset the 4PM tracking files: ${reset.join(", ")}.`);
}

/**
 * Write `<target>/.4pm/.4pm.json` with the template version this project was scaffolded from
 * (ADR-0262). The version comes from the vendored `@4pm/constants` PROJECT_TEMPLATE, so a created
 * project's stamped version can't drift from the server's "latest". Best-effort within the scaffold.
 */
async function writeTemplateMarker(target: string): Promise<void> {
  const marker = { templateVersion: PROJECT_TEMPLATE.version, scaffoldedAt: new Date().toISOString() };
  await writeFileInRoot(target, join(target, ".4pm", ".4pm.json"), JSON.stringify(marker, null, 2) + "\n");
}

/** One declared subagent of a spec (loose read from the jsonb). */
interface SubagentDecl {
  name?: string;
  description?: string;
  /** Model alias/id for the agent (ADR-0394); `inherit` / empty ⇒ no `model:` (uses the session model). */
  model?: string;
}

/**
 * Render a subagent file (ADR-0394): frontmatter `name`, `description` (the role on one line, JSON-quoted —
 * valid YAML — so Claude Code can pick the agent) and `model` unless it inherits; the full role is the body.
 */
function renderSubagentFile(name: string, sa: SubagentDecl): string {
  const role = (sa.description || "").trim();
  const oneLine = role.replace(/\s+/g, " ").slice(0, 500);
  const model = (sa.model || "").trim();
  const front = [`name: ${name}`, ...(oneLine ? [`description: ${JSON.stringify(oneLine)}`] : []), ...(model && model !== "inherit" ? [`model: ${JSON.stringify(model)}`] : [])];
  return `---\n${front.join("\n")}\n---\n\n${role}\n`;
}

/**
 * Apply the spec's default model (`ai_model`, ADR-0394) to `.claude/settings.json`: set `model`, or remove
 * the key for `default` / empty so the CLI uses its own default. Other keys are kept; a missing or
 * unreadable settings file is left alone (best-effort — never fails the scaffold).
 */
async function applyDefaultModel(dir: string, spec: Record<string, unknown>, emit: (step: string, message: string) => void): Promise<void> {
  const path = join(dir, ".claude", "settings.json");
  if (!existsSync(path)) return;
  const model = readSpecField(spec, "ai_model").trim();
  // `.claude/settings.json` is the Claude CLI's file — another provider's model is not written here (ADR-0396).
  const provider = readSpecField(spec, "ai_provider").trim() || "claude";
  if (provider !== "claude") return;
  try {
    const settings = JSON.parse(await readFileInRoot(dir, path, "utf8")) as Record<string, unknown>;
    if (!model || model === "default") delete settings.model;
    else settings.model = model;
    await writeFileInRoot(dir, path, JSON.stringify(settings, null, 2) + "\n");
    emit("copy", `Default AI model: ${model && model !== "default" ? model : "CLI default"}.`);
  } catch {
    emit("copy", "Could not apply the default AI model to .claude/settings.json — kept as is.");
  }
}

/**
 * Read a scalar spec field from either the self-describing envelope (`fields[].id/value` —
 * `features/spec/envelope.ts`) or the legacy flat shape. Empty when absent/non-string.
 */
function readSpecField(spec: Record<string, unknown>, key: string): string {
  const fields = (spec as { fields?: unknown }).fields;
  if (Array.isArray(fields)) {
    const f = fields.find(
      (x): x is { id: string; value: unknown } =>
        !!x && typeof (x as { id?: unknown }).id === "string" && (x as { id: string }).id === key,
    );
    if (f && typeof f.value === "string") return f.value;
  }
  return typeof spec[key] === "string" ? (spec[key] as string) : "";
}

/**
 * AI init (ADR-0080) — write `.claude/agents/<name>.md` for each declared subagent, then ask the
 * AI CLI to author `README.md`, the project's single guide file (`CLAUDE.md` **or** `AGENT.md`,
 * from `spec.ai_guide_file` — ADR-0309) and `AI_SECURITY.md` (ADR-0391) from the spec. The guide's
 * `ai_guide_instructions` field is folded into the guide prompt as extra guidance. Best-effort: a
 * missing/failed AI CLI must not fail the scaffold (the copied `project-sample` files stay as the
 * baseline — the guide fallback is the user's typed instructions, the security fallback is the sample).
 */
async function aiInit(
  target: string,
  spec: Record<string, unknown>,
  emit: (step: string, message: string) => void,
  ai?: AiTaskRunner,
): Promise<void> {
  // The single agent-guide file the project uses (ADR-0309); default CLAUDE.md when unset/unknown.
  const guideFile: AiGuideFile = readSpecField(spec, "ai_guide_file") === "AGENT.md" ? "AGENT.md" : "CLAUDE.md";
  const guideInstructions = readSpecField(spec, "ai_guide_instructions").trim();
  emit("ai-init", `AI init: subagents, README, ${guideFile}, AI_SECURITY.md…`);
  // Subagents come straight from the spec (name + description + model) — no AI call needed.
  const subagents = Array.isArray(spec.subagents) ? (spec.subagents as SubagentDecl[]) : [];
  if (subagents.length > 0) {
    await mkdir(join(target, ".claude", "agents"), { recursive: true });
    for (const sa of subagents) {
      const name = (sa.name || "").trim().replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "");
      if (!name) continue;
      await writeFile(join(target, ".claude", "agents", `${name}.md`), renderSubagentFile(name, sa), "utf8");
    }
  }
  // README + the guide file via the AI CLI (best-effort — skip on failure). Both calls run on the
  // standard AI path and share ONE org run slot (ADR-0362): wait in the queue if the org is at its
  // parallel-run limit; after the max wait, skip AI and write the fallbacks so the create still completes.
  const specJson = JSON.stringify(spec);
  let generate: ((prompt: string, label: string) => Promise<string | null>) | null = null;
  let releaseSlot = (): void => undefined;
  if (ai) {
    const slot = await ai.acquireSlot((q) =>
      emit("ai-queued", `Waiting for an AI run slot — ${q.position} ahead (${q.running}/${q.limit} parallel runs in use)…`),
    );
    if (slot.kind === "granted") {
      releaseSlot = () => slot.handle.release();
      generate = (prompt, label) => ai.generate(prompt, target, label);
      if (slot.queued) emit("ai-init", `AI init: subagents, README, ${guideFile}, AI_SECURITY.md…`);
    } else {
      emit("ai-skipped", "No AI run slot freed up in time — AI init skipped; fallback content written.");
    }
  }
  try {
    await generateFile(
      generate,
      join(target, "README.md"),
      "README.md",
      // Admin override (ADR-0381) for `cli.scaffold.readme`, else the shared registry default.
      resolveCliPrompt("cli.scaffold.readme", { specJson }),
    );
  // The project's single guide file (ADR-0309) — CLAUDE.md or AGENT.md, never both. Other AI CLIs
  // read AGENT.md; Claude Code reads CLAUDE.md. The choice comes from the spec (`ai_guide_file`).
  // Fallback (ADR-0309): if the AI CLI is missing/produces nothing but the user typed guide
  // instructions in the wizard, write those verbatim so the guide the user asked for is never lost.
    await generateFile(
      generate,
      join(target, guideFile),
      guideFile,
      // Admin override (ADR-0381) for `cli.scaffold.guide`, else the shared registry default.
      resolveCliPrompt("cli.scaffold.guide", {
        guideFile,
        specJson,
        guideInstructionsBlock: guideInstructions
          ? `\nAlso incorporate these additional instructions/content:\n${guideInstructions}\n`
          : "",
      }),
      guideInstructions,
    );
    // AI_SECURITY.md (ADR-0391): rewrite the copied sample into a spec-tailored security policy so it
    // matches each project's domain/stack/workflow. No fallback — the static `project-sample/AI_SECURITY.md`
    // was already copied before `aiInit`, so when the AI is missing/produces nothing it remains as the
    // baseline policy. The guide (above) is now told to reference this file (cli.scaffold.guide).
    await generateFile(
      generate,
      join(target, "AI_SECURITY.md"),
      "AI_SECURITY.md",
      // Admin override (ADR-0381) for `cli.scaffold.security`, else the shared registry default.
      resolveCliPrompt("cli.scaffold.security", { specJson }),
    );
  } finally {
    releaseSlot();
  }
}

/**
 * Generate one file's content via the AI (best-effort). If there is no AI (`generate` null — no slot /
 * no runner) or it fails / produces nothing and a `fallback` is given, write the fallback verbatim
 * instead of leaving the (possibly empty) template file — used for the guide file so the user's typed
 * instructions survive a missing AI CLI (ADR-0309).
 */
async function generateFile(
  generate: ((prompt: string, label: string) => Promise<string | null>) | null,
  path: string,
  label: string,
  prompt: string,
  fallback?: string,
): Promise<void> {
  try {
    const text = generate ? await generate(prompt, label) : null;
    if (text && text.trim()) {
      // Root-level files (README / guide / AI_SECURITY.md): symlink-safe under their folder (ADR-0430).
      await writeFileInRoot(dirname(path), path, text.trim() + "\n");
      return;
    }
  } catch {
    // AI CLI missing/unauthenticated (or a refused link) — fall through to the fallback (if any).
  }
  if (fallback && fallback.trim()) await writeFileInRoot(dirname(path), path, fallback.trim() + "\n");
}

/**
 * project.add — register an existing project (ADR-0117). Derive the target from the profile
 * (`<profileDir>/<projectName>`, folder = name — ADR-0064/0080; no user-chosen path), then clone the
 * declared repo at the root (ADR-0314). No sample template, no AI init unless `scaffoldRepos` asks —
 * the codebase already exists. A `spec` without `scaffoldRepos` (the Add-existing wizard, ADR-0393) is
 * written back as the root's `project.spec.json` and committed + pushed to the declared branch
 * (best-effort, the outcome returned as `publish`). Returns the path.
 */
export async function addProject(
  payload: ProjectAddPayload,
  profileDir: string,
  onProgress?: ProgressEmitter,
  // Standard AI run path + org run slot for an add-with-scaffold AI init (ADR-0362).
  ai?: AiTaskRunner,
  // Re-apply the project's git-auth before the spec push (ADR-0368/0393); absent ⇒ keep the current one.
  applyGitAuth?: (method: string | null, host: string | null) => void,
): Promise<ProjectJobReply> {
  let lastStep = "start";
  const emit = (step: string, message: string): void => {
    lastStep = step;
    onProgress?.({ projectId: payload.projectId, step, message });
  };
  try {
    // The folder lives in the profile's workspace, outside the profile dir (ADR-0430); SCAFFOLD_ROOT overrides.
    const target = projectFolder(profileDir, payload.projectName);
    if (!target) throw new Error("invalid project name");
    await mkdir(target, { recursive: true });
    const repo = singleRepo((payload.repos ?? []) as RepoDecl[]);
    // Clone + push with the project's CURRENT git-auth (ADR-0368/0393): an add, a provision of a worker
    // attached after it connected, and the add-existing spec write-back all carry it.
    const writeSpec = !!payload.spec && !(payload.scaffoldRepos && payload.scaffoldRepos.length > 0);
    if (payload.gitAuth !== undefined) applyGitAuth?.(payload.gitAuth ?? null, payload.gitAuthHost ?? null);
    // `mode` (ADR-0292): the provision job sends "sync"/"force" for the on-demand "update repo"
    // action; a plain add (project-0011) omits it ⇒ "clone" (idempotent clone-of-missing).
    const mode: ProvisionMode = payload.mode ?? "clone";
    if (repo) await provisionRepo(target, repo, emit, { mode });
    // Scaffold the root when the caller asked (add-with-scaffold); else leave the plain clone.
    if (payload.scaffoldRepos && payload.scaffoldRepos.length > 0) {
      await scaffoldRepo(target, payload.projectName, payload.spec, emit, { ai });
    }
    // Attach the declared git submodules under the root (ADR-0316); idempotent on a re-provision.
    const outcomes = await attachSubmodules(target, submodulesOf((payload.repos ?? []) as RepoDecl[]), emit, { commit: true });
    const failed = outcomes.filter((x) => !x.ok);
    if (failed.length > 0) throw new Error(failed.map((x) => `submodule ${x.dir}: ${x.error ?? "failed"}`).join("; "));
    // Write back the wizard's spec (ADR-0393) and publish only that file — never fails the add.
    let publish: ScaffoldPublishResult | undefined;
    if (writeSpec && repo) {
      emit("spec", "Writing project.spec.json…");
      await writeFile(join(target, "project.spec.json"), JSON.stringify(payload.spec, null, 2), "utf8");
      publish = await commitAndPush(target, repo, emit, { message: "chore: update project spec (4PM)", paths: ["project.spec.json"] });
    }
    onProgress?.({ projectId: payload.projectId, step: "done", message: "Project added.", done: true });
    return { ok: true, path: target, ...(publish ? { publish } : {}) };
  } catch (err) {
    // Emit a terminal error frame (ADR-0292) so the web's live progress modal always ends (with a
    // failure), rather than spinning forever when a clone/pull can't complete.
    const message = err instanceof Error ? err.message : String(err);
    onProgress?.({ projectId: payload.projectId, step: "error", message: `Failed: ${message}`, done: true });
    return { ok: false, error: message, step: lastStep };
  }
}
