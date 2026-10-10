/**
 * `repo.probe` — inspect a repo branch before a project is created, with the
 * worker's own git credentials: does the declared branch exist, which branches the remote has (the
 * "create from" picker), and what the source ref already holds — a 4PM scaffold (template version), the
 * existing files the scaffold keeps / rewrites, and the resettable tracking files — plus the source's
 * `project.spec.json` for the Add-existing wizard. The tree is read with a blobless shallow
 * fetch into a temp repo; only `.4pm/.4pm.json`, `project.spec.json` and `.claude/settings.json` (its `model`) are
 * downloaded (no clone).
 * @api project-0076 @adr 0370 §4 @adr 0393 @adr 0394
 */
import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { SCAFFOLD_TRACKING_FILES } from "@4pm/dto";
import type { RepoProbeReply, RepoProbeRequest } from "@4pm/ws";
import { projectSampleDir } from "../project/scaffold";
import { branchProtection } from "./git-host";

const run = promisify(execFile);
/** Cap on the branch list returned to the wizard. */
const MAX_BRANCHES = 100;
/** Files (or folder prefixes, ending `/`) a create always rewrites (ADR-0329 + spec + AI init + marker). */
/** The spec file read for the Add-existing wizard, and its size cap. */
const SPEC_FILE = "project.spec.json";
const MAX_SPEC_BYTES = 512 * 1024;
/** The Claude project settings whose `model` the Add-existing wizard shows. */
const SETTINGS_FILE = ".claude/settings.json";
const REWRITTEN = ["project.spec.json", "README.md", "CLAUDE.md", "AGENT.md", ".4pm/.4pm.json", ".claude/settings.json", ".claude/skills/", ".claude/agents/"];

