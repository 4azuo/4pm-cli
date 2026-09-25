/**
 * Project scaffolding on the worker (project-0010/0011, project.create/add channels).
 * ADR-0314 (single-repo): a project has **one** repo cloned/scaffolded directly at the physic-project
 * root — the root **is** the repo (`.git` at the root, ADR-0080). **create** clones + fully scaffolds
 * it (template + spec + AI init); **add** clones it with no scaffold/AI-init (ADR-0117). 4PM never
 * creates repos — the repo is an existing one by `url` (ADR-0172). ADR-0316: any declared **git
 * submodules** are attached under the root (`git submodule add` + commit + push) after the primary —
 * submodules are attach-only (no scaffold); only the primary is scaffolded.
 */
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type {
  ProjectAddPayload,
  ProjectCreatePayload,
  ProjectJobReply,
  ProjectProgressPayload,
} from "@4pm/ws";
import { PROJECT_TEMPLATE, type AiGuideFile } from "@4pm/constants";
import { aiGenerate } from "./ai-assist";

const run = promisify(execFile);

/** Emit a progress step to the server (project.progress channel). */
export type ProgressEmitter = (p: ProjectProgressPayload) => void;

/** A declared repo of the project (ADR-0172/0314/0316) — read loosely from the spec jsonb. */
interface RepoDecl {
  role?: string;
  primary?: boolean;
  url?: string;
  /** Submodule folder under the root (empty ⇒ the primary/root — ADR-0316). */
  subdir?: string;
  /** Branch to clone / check out (ADR-0292); empty ⇒ the repo's default branch. */
  branch?: string;
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

/**
 * Attach the project's git submodules under the primary root (ADR-0316): `git submodule add
 * [-b <branch>] <url> <subdir>` for each declared submodule, **idempotent** (an already-registered
 * one is `git submodule update --init` instead), then commit `.gitmodules` + the gitlinks and push to
 * the primary's remote. Push is **best-effort** — a failure is surfaced but keeps the local commit for
 * retry. 4PM never creates the repo (ADR-0172) — an empty/unreachable submodule surfaces its git error.
 */
async function attachSubmodules(
  root: string,
  submodules: RepoDecl[],
  emit: (step: string, message: string) => void,
  createMissingBranch = false,
): Promise<void> {
  if (submodules.length === 0) return;
  // The root must be a git repo (the primary) before a submodule can be added.
  if (!existsSync(join(root, ".git"))) return;
  let added = 0;
  for (const sub of submodules) {
    const dir = (sub.subdir ?? "").trim();
    if (!dir || !sub.url) continue;
    // Already registered (working tree or a stored gitdir) ⇒ just (re)initialize it (idempotent).
    if (existsSync(join(root, dir, ".git")) || existsSync(join(root, ".git", "modules", dir))) {
      emit("submodule", `Submodule ${dir} already present — updating…`);
      try {
        await run("git", ["submodule", "update", "--init", "--", dir], { cwd: root, timeout: 120_000 });
      } catch {
        // A missing/unreachable submodule remote must not fail the whole scaffold.
      }
      continue;
    }
    emit("submodule", `Adding submodule ${sub.url} → ${dir}…`);
    const b = (sub.branch ?? "").trim();
    // When creating a project (ADR-0326), ensure the declared branch exists on the submodule's remote
    // so `submodule add -b` can check it out; if it can't be created (no write creds), fall back to
    // adding the default branch and creating the branch locally (recorded in .gitmodules).
    if (b && createMissingBranch && !(await ensureRemoteBranch(sub.url, b, emit))) {
      try {
        await run("git", ["submodule", "add", sub.url, dir], { cwd: root, timeout: 120_000 });
        await run("git", ["config", "-f", ".gitmodules", `submodule.${dir}.branch`, b], { cwd: root, timeout: 30_000 });
        try {
          await run("git", ["checkout", "-b", b], { cwd: join(root, dir), timeout: 30_000 });
          await run("git", ["push", "-u", "origin", b], { cwd: join(root, dir), timeout: 120_000 });
        } catch (pushErr) {
          const pmsg = pushErr instanceof Error ? pushErr.message : String(pushErr);
          emit("git-branch-push-failed", `Submodule ${dir}: branch "${b}" created locally but the push failed: ${pmsg}`);
        }
        added++;
        continue;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!/already exists|already registered|in the index/i.test(msg)) {
          throw new Error(`git submodule add ${dir} failed: ${msg}`);
        }
        // fall through to the shared "already registered" handling below
      }
    }
    try {
      await run("git", ["submodule", "add", ...(b ? ["-b", b] : []), sub.url, dir], { cwd: root, timeout: 120_000 });
      added++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Already in the index/.gitmodules (e.g. after a force re-clone) ⇒ initialize instead of add.
      if (/already exists|already registered|in the index/i.test(msg)) {
        try {
          await run("git", ["submodule", "update", "--init", "--", dir], { cwd: root, timeout: 120_000 });
          added++;
        } catch {
          // best-effort
        }
      } else {
        throw new Error(`git submodule add ${dir} failed: ${msg}`);
      }
    }
  }
  if (added > 0) await commitAndPushSubmodules(root, submodules, emit);
}

