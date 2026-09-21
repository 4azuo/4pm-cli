/**
 * Project scaffolding on the worker (project-0010/0011, project.create/add channels).
 * ADR-0299 (flat sibling layout): the physic-project folder is a **container**; every declared
 * repo is cloned into its own sibling folder. **create** clones + fully scaffolds each repo
 * (template + spec + AI init — ADR-0080); **add** clones each repo with no scaffold/AI-init
 * (ADR-0117). 4PM never creates repos — every repo is an existing one by `url` (ADR-0172).
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

/** Pick a repo's folder name (subdir → role → name-from-url → "repo"), sanitized. */
function folderName(repo: RepoDecl): string {
  const raw = (repo.subdir || repo.role || repoName(repo.url ?? "") || "repo").trim();
  return raw.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "repo";
}

/**
 * Assign each repo a **unique sibling-folder name** (ADR-0299), in array order — every repo
 * (the former primary included) lives in its own folder under the physic root; a name collision
 * gets a `-2`/`-3` suffix so two repos never share a folder. The result is indexed by position,
 * so callers that iterate the same `repos` array stay consistent.
 */
function repoFolders(repos: RepoDecl[]): string[] {
  const used = new Set<string>();
  return repos.map((r) => {
    const base = folderName(r);
    let name = base;
    let n = 2;
    while (used.has(name)) name = `${base}-${n++}`;
    used.add(name);
    return name;
  });
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
 * Resolve where a repo's working tree lives under the physic root (ADR-0299 — flat sibling
 * folders: every repo, the former primary included, gets its own folder). One exception keeps
 * **legacy** projects working: a project scaffolded before ADR-0299 has its **primary cloned at
 * the root** (`<target>/.git`); for those, the primary keeps operating on the root.
 */
function repoDir(target: string, repo: RepoDecl, folder: string, legacyRoot: boolean): string {
  if (repo.primary && legacyRoot) return target;
  return join(target, folder);
}

/**
 * Provision the declared repos on the worker (ADR-0172: 4PM never creates repos — every repo is an
 * existing one the user owns, given by `url`; ADR-0299: each clones into its **own sibling folder**
 * under the physic root — no repo at the root). A repo with no `url` is `git init`-ed empty (rare).
 *
 * Legacy compatibility: a pre-ADR-0299 project has its primary at `<target>/.git`; that primary
 * keeps operating on the root (detected via `legacyRoot`), so re-provisioning an old project never
 * re-clones its root primary into a new subfolder.
 *
 * `mode` (ADR-0292) controls a repo whose folder already exists: `clone` skips it (idempotent
 * clone-on-connect / add), `sync` fetch + check out the branch + fast-forward pulls it, `force`
 * deletes the folder and re-clones it fresh (destructive).
 */
