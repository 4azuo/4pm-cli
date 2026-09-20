/**
 * Project scaffolding on the worker (project-0010/0011, project.create/add
 * channels): copy the bundled sample-project template into the target directory,
 * write the spec + provision repos + AI init (create — ADR-0080), or clone/link the
 * declared repos of an existing project with no scaffold/AI-init (add — ADR-0117).
 */
import { cp, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type {
  ProjectAddPayload,
  ProjectCreatePayload,
  ProjectJobReply,
  ProjectProgressPayload,
} from "@4pm/ws";
import { repoName } from "@4pm/dto";
import { PROJECT_TEMPLATE } from "@4pm/constants";
import { aiGenerate } from "./ai-assist";

const run = promisify(execFile);

/** Emit a progress step to the server (project.progress channel). */
export type ProgressEmitter = (p: ProjectProgressPayload) => void;

/** One declared repo of a multi-repo spec (ADR-0073, simplified by ADR-0172) — read loosely. */
interface RepoDecl {
  role?: string;
  primary?: boolean;
  url?: string;
  subdir?: string;
  /** Primary branch to clone / check out (ADR-0292); empty ⇒ the repo's default branch. */
  branch?: string;
}

/**
 * How to provision a repo whose folder already exists (ADR-0292):
 *  - `clone`  — clone only when missing; a present repo is left untouched (clone-on-connect / add).
 *  - `sync`   — clone when missing, else fetch + check out the configured branch + fast-forward pull.
 *  - `force`  — delete the repo folder and clone it fresh (destructive; discards local changes).
 */
type ProvisionMode = "clone" | "sync" | "force";

/** Read the declared repos from a spec (empty when absent). */
function reposOf(spec: Record<string, unknown> | undefined): RepoDecl[] {
  const repos = spec?.repos;
  return Array.isArray(repos) ? (repos as RepoDecl[]) : [];
}

/** Pick a sub-repo's folder name (subdir → role → name-from-url → "repo"), sanitized. */
function subDirName(repo: RepoDecl): string {
  const raw = (repo.subdir || repo.role || repoName(repo.url ?? "") || "repo").trim();
  return raw.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "repo";
}

/** Build `git clone` args honoring an optional primary branch (ADR-0292). */
function cloneArgs(url: string, dest: string, branch?: string): string[] {
  const b = (branch ?? "").trim();
  return b ? ["clone", "-b", b, url, dest] : ["clone", url, dest];
}

/**
 * Update an already-cloned repo in place (ADR-0292, `sync` mode): fetch the remote, check out the
 * configured branch (when set), then fast-forward pull. Never clobbers local work — a pull that
 * cannot fast-forward fails (and is surfaced as a provision error) rather than merging/resetting.
 */
async function updateRepo(
  dir: string,
  label: string,
  branch: string | undefined,
  emit: (step: string, message: string) => void,
): Promise<void> {
  const b = (branch ?? "").trim();
  emit("git", `Updating ${label} (fetch + ${b ? `checkout ${b} + ` : ""}fast-forward pull)…`);
  await run("git", ["fetch", "origin", "--prune"], { cwd: dir, timeout: 120_000 });
  if (b) await run("git", ["checkout", b], { cwd: dir, timeout: 60_000 });
  await run("git", ["pull", "--ff-only"], { cwd: dir, timeout: 120_000 });
}

/**
 * Provision the declared repos on the worker (ADR-0172: 4PM never creates repos — every repo
 * is an existing one the user owns, given by `url`). Sub-repos always **clone** into their
 * own subfolder. The primary repo:
 *  - **add mode** (`clonePrimary`, ADR-0117): the root is empty ⇒ **clone into the root**.
 *  - **create mode**: the root already holds the copied `project-sample` template ⇒ `git init`
 *    in place + `remote add origin <url>` (the user's empty repo) so the scaffold can be pushed.
 *
 * `mode` (ADR-0292) controls what happens to a repo whose folder already exists: `clone` skips it
 * (idempotent clone-on-connect / add), `sync` fetch + check out the branch + fast-forward pulls it,
 * `force` deletes the folder and re-clones it fresh (destructive).
 */
async function provisionRepos(
  target: string,
  repos: RepoDecl[],
  emit: (step: string, message: string) => void,
  opts: { clonePrimary?: boolean; mode?: ProvisionMode } = {},
): Promise<void> {
  const mode: ProvisionMode = opts.mode ?? "clone";
  // Sub-repo folder names to preserve when force-recloning the primary (they live INSIDE the root).
  const subDirsToKeep = new Set(repos.filter((r) => !r.primary && r.url).map((r) => subDirName(r)));
  for (const repo of repos) {
    if (repo.primary) {
      if (opts.clonePrimary && repo.url) {
        // The folder already holds the primary repo — apply the requested mode (ADR-0288/0292).
        if (existsSync(join(target, ".git"))) {
          if (mode === "sync") {
            await updateRepo(target, "primary repo", repo.branch, emit);
          } else if (mode === "force") {
            // Re-clone the primary WITHOUT nuking the sub-repos nested under the root: clone into a
            // temp dir, then replace the root's own entries (keeping the sub-repo subfolders) with it.
            emit("git", `Re-cloning ${repo.url} (force)…`);
            const tmp = `${target}.4pm-reclone`;
            await rm(tmp, { recursive: true, force: true });
            await run("git", cloneArgs(repo.url, tmp, repo.branch), { timeout: 120_000 });
            for (const entry of await readdir(target)) {
              if (subDirsToKeep.has(entry)) continue; // preserve a sub-repo's folder
              await rm(join(target, entry), { recursive: true, force: true });
            }
            for (const entry of await readdir(tmp)) {
              if (subDirsToKeep.has(entry)) continue; // never overwrite a preserved sub-repo folder
              await rename(join(tmp, entry), join(target, entry));
            }
            await rm(tmp, { recursive: true, force: true });
          } else {
            emit("git", `Primary repo already present — skipping clone.`);
          }
          continue;
        }
        emit("git", `Cloning ${repo.url}…`);
        await run("git", cloneArgs(repo.url, target, repo.branch), { timeout: 120_000 });
        continue;
      }
      emit("git", "Initializing the primary repo…");
      await run("git", ["init"], { cwd: target, timeout: 20_000 });
      if (repo.url) {
        // Dir already holds the template — link the remote instead of cloning into it.
        await run("git", ["remote", "add", "origin", repo.url], { cwd: target, timeout: 20_000 }).catch(
          () => undefined,
        );
      }
      continue;
    }
    const dir = join(target, subDirName(repo));
    if (repo.url) {
      // The sub-repo folder already holds a clone — apply the requested mode (ADR-0288/0292).
      if (existsSync(join(dir, ".git"))) {
        if (mode === "sync") {
          await updateRepo(dir, `sub-repo ${subDirName(repo)}`, repo.branch, emit);
        } else if (mode === "force") {
          emit("git", `Re-cloning sub-repo ${repo.url} (force)…`);
          await rm(dir, { recursive: true, force: true });
          await run("git", cloneArgs(repo.url, dir, repo.branch), { timeout: 120_000 });
        } else {
          emit("git", `Sub-repo ${subDirName(repo)} already present — skipping clone.`);
        }
        continue;
      }
      emit("git", `Cloning sub-repo ${repo.url}…`);
      await run("git", cloneArgs(repo.url, dir, repo.branch), { timeout: 120_000 });
    } else {
      emit("git", `Initializing sub-repo ${subDirName(repo)}…`);
      await mkdir(dir, { recursive: true });
      await run("git", ["init"], { cwd: dir, timeout: 20_000 });
    }
  }
}

/**
 * Clone any of the declared repos missing from an already-known physic root (ADR-0289) — the
 * clone-on-connect path. Idempotent: `provisionRepos` skips a repo whose target already has `.git`,
 * so this only fills in what's absent (the primary into the root, sub-repos into their subfolders).
 */
export async function ensureReposCloned(
  physicRoot: string,
  repos: { primary?: boolean; url?: string; subdir?: string; branch?: string }[],
  emit?: (step: string, message: string) => void,
): Promise<void> {
  if (repos.length === 0) return;
  await provisionRepos(physicRoot, repos as RepoDecl[], emit ?? (() => undefined), { clonePrimary: true });
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
 * ADR-0064/0080; no user-chosen path): copy the template, persist the spec, provision
 * repos, then run AI init (README/CLAUDE/subagents). Returns the resolved path.
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
    emit("copy", "Copying the sample template…");
    // force:false ⇒ keep any files already there instead of clobbering them.
    await cp(sampleDir(), target, { recursive: true, force: false, errorOnExist: false });
    if (payload.spec) {
      emit("spec", "Writing project.spec.json…");
      await writeFile(
        join(target, "project.spec.json"),
        JSON.stringify(payload.spec, null, 2),
        "utf8",
      );
    }
    // Multi-repo provisioning (ADR-0073): primary at root + sub-repos in subfolders.
    const repos = reposOf(payload.spec);
    if (repos.length > 0) await provisionRepos(target, repos, emit);
    // AI init (ADR-0080): subagent files + README + CLAUDE from the spec (best-effort).
    if (payload.spec) await aiInit(target, payload.spec, emit);
    // Stamp the template-version marker (ADR-0262) so the web can later detect template drift.
    emit("version", "Writing .4pm/.4pm.json…");
    await writeTemplateMarker(target);
    onProgress?.({ projectId: payload.projectId, step: "done", message: "Scaffold complete.", done: true });
    return { ok: true, path: target };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), step: lastStep };
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
 * AI init (ADR-0080) — write `.claude/agents/<name>.md` for each declared subagent, then
 * ask the AI CLI to author `README.md` and `CLAUDE.md` from the spec. Best-effort: a
 * missing/failed AI CLI must not fail the scaffold.
 */