/**
 * Commit `.gitmodules` + the added gitlinks and push to the primary's remote (ADR-0316). Commits with
 * the repo's configured identity, falling back to a generic 4PM identity so a worker with no git
 * user.* never blocks (ADR-0097 sets the real author on AI runs). Push reuses the worker's git-auth
 * (ADR-0192) and is best-effort — a push failure is surfaced but the local commit is kept for retry.
 */
async function commitAndPushSubmodules(
  root: string,
  submodules: RepoDecl[],
  emit: (step: string, message: string) => void,
): Promise<void> {
  const dirs = submodules.map((s) => (s.subdir ?? "").trim()).filter(Boolean);
  emit("submodule", "Committing .gitmodules…");
  await run("git", ["add", ".gitmodules", ...dirs], { cwd: root, timeout: 60_000 });
  // Nothing staged (everything already committed) ⇒ no commit, no push.
  const staged = (await run("git", ["diff", "--cached", "--name-only"], { cwd: root, timeout: 30_000 })).stdout.trim();
  if (!staged) return;
  const commitArgs = ["commit", "-m", "chore: add git submodules (4PM)"];
  try {
    await run("git", commitArgs, { cwd: root, timeout: 60_000 });
  } catch {
    // No user.name/user.email configured — retry with a 4PM fallback identity so the commit lands.
    await run("git", ["-c", "user.name=4PM", "-c", "user.email=noreply@4pm.app", ...commitArgs], { cwd: root, timeout: 60_000 });
  }
  emit("submodule", "Pushing .gitmodules to the primary remote…");
  try {
    await run("git", ["push"], { cwd: root, timeout: 120_000 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Best-effort (ADR-0316): keep the local commit; surface the reason so the user can push later.
    emit("submodule-push-failed", `Submodules committed locally but the push failed: ${msg}`);
  }
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
): Promise<boolean> {
  if (await remoteHasBranch(url, branch)) return true;
  const tmp = await mkdtemp(join(tmpdir(), "4pm-branch-"));
  try {
    emit("git", `Branch "${branch}" not found on ${url} — creating it from the default branch…`);
    await run("git", ["clone", "--depth", "1", url, tmp], { timeout: 120_000 });
    await run("git", ["checkout", "-b", branch], { cwd: tmp, timeout: 30_000 });
    await run("git", ["push", "-u", "origin", branch], { cwd: tmp, timeout: 120_000 });
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    emit("git-branch-push-failed", `Could not create branch "${branch}" on ${url}: ${msg}`);
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
  // Create the declared branch when creating a project and the remote lacks it (ADR-0326): clone the
  // default branch, then create the branch — pushing it best-effort so it exists for other workers.
  if (b && opts.createMissingBranch && !(await remoteHasBranch(repo.url, b))) {
    emit("git", `Cloning ${repo.url} (default branch) to create "${b}"…`);
    await run("git", ["clone", repo.url, target], { timeout: 120_000 });
    await run("git", ["checkout", "-b", b], { cwd: target, timeout: 30_000 });
    try {
      await run("git", ["push", "-u", "origin", b], { cwd: target, timeout: 120_000 });
      emit("git", `Created and pushed branch "${b}".`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      emit("git-branch-push-failed", `Branch "${b}" created locally but the push failed: ${msg} — push it when credentials are available.`);
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
  await attachSubmodules(physicRoot, submodulesOf(list), step);
}

/**
 * Locate the sample-project template (override via SCAFFOLD_SAMPLE_DIR). Robust to both
 * layouts: the dev source tree (this file at `src/core/` ⇒ template two levels up) and the
 * tsup bundle (`dist/index.js` ⇒ template copied alongside as `dist/project-sample`, see
 * tsup.config `onSuccess`). The old single `../../project-sample` assumed the source layout
 * only, so from the bundled `dist/` it resolved to a non-existent path (ENOENT /project-sample).
 */
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
 * project.create — scaffold into `<profileDir>/<projectName>` (folder = project name,
 * ADR-0064/0080; no user-chosen path). ADR-0314: the root **is** the single repo — clone it at the
 * root, then fully scaffold it (template + spec + AI init). Returns the resolved path (the root).
 */
export async function scaffoldProject(
  payload: ProjectCreatePayload,
  profileDir: string,
  onProgress?: ProgressEmitter,
): Promise<ProjectJobReply> {
  // Track the current step so a failure reply can name what broke (ADR-0263).
  let lastStep = "start";
  const emit = (step: string, message: string): void => {
    lastStep = step;
    onProgress?.({ projectId: payload.projectId, step, message });
  };
  try {
    // The folder lives inside the cli profile (ADR-0080); allow SCAFFOLD_ROOT override.
    const root = process.env.SCAFFOLD_ROOT ? resolve(process.env.SCAFFOLD_ROOT) : resolve(profileDir);
    const target = join(root, payload.projectName);
    await mkdir(target, { recursive: true });
    // Every project declares exactly one repo (ADR-0314); the spec schema enforces it — guard here too.
    const repo = singleRepo(reposOf(payload.spec));
    if (!repo) throw new Error("A project must declare one repo (ADR-0314).");
    emit("git", "Cloning repository…");
    // Create mode (ADR-0326): create the declared branch on the primary + submodules when the remote
    // doesn't have it yet (a fresh project naming a new branch).
    await provisionRepo(target, repo, emit, { createMissingBranch: true });
    // Scaffold the repo at the root (template + spec + AI init).
    await scaffoldRepo(target, payload.projectName, payload.spec, emit);
    // Attach the declared git submodules under the root (ADR-0316) — only the primary is scaffolded.
    await attachSubmodules(target, submodulesOf(reposOf(payload.spec)), emit, true);
    // Stamp the template-version marker (ADR-0262) at the root so the web can later detect drift.
    emit("version", "Writing .4pm/.4pm.json…");
    await writeTemplateMarker(target);
    onProgress?.({ projectId: payload.projectId, step: "done", message: "Scaffold complete.", done: true });
    return { ok: true, path: target };
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
): Promise<void> {
  await mkdir(dir, { recursive: true });
  emit("copy", `Copying the sample template into ${label}…`);
  // force:false ⇒ keep any files the clone already has instead of clobbering them.
  await cp(sampleDir(), dir, { recursive: true, force: false, errorOnExist: false });
  if (spec) {
    emit("spec", `Writing project.spec.json into ${label}…`);
    await writeFile(join(dir, "project.spec.json"), JSON.stringify(spec, null, 2), "utf8");
    // AI init (ADR-0080): subagent files + README + the project's guide file from the spec.
    await aiInit(dir, spec, emit);
  }
}

/**
 * Write `<target>/.4pm/.4pm.json` with the template version this project was scaffolded from
 * (ADR-0262). The version comes from the vendored `@4pm/constants` PROJECT_TEMPLATE, so a created
 * project's stamped version can't drift from the server's "latest". Best-effort within the scaffold.
 */
async function writeTemplateMarker(target: string): Promise<void> {
  const dir = join(target, ".4pm");
  await mkdir(dir, { recursive: true });
  const marker = { templateVersion: PROJECT_TEMPLATE.version, scaffoldedAt: new Date().toISOString() };
  await writeFile(join(dir, ".4pm.json"), JSON.stringify(marker, null, 2) + "\n", "utf8");
}

/** One declared subagent of a spec (loose read from the jsonb). */
interface SubagentDecl {
  name?: string;
  description?: string;
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
 * AI CLI to author `README.md` and the project's single guide file (`CLAUDE.md` **or** `AGENT.md`,
 * from `spec.ai_guide_file` — ADR-0309) from the spec. The guide's `ai_guide_instructions` field is
 * folded into the prompt as extra guidance. Best-effort: a missing/failed AI CLI must not fail the
 * scaffold.
 */
async function aiInit(
  target: string,
  spec: Record<string, unknown>,
  emit: (step: string, message: string) => void,
): Promise<void> {
  // The single agent-guide file the project uses (ADR-0309); default CLAUDE.md when unset/unknown.
  const guideFile: AiGuideFile = readSpecField(spec, "ai_guide_file") === "AGENT.md" ? "AGENT.md" : "CLAUDE.md";
  const guideInstructions = readSpecField(spec, "ai_guide_instructions").trim();
  emit("ai-init", `AI init: subagents, README, ${guideFile}…`);
  // Subagents come straight from the spec (name + description) — no AI call needed.
  const subagents = Array.isArray(spec.subagents) ? (spec.subagents as SubagentDecl[]) : [];
  if (subagents.length > 0) {
    await mkdir(join(target, ".claude", "agents"), { recursive: true });
    for (const sa of subagents) {
      const name = (sa.name || "").trim().replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "");
      if (!name) continue;
      const body = `---\nname: ${name}\n---\n\n${(sa.description || "").trim()}\n`;
      await writeFile(join(target, ".claude", "agents", `${name}.md`), body, "utf8");
    }
  }
  // README + the guide file via the AI CLI (best-effort — skip on failure).
  const specJson = JSON.stringify(spec);
  await generateFile(
    join(target, "README.md"),
    `Write a concise README.md (Markdown only, no preamble) for this project from its spec ` +
      `JSON:\n${specJson}`,
  );
  // The project's single guide file (ADR-0309) — CLAUDE.md or AGENT.md, never both. Other AI CLIs
  // read AGENT.md; Claude Code reads CLAUDE.md. The choice comes from the spec (`ai_guide_file`).
  await generateFile(
    join(target, guideFile),
    `Write a ${guideFile} (Markdown only, no preamble) with guidance/conventions for AI agents ` +
      `working in this project, derived from its spec JSON:\n${specJson}` +
      (guideInstructions ? `\nAlso incorporate these additional instructions/content:\n${guideInstructions}\n` : ""),
  );
}

/** Generate one file's content via the AI CLI; ignore failures (best-effort). */
async function generateFile(path: string, prompt: string): Promise<void> {
  try {
    const text = await aiGenerate(prompt);
    if (text.trim()) await writeFile(path, text.trim() + "\n", "utf8");
  } catch {
    // AI CLI missing/unauthenticated — leave the template's file (if any) untouched.
  }
}

/**
 * project.add — register an existing project (ADR-0117). Derive the target from the profile
 * (`<profileDir>/<projectName>`, folder = name — ADR-0064/0080; no user-chosen path), then clone the
 * declared repo at the root (ADR-0314). No sample template, no AI init unless `scaffoldRepos` asks —
 * the codebase already exists; the spec is filled later via the Spec tab (ADR-0114). Returns the path.
 */
export async function addProject(
  payload: ProjectAddPayload,
  profileDir: string,
  onProgress?: ProgressEmitter,
): Promise<ProjectJobReply> {
  let lastStep = "start";
  const emit = (step: string, message: string): void => {
    lastStep = step;
    onProgress?.({ projectId: payload.projectId, step, message });
  };
  try {
    const root = process.env.SCAFFOLD_ROOT ? resolve(process.env.SCAFFOLD_ROOT) : resolve(profileDir);
    const target = join(root, payload.projectName);
    await mkdir(target, { recursive: true });
    const repo = singleRepo((payload.repos ?? []) as RepoDecl[]);
    // `mode` (ADR-0292): the provision job sends "sync"/"force" for the on-demand "update repo"
    // action; a plain add (project-0011) omits it ⇒ "clone" (idempotent clone-of-missing).
    const mode: ProvisionMode = payload.mode ?? "clone";
    if (repo) await provisionRepo(target, repo, emit, { mode });
    // Scaffold the root when the caller asked (add-with-scaffold); else leave the plain clone.
    if (payload.scaffoldRepos && payload.scaffoldRepos.length > 0) {
      await scaffoldRepo(target, payload.projectName, payload.spec, emit);
    }
    // Attach the declared git submodules under the root (ADR-0316); idempotent on a re-provision.
    await attachSubmodules(target, submodulesOf((payload.repos ?? []) as RepoDecl[]), emit);
    onProgress?.({ projectId: payload.projectId, step: "done", message: "Project added.", done: true });
    return { ok: true, path: target };
  } catch (err) {
    // Emit a terminal error frame (ADR-0292) so the web's live progress modal always ends (with a
    // failure), rather than spinning forever when a clone/pull can't complete.
    const message = err instanceof Error ? err.message : String(err);
    onProgress?.({ projectId: payload.projectId, step: "error", message: `Failed: ${message}`, done: true });
    return { ok: false, error: message, step: lastStep };
  }
}
