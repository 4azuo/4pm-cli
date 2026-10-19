/**
 * Project ER storage on the books branch — reading the ER folder from a git ref or a directory (the module
 * files, `index.md`, the change requests), the module models at a past version (the commit `er: v<N> (ERC-n)`),
 * entity versions from the history, the `.autonomous.er.json` sidecar and the approvals / authors maps,
 * writing module files back, and numbering new change requests (`ERC-NEW-*.md` → the next `ERC-<n>.md`,
 * with `baseVersion` / `base` filled from the current model).
 * @adr 0453 @arch 0053
 */
import { readdir } from "node:fs/promises";
import { join, posix } from "node:path";
import {
  APPROVALS_SIDECAR_REL,
  AUTHORS_SIDECAR_REL,
  ER_MODULE_RE,
  ER_SIDECAR_REL,
  coerceErSidecar,
  erMasterOf,
  erPatchEntities,
  erPatchIsEmpty,
  ercPatch,
  parseErDiagram,
  parseErcFile,
  replaceErDiagramBlock,
  serializeErcFile,
  type ErModel,
  type ErSidecar,
  type ErcSource,
} from "@4pm/dto";
import { gitQuiet } from "./autonomous-git";
import { readFileInRoot, resolveForRead, writeFileInRoot } from "../../utils/safe-path";

/** The approvals / authors sidecars (shared with the books). */
export const APPROVALS_REL = APPROVALS_SIDECAR_REL;
export const AUTHORS_REL = AUTHORS_SIDECAR_REL;

/** Where the ER is read from: a git ref (`origin/autonomous-books/<base>`, a commit) or a directory. */
export interface ErSource {
  /** Repo-relative paths of every file under `dir`. */
  list(dir: string): Promise<string[]>;
  /** A file's text, or null when absent. */
  read(path: string): Promise<string | null>;
}

/** Read through `git show <ref>:<path>` / `git ls-tree`. */
export function refSource(cwd: string, ref: string): ErSource {
  return {
    list: async (dir) => (await gitQuiet(cwd, ["ls-tree", "-r", "--name-only", ref, "--", `${dir}/`])).split("\n").map((l) => l.trim()).filter(Boolean),
    read: async (path) => {
      const exists = (await gitQuiet(cwd, ["ls-tree", "--name-only", ref, "--", path])).trim();
      return exists ? gitQuiet(cwd, ["show", `${ref}:${path}`]) : null;
    },
  };
}

/** Every file under `rel` of a directory, recursively (symlink-safe). */
async function walk(root: string, rel: string): Promise<string[]> {
  const real = resolveForRead(root, join(root, rel));
  const out: string[] = [];
  for (const e of real ? await readdir(real, { withFileTypes: true }).catch(() => []) : []) {
    const child = posix.join(rel, e.name);
    if (e.isDirectory()) out.push(...(await walk(root, child)));
    else out.push(child);
  }
  return out;
}

/** Read through the file system of `root` (a books worktree, or the working tree with no remote). */
export function dirSource(root: string): ErSource {
  return {
    list: (dir) => walk(root, dir),
    read: (path) => readFileInRoot(root, join(root, path), "utf8").catch(() => null),
  };
}

/** One module file with its parsed model. */
export interface ErModuleEntry {
  name: string;
  path: string;
  content: string;
  model: ErModel;
}

/** One change-request file. */
export interface ErcFileEntry {
  id: string;
  path: string;
  content: string;
}

/** The ER as read from one source. */
export interface ErSnapshot {
  index: string;
  /** Module order from `index.md`, then by name. */
  order: string[];
  modules: ErModuleEntry[];
  changes: ErcFileEntry[];
  sidecar: ErSidecar;
}

/** Module names in the order `index.md` mentions them (`<name>.md` links / words). */
function indexOrder(index: string): string[] {
  return [...new Set([...index.matchAll(/([a-z0-9][a-z0-9_-]{0,63})\.md\b/g)].map((m) => m[1]!))].filter((n) => n !== "index");
}

