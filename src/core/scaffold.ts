/**
 * Project scaffolding on the worker (project-0010/0011, project.create/add
 * channels): copy the bundled sample-project template into the target directory,
 * write the spec + provision repos + AI init (create — ADR-0080), or clone/link the
 * declared repos of an existing project with no scaffold/AI-init (add — ADR-0117).
 */
import { cp, mkdir, writeFile } from "node:fs/promises";
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
}

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

/**
 * Provision the declared repos on the worker (ADR-0172: 4PM never creates repos — every repo
 * is an existing one the user owns, given by `url`). Sub-repos always **clone** into their
 * own subfolder. The primary repo:
 *  - **add mode** (`clonePrimary`, ADR-0117): the root is empty ⇒ **clone into the root**.
 *  - **create mode**: the root already holds the copied `project-sample` template ⇒ `git init`
 *    in place + `remote add origin <url>` (the user's empty repo) so the scaffold can be pushed.
 */
async function provisionRepos(
  target: string,
  repos: RepoDecl[],
  emit: (step: string, message: string) => void,
  opts: { clonePrimary?: boolean } = {},
): Promise<void> {
  for (const repo of repos) {
    if (repo.primary) {
      if (opts.clonePrimary && repo.url) {
        emit("git", `Cloning ${repo.url}…`);
        await run("git", ["clone", repo.url, target], { timeout: 120_000 });
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
      emit("git", `Cloning sub-repo ${repo.url}…`);
      await run("git", ["clone", repo.url, dir], { timeout: 120_000 });
    } else {
      emit("git", `Initializing sub-repo ${subDirName(repo)}…`);
      await mkdir(dir, { recursive: true });
      await run("git", ["init"], { cwd: dir, timeout: 20_000 });
    }
  }
}

/** Locate the sample-project template (override via SCAFFOLD_SAMPLE_DIR). */
function sampleDir(): string {
  if (process.env.SCAFFOLD_SAMPLE_DIR) return process.env.SCAFFOLD_SAMPLE_DIR;
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "../../project-sample");
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
  const emit = (step: string, message: string): void =>
    onProgress?.({ projectId: payload.projectId, step, message });
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
    onProgress?.({ projectId: payload.projectId, step: "done", message: "Scaffold complete.", done: true });
    return { ok: true, path: target };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
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
  const emit = (step: string, message: string): void =>
    onProgress?.({ projectId: payload.projectId, step, message });
  try {
    const root = process.env.SCAFFOLD_ROOT ? resolve(process.env.SCAFFOLD_ROOT) : resolve(profileDir);
    const target = join(root, payload.projectName);
    await mkdir(target, { recursive: true });
    const repos = (payload.repos ?? []) as RepoDecl[];
    if (repos.length > 0) await provisionRepos(target, repos, emit, { clonePrimary: true });
    onProgress?.({ projectId: payload.projectId, step: "done", message: "Project added.", done: true });
    return { ok: true, path: target };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