/** Run git; throws with the stderr tail on failure. */
async function git(args: string[], cwd?: string, timeout = 60_000): Promise<string> {
  const { stdout } = await run("git", args, { cwd, timeout, maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

/** Read + parse `project.spec.json` at FETCH_HEAD; absent ⇒ both null, unreadable ⇒ an error. */
async function readSourceSpec(
  tmp: string,
  files: string[],
): Promise<{ spec: Record<string, unknown> | null; specError: string | null }> {
  if (!files.includes(SPEC_FILE)) return { spec: null, specError: null };
  try {
    const size = Number((await git(["cat-file", "-s", `FETCH_HEAD:${SPEC_FILE}`], tmp)).trim());
    if (size > MAX_SPEC_BYTES) return { spec: null, specError: `${SPEC_FILE} is larger than ${MAX_SPEC_BYTES / 1024} KB.` };
    const parsed = JSON.parse(await git(["show", `FETCH_HEAD:${SPEC_FILE}`], tmp)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { spec: null, specError: `${SPEC_FILE} is not a JSON object.` };
    }
    return { spec: parsed as Record<string, unknown>, specError: null };
  } catch (err) {
    return { spec: null, specError: `${SPEC_FILE} could not be read: ${(err as Error).message.split("\n")[0]}` };
  }
}

/** `model` of `.claude/settings.json` at FETCH_HEAD; null when the file/key is absent or unreadable. */
async function readSettingsModel(tmp: string, files: string[]): Promise<string | null> {
  if (!files.includes(SETTINGS_FILE)) return null;
  try {
    const parsed = JSON.parse(await git(["show", `FETCH_HEAD:${SETTINGS_FILE}`], tmp)) as { model?: unknown };
    return typeof parsed.model === "string" && parsed.model.trim() ? parsed.model.trim() : null;
  } catch {
    return null;
  }
}

/** The template's top-level entries (what a scaffold copies without overwriting). */
async function templateEntries(): Promise<Set<string>> {
  try {
    return new Set((await readdir(projectSampleDir())).filter((n) => n !== ".git"));
  } catch {
    return new Set();
  }
}

/** One declared submodule: does its base branch exist, and is it protected? Never throws. @adr 0371 */
async function probeSubmodule(sub: { subdir: string; url: string; branch: string }): Promise<RepoProbeReply["submodules"][number]> {
  try {
    const out = await git(["ls-remote", "--symref", sub.url, "HEAD", ...(sub.branch ? [`refs/heads/${sub.branch}`] : [])], undefined, 30_000);
    const def = /ref: refs\/heads\/(\S+)\s+HEAD/.exec(out)?.[1] ?? "";
    const branch = sub.branch || def;
    const exists = !sub.branch || out.includes(`refs/heads/${sub.branch}`);
    return { subdir: sub.subdir, url: sub.url, branch, exists, protected: exists ? await branchProtection(sub.url, branch) : null, error: null };
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    return { subdir: sub.subdir, url: sub.url, branch: sub.branch, exists: false, protected: null, error: (e.stderr || e.message || String(err)).trim().slice(0, 300) };
  }
}

/** Probe `req.url` / `req.branch` (and the `base` source when the branch is missing). Never throws. */
export async function probeRepo(req: RepoProbeRequest): Promise<RepoProbeReply> {
  const empty: RepoProbeReply = { branchExists: false, defaultBranch: null, branches: [], source: null, protected: null, submodules: [], error: null };
  let tmp: string | null = null;
  try {
    const [symref, heads] = await Promise.all([
      git(["ls-remote", "--symref", req.url, "HEAD"], undefined, 30_000),
      git(["ls-remote", "--heads", req.url], undefined, 30_000),
    ]);
    const defaultBranch = /ref: refs\/heads\/(\S+)\s+HEAD/.exec(symref)?.[1] ?? null;
    const branches = heads
      .split("\n")
      .map((l) => l.split("\t")[1] ?? "")
      .filter((r) => r.startsWith("refs/heads/"))
      .map((r) => r.slice("refs/heads/".length));
    const branch = (req.branch ?? "").trim();
    const branchExists = !branch || branches.includes(branch);
    const kind = req.base?.kind ?? "default";
    const ref = branchExists ? branch || defaultBranch : kind === "empty" ? null : kind === "branch" ? (req.base?.branch ?? "").trim() || null : defaultBranch;
    // Protection of the base (ADR-0371) + each declared submodule's base: exists? protected?
    const [isProtected, submodules] = await Promise.all([
      branchExists ? branchProtection(req.url, branch || defaultBranch || "") : Promise.resolve(null),
      Promise.all((req.submodules ?? []).map(probeSubmodule)),
    ]);
    const result: RepoProbeReply = { ...empty, branchExists, defaultBranch, branches: branches.slice(0, MAX_BRANCHES), protected: isProtected, submodules };
    if (!ref) return result;
    if (!branches.includes(ref)) return { ...result, error: `Branch "${ref}" does not exist on the remote.` };

    tmp = await mkdtemp(join(tmpdir(), "4pm-probe-"));
    await git(["init", "-q"], tmp);
    await git(["remote", "add", "origin", req.url], tmp);
    await git(["fetch", "-q", "--depth", "1", "--filter=blob:none", "origin", ref], tmp, 120_000);
    const files = (await git(["ls-tree", "-r", "--name-only", "FETCH_HEAD"], tmp)).split("\n").filter(Boolean);
    const hasScaffold = files.includes(".4pm/.4pm.json");
    let templateVersion: string | null = null;
    if (hasScaffold) {
      try {
        const marker = JSON.parse(await git(["show", "FETCH_HEAD:.4pm/.4pm.json"], tmp)) as { templateVersion?: unknown };
        templateVersion = typeof marker.templateVersion === "string" ? marker.templateVersion : null;
      } catch {
        templateVersion = null;
      }
    }
    const isRewritten = (f: string): boolean => REWRITTEN.some((r) => (r.endsWith("/") ? f.startsWith(r) : f === r));
    const tracking = SCAFFOLD_TRACKING_FILES.filter((f) => files.includes(f));
    const template = await templateEntries();
    const overwrite = files.filter((f) => isRewritten(f) && !f.endsWith(".gitkeep"));
    const keep = files.filter(
      (f) => template.has(f.split("/")[0] ?? "") && !isRewritten(f) && !(tracking as readonly string[]).includes(f) && !f.endsWith(".gitkeep"),
    );
    const { spec, specError } = await readSourceSpec(tmp, files);
    const settingsModel = await readSettingsModel(tmp, files);
    return {
      ...result,
      source: { ref, hasScaffold, templateVersion, keep: keep.slice(0, 200), overwrite, tracking: [...tracking], spec, specError, settingsModel },
    };
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    return { ...empty, error: (e.stderr || e.message || String(err)).trim().split("\n").slice(-2).join(" ").slice(0, 400) };
  } finally {
    if (tmp) await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}