/** Read the ER folder (+ the sidecar) from a source; `withChanges` false skips the ERC files. */
export async function loadEr(src: ErSource, erDir: string, withChanges = true): Promise<ErSnapshot> {
  const files = await src.list(erDir);
  const index = (await src.read(`${erDir}/index.md`)) ?? "";
  const modules: ErModuleEntry[] = [];
  const changes: ErcFileEntry[] = [];
  for (const path of files.sort()) {
    const rel = path.slice(erDir.length + 1);
    const mod = /^([a-z0-9][a-z0-9_-]{0,63})\.md$/.exec(rel);
    if (mod && mod[1] !== "index" && ER_MODULE_RE.test(mod[1]!)) {
      const content = (await src.read(path)) ?? "";
      modules.push({ name: mod[1]!, path, content, model: parseErDiagram(content).model });
      continue;
    }
    const erc = /^changes\/(ERC-[1-9]\d{0,5})\.md$/.exec(rel);
    if (erc && withChanges) changes.push({ id: erc[1]!, path, content: (await src.read(path)) ?? "" });
  }
  const order = indexOrder(index);
  modules.sort((a, b) => rank(order, a.name) - rank(order, b.name) || a.name.localeCompare(b.name));
  const sidecarText = await src.read(ER_SIDECAR_REL);
  let sidecar = coerceErSidecar({});
  try {
    sidecar = coerceErSidecar(sidecarText ? JSON.parse(sidecarText) : {});
  } catch {
    // a corrupt sidecar reads as empty — the next apply rewrites it
  }
  return { index, order, modules, changes, sidecar };
}

/** Position of a module in the index order (unlisted ones last). */
function rank(order: string[], name: string): number {
  const i = order.indexOf(name);
  return i < 0 ? order.length : i;
}

/** The module models of a snapshot by name. */
export function modelsOf(snap: Pick<ErSnapshot, "modules">): Record<string, ErModel> {
  return Object.fromEntries(snap.modules.map((m) => [m.name, m.model]));
}

/** The commit holding ER version `version` on `ref` (its `er: v<N> (…)` commit), or null. */
export async function commitOfVersion(cwd: string, ref: string, version: number): Promise<string | null> {
  const out = (await gitQuiet(cwd, ["log", "-1", "--format=%H", `--grep=^er: v${version} (`, ref])).trim();
  return out || null;
}