async function provisionRepos(
  target: string,
  repos: RepoDecl[],
  emit: (step: string, message: string) => void,
  opts: { mode?: ProvisionMode } = {},
): Promise<void> {
  const mode: ProvisionMode = opts.mode ?? "clone";
  const legacyRoot = existsSync(join(target, ".git")); // a pre-ADR-0299 primary sits at the root
  const folders = repoFolders(repos);
  // Sibling folders to preserve when force-recloning a legacy root primary (they live under the root).
  const foldersToKeep = new Set(
    repos.map((r, i) => (r.primary && legacyRoot ? null : folders[i])).filter((f): f is string => !!f),
  );
  for (const [i, repo] of repos.entries()) {
    const folder = folders[i]!;
    const atRoot = !!repo.primary && legacyRoot;
    const dir = repoDir(target, repo, folder, legacyRoot);
    const label = repo.primary ? "primary repo" : `repo ${folder}`;
    if (!repo.url) {
      // No url (rare — ADR-0172 wants an existing repo): init an empty repo in its folder.
      if (!existsSync(join(dir, ".git"))) {
        emit("git", `Initializing ${label}…`);
        await mkdir(dir, { recursive: true });
        await run("git", ["init"], { cwd: dir, timeout: 20_000 });
      }
      continue;
    }
    // The folder already holds a clone — apply the requested mode (ADR-0288/0292).
    if (existsSync(join(dir, ".git"))) {
      if (mode === "sync") {
        await updateRepo(dir, label, repo.branch, emit);
      } else if (mode === "force" && atRoot) {
        // Legacy root primary: re-clone WITHOUT nuking the sibling folders nested under the root —
        // clone into a temp dir, then replace the root's own entries (keeping the siblings) with it.
        emit("git", `Re-cloning ${repo.url} (force)…`);
        const tmp = `${target}.4pm-reclone`;
        await rm(tmp, { recursive: true, force: true });
        await run("git", cloneArgs(repo.url, tmp, repo.branch), { timeout: 120_000 });
        for (const entry of await readdir(target)) {
          if (foldersToKeep.has(entry)) continue; // preserve a sibling repo's folder
          await rm(join(target, entry), { recursive: true, force: true });
        }
        for (const entry of await readdir(tmp)) {
          if (foldersToKeep.has(entry)) continue; // never overwrite a preserved sibling folder
          await rename(join(tmp, entry), join(target, entry));
        }
        await rm(tmp, { recursive: true, force: true });
      } else if (mode === "force") {
        emit("git", `Re-cloning ${repo.url} (force)…`);
        await rm(dir, { recursive: true, force: true });
        await run("git", cloneArgs(repo.url, dir, repo.branch), { timeout: 120_000 });
      } else {
        emit("git", `${label} already present — skipping clone.`);
      }
      continue;
    }
    emit("git", `Cloning ${repo.url}…`);
    await run("git", cloneArgs(repo.url, dir, repo.branch), { timeout: 120_000 });
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
  await provisionRepos(physicRoot, repos as RepoDecl[], emit ?? (() => undefined));
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
 * ADR-0064/0080; no user-chosen path). ADR-0299: the target is a **container**; every declared
 * repo is cloned into its own **sibling folder** and **fully scaffolded** (template + spec +
 * AI init). With no repos declared, the container itself is scaffolded (legacy single-folder).
 * Returns the resolved path (the container root).
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
    const repos = reposOf(payload.spec);
    if (repos.length > 0) {
      // Clone every repo into its sibling folder (existing-only — ADR-0172/0299), then scaffold each.
      emit("git", "Cloning repositories…");
      await provisionRepos(target, repos, emit);
      const folders = repoFolders(repos);
      for (let i = 0; i < repos.length; i++) {
        await scaffoldRepo(join(target, folders[i]!), folders[i]!, payload.spec, emit);
      }
    } else {
      // No repos declared — scaffold the container itself (legacy single-folder project).
      await scaffoldRepo(target, payload.projectName, payload.spec, emit);
    }
    // Stamp the template-version marker (ADR-0262) at the container root so the web can later
    // detect template drift (read at the physic root, unchanged by the sibling layout).
    emit("version", "Writing .4pm/.4pm.json…");
    await writeTemplateMarker(target);
    onProgress?.({ projectId: payload.projectId, step: "done", message: "Scaffold complete.", done: true });
    return { ok: true, path: target };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), step: lastStep };
  }
}

/**
 * Scaffold one repo folder (ADR-0299 §2): copy the `project-sample` template **without clobbering**
 * files the clone already tracks (`force:false`), write `project.spec.json`, then run AI init
 * (README/CLAUDE/subagents). Best-effort AI init — a missing AI CLI must not fail the scaffold.
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
    // AI init (ADR-0080): subagent files + README + CLAUDE from the spec (best-effort).
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
 * clone/link the declared repos (ADR-0299): every repo is cloned into its own **sibling folder**
 * under the container root. No sample template, no AI init — the codebase already exists; the
 * spec is filled later via the Spec tab (ADR-0114). Returns the path (the container root).
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
    if (repos.length > 0) await provisionRepos(target, repos, emit, { mode });
    // Add-one-repo from the Git subtab (ADR-0299 §4): scaffold the just-cloned folder(s) unless the
    // user Skipped (then `scaffoldRepos` is empty ⇒ the repo stays a plain clone).
    for (const sub of payload.scaffoldRepos ?? []) {
      await scaffoldRepo(join(target, sub), sub, payload.spec, emit);
    }
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