async function aiInit(
  target: string,
  spec: Record<string, unknown>,
  emit: (step: string, message: string) => void,
): Promise<void> {
  emit("ai-init", "AI init: subagents, README, CLAUDE.md…");
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
  // README + CLAUDE.md via the AI CLI (best-effort — skip on failure).
  const specJson = JSON.stringify(spec);
  await generateFile(
    join(target, "README.md"),
    `Write a concise README.md (Markdown only, no preamble) for this project from its spec ` +
      `JSON:\n${specJson}`,
  );
  await generateFile(
    join(target, "CLAUDE.md"),
    `Write a CLAUDE.md (Markdown only, no preamble) with guidance/conventions for AI agents ` +
      `working in this project, derived from its spec JSON:\n${specJson}`,
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
 * (`<profileDir>/<projectName>`, folder = name — ADR-0064/0080; no user-chosen path), then
 * clone/link the declared repos (ADR-0073): the existing primary repo is cloned into the
 * root, sub-repos into their subfolders. No sample template, no AI init — the codebase
 * already exists; the spec is filled later via the Spec tab (ADR-0114). Returns the path.
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
    const repos = (payload.repos ?? []) as RepoDecl[];
    // `mode` (ADR-0292): the provision job sends "sync"/"force" for the on-demand "update repos"
    // action; a plain add (project-0011) omits it ⇒ "clone" (idempotent clone-of-missing).
    const mode: ProvisionMode = payload.mode ?? "clone";
    if (repos.length > 0) await provisionRepos(target, repos, emit, { clonePrimary: true, mode });
    onProgress?.({ projectId: payload.projectId, step: "done", message: "Project added.", done: true });
    return { ok: true, path: target };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), step: lastStep };
  }
}