/** Every `er: v<N>` commit on `ref`: version → commit. */
export async function versionCommits(cwd: string, ref: string): Promise<Map<number, string>> {
  const out = await gitQuiet(cwd, ["log", "--format=%H %s", "--grep=^er: v[0-9]", ref]);
  const map = new Map<number, string>();
  for (const line of out.split("\n")) {
    const m = /^([0-9a-f]{7,64}) er: v(\d+) \(/.exec(line.trim());
    if (m && !map.has(Number(m[2]))) map.set(Number(m[2]), m[1]!);
  }
  return map;
}

/**
 * The module models as of `version` (0 = none) from git history of `ref`; null when that version's commit is
 * not found.
 */
export async function modulesAtVersion(cwd: string, ref: string, erDir: string, version: number): Promise<Record<string, ErModel> | null> {
  if (version === 0) return {};
  const commit = await commitOfVersion(cwd, ref, version);
  if (!commit) return null;
  return modelsOf(await loadEr(refSource(cwd, commit), erDir, false));
}

/** An entity's version as of ER version `at` (the number of applies that touched it up to then). */
export function entityVersionAt(sidecar: ErSidecar, entity: string, at: number): number {
  return sidecar.history.filter((h) => h.version <= at && h.entities.includes(entity)).length;
}

/** Read a JSON map file in `dir` (`{}` when absent / corrupt). */
export async function readJsonMap(dir: string, rel: string): Promise<Record<string, unknown>> {
  try {
    const v = JSON.parse(await readFileInRoot(dir, join(dir, rel), "utf8")) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Write a JSON file in `dir` (pretty, trailing newline). */
export async function writeJson(dir: string, rel: string, value: unknown): Promise<void> {
  await writeFileInRoot(dir, join(dir, rel), `${JSON.stringify(value, null, 2)}\n`);
}

/** Write the ER sidecar in `dir`. */
export async function writeErSidecar(dir: string, sidecar: ErSidecar): Promise<void> {
  await writeJson(dir, ER_SIDECAR_REL, sidecar);
}

/**
 * Write changed module models back into `dir` (the notes around each diagram kept) and list any new module in
 * `index.md`.
 */
export async function writeModules(dir: string, erDir: string, snap: ErSnapshot, models: Record<string, ErModel>, changed: string[]): Promise<void> {
  for (const name of changed) {
    const path = `${erDir}/${name}.md`;
    const prev = snap.modules.find((m) => m.name === name)?.content ?? "";
    await writeFileInRoot(dir, join(dir, path), replaceErDiagramBlock(prev, models[name] ?? { entities: [], relations: [] }, name));
  }
  const listed = new Set(indexOrder(snap.index));
  const missing = changed.filter((m) => !listed.has(m));
  if (missing.length) {
    const head = snap.index.trim() ? snap.index.replace(/\s*$/, "\n") : "# ER modules\n\n";
    await writeFileInRoot(dir, join(dir, `${erDir}/index.md`), `${head}${missing.map((m) => `- [${m}](${m}.md)`).join("\n")}\n`);
  }
}

/** The next free ERC number (files + sidecar records — numbers are never reused). */
export function nextErcId(snap: Pick<ErSnapshot, "changes" | "sidecar">): string {
  const nums = [...snap.changes.map((c) => c.id), ...Object.keys(snap.sidecar.changes)].map((id) => Number(/^ERC-(\d+)$/.exec(id)?.[1] ?? 0));
  return `ERC-${Math.max(0, ...nums) + 1}`;
}

/** A change request an agent wrote (`ERC-NEW-*.md`), not numbered yet. */
export interface NewErcFile {
  name: string;
  content: string;
}

/**
 * Number new change requests into `dir` (a books checkout): each parsed file becomes `ERC-<n>.md` with
 * `baseVersion` = the current version and `base` = the current versions of the existing entities it touches,
 * its state `pending`. A file that does not parse, or changes nothing, is skipped. Returns the ids written
 * and the skipped names (with the reason).
 */
export async function numberNewErcs(
  dir: string,
  erDir: string,
  files: readonly NewErcFile[],
  defaults: { source: ErcSource; task?: string; team?: string },
): Promise<{ created: string[]; skipped: { name: string; reason: string }[] }> {
  const snap = await loadEr(dirSource(dir), erDir);
  const master = erMasterOf(modelsOf(snap), snap.order).model;
  const created: string[] = [];
  const skipped: { name: string; reason: string }[] = [];
  const at = new Date().toISOString();
  for (const f of [...files].sort((a, b) => a.name.localeCompare(b.name))) {
    const { doc, errors } = parseErcFile(f.content);
    if (!doc) {
      skipped.push({ name: f.name, reason: errors[0]?.message ?? "invalid" });
      continue;
    }
    const meta = { ...doc.meta, source: defaults.source, ...(defaults.task ? { task: defaults.task } : {}), ...(defaults.team && !doc.meta.team ? { team: defaults.team } : {}) };
    const patch = ercPatch(master, { meta, delta: doc.delta });
    if (erPatchIsEmpty(patch)) {
      skipped.push({ name: f.name, reason: "changes nothing" });
      continue;
    }
    const existing = new Set(master.entities.map((e) => e.name));
    meta.baseVersion = snap.sidecar.version;
    meta.base = Object.fromEntries(erPatchEntities(patch).filter((n) => existing.has(n)).map((n) => [n, snap.sidecar.entities[n]?.v ?? 0]));
    const id = nextErcId({ changes: [...snap.changes, ...created.map((c) => ({ id: c, path: "", content: "" }))], sidecar: snap.sidecar });
    await writeFileInRoot(dir, join(dir, `${erDir}/changes/${id}.md`), serializeErcFile(id, { meta, delta: doc.delta, rationale: doc.rationale }));
    snap.sidecar.changes[id] = { state: "pending", at };
    created.push(id);
  }
  if (created.length) await writeErSidecar(dir, snap.sidecar);
  return { created, skipped };
}

