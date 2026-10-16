/**
 * Project system-diagram storage on the books branch — reading the diagram folder from a git ref or a directory
 * (the `.drawio` module files, `index.md`, the change requests), the modules at a past version (the commit
 * `diagram: v<N> (SDC-n)`), the `.autonomous.diagram.json` sidecar, writing module files back, and numbering new
 * change requests (`SDC-NEW-*.md` → the next `SDC-<n>.md`, with `baseVersion` / `base` filled from the master).
 * The git / directory readers and the JSON helpers are the ER store's.
 * @adr 0530 @arch 0057
 */
import { join } from "node:path";
import {
  DIAGRAM_MODULE_RE,
  DIAGRAM_SIDECAR_REL,
  coerceDiagramSidecar,
  diagramMasterOf,
  diagramPatchCells,
  diagramPatchIsEmpty,
  parseDiagramModule,
  parseSdcFile,
  sdcPatch,
  serializeDiagramModule,
  serializeSdcFile,
  type DiagramModule,
  type DiagramSidecar,
  type SdcSource,
} from "@4pm/dto";
import { gitQuiet } from "./autonomous-git";
import { dirSource, refSource, writeJson, type ErSource } from "./autonomous-er-store";
import { writeFileInRoot } from "../../utils/safe-path";

/** One module file with its parsed model (`error` when it does not parse — the model is then empty). */
export interface DiagramModuleEntry {
  name: string;
  path: string;
  content: string;
  module: DiagramModule;
  error?: string;
}

/** One change-request file. */
export interface SdcFileEntry {
  id: string;
  path: string;
  content: string;
}

/** The diagram as read from one source. */
export interface DiagramSnapshot {
  index: string;
  order: string[];
  modules: DiagramModuleEntry[];
  changes: SdcFileEntry[];
  sidecar: DiagramSidecar;
}

/** Module names in the order `index.md` mentions them (`<name>.drawio` links / words). */
function indexOrder(index: string): string[] {
  return [...new Set([...index.matchAll(/([a-z0-9][a-z0-9_-]{0,63})\.drawio\b/g)].map((m) => m[1]!))];
}

/** Position of a module in the index order (unlisted ones last). */
function rank(order: string[], name: string): number {
  const i = order.indexOf(name);
  return i < 0 ? order.length : i;
}

/** Read the diagram folder (+ the sidecar) from a source; `withChanges` false skips the SDC files. */
export async function loadDiagram(src: ErSource, diagramDir: string, withChanges = true): Promise<DiagramSnapshot> {
  const files = await src.list(diagramDir);
  const index = (await src.read(`${diagramDir}/index.md`)) ?? "";
  const modules: DiagramModuleEntry[] = [];
  const changes: SdcFileEntry[] = [];
  for (const path of files.sort()) {
    const rel = path.slice(diagramDir.length + 1);
    const mod = /^([a-z0-9][a-z0-9_-]{0,63})\.drawio$/.exec(rel);
    if (mod && DIAGRAM_MODULE_RE.test(mod[1]!)) {
      const content = (await src.read(path)) ?? "";
      const parsed = parseDiagramModule(content);
      modules.push({ name: mod[1]!, path, content, module: parsed.module, ...(parsed.errors[0] ? { error: parsed.errors[0].message } : {}) });
      continue;
    }
    const sdc = /^changes\/(SDC-[1-9]\d{0,5})\.md$/.exec(rel);
    if (sdc && withChanges) changes.push({ id: sdc[1]!, path, content: (await src.read(path)) ?? "" });
  }
  const order = indexOrder(index);
  modules.sort((a, b) => rank(order, a.name) - rank(order, b.name) || a.name.localeCompare(b.name));
  const sidecarText = await src.read(DIAGRAM_SIDECAR_REL);
  let sidecar = coerceDiagramSidecar({});
  try {
    sidecar = coerceDiagramSidecar(sidecarText ? JSON.parse(sidecarText) : {});
  } catch {
    // a corrupt sidecar reads as empty — the next apply rewrites it
  }
  return { index, order, modules, changes, sidecar };
}

/** The module models of a snapshot by name. */
export function diagramModelsOf(snap: Pick<DiagramSnapshot, "modules">): Record<string, DiagramModule> {
  return Object.fromEntries(snap.modules.map((m) => [m.name, m.module]));
}

/** Every `diagram: v<N>` commit on `ref`: version → commit. */
export async function diagramVersionCommits(cwd: string, ref: string): Promise<Map<number, string>> {
  const out = await gitQuiet(cwd, ["log", "--format=%H %s", "--grep=^diagram: v[0-9]", ref]);
  const map = new Map<number, string>();
  for (const line of out.split("\n")) {
    const m = /^([0-9a-f]{7,64}) diagram: v(\d+) \(/.exec(line.trim());
    if (m && !map.has(Number(m[2]))) map.set(Number(m[2]), m[1]!);
  }
  return map;
}

/** The module models as of `version` (0 = none) from the git history of `ref`; null when that commit is not found. */
export async function diagramModulesAtVersion(cwd: string, ref: string, diagramDir: string, version: number): Promise<Record<string, DiagramModule> | null> {
  if (version === 0) return {};
  const out = (await gitQuiet(cwd, ["log", "-1", "--format=%H", `--grep=^diagram: v${version} (`, ref])).trim();
  if (!out) return null;
  return diagramModelsOf(await loadDiagram(refSource(cwd, out), diagramDir, false));
}

/** Write the diagram sidecar in `dir`. */
export async function writeDiagramSidecar(dir: string, sidecar: DiagramSidecar): Promise<void> {
  await writeJson(dir, DIAGRAM_SIDECAR_REL, sidecar);
}

/** Write changed module models back into `dir` and list any new module in `index.md`. */
export async function writeDiagramModules(dir: string, diagramDir: string, snap: DiagramSnapshot, models: Record<string, DiagramModule>, changed: string[]): Promise<void> {
  for (const name of changed) {
    await writeFileInRoot(dir, join(dir, `${diagramDir}/${name}.drawio`), serializeDiagramModule(models[name] ?? { fileAttrs: [], pages: [], cells: [] }));
  }
  const listed = new Set(indexOrder(snap.index));
  const missing = changed.filter((m) => !listed.has(m) && models[m]);
  if (missing.length) {
    const head = snap.index.trim() ? snap.index.replace(/\s*$/, "\n") : "# System diagram modules\n\n";
    await writeFileInRoot(dir, join(dir, `${diagramDir}/index.md`), `${head}${missing.map((m) => `- [${m}](${m}.drawio)`).join("\n")}\n`);
  }
}

/** The next free SDC number (files + sidecar records — numbers are never reused). */
export function nextSdcId(snap: Pick<DiagramSnapshot, "changes" | "sidecar">): string {
  const nums = [...snap.changes.map((c) => c.id), ...Object.keys(snap.sidecar.changes)].map((id) => Number(/^SDC-(\d+)$/.exec(id)?.[1] ?? 0));
  return `SDC-${Math.max(0, ...nums) + 1}`;
}

/** A change request an agent wrote (`SDC-NEW-*.md`), not numbered yet. */
export interface NewSdcFile {
  name: string;
  content: string;
}

/**
 * Number new change requests into `dir` (a books checkout): each parsed file becomes `SDC-<n>.md` with
 * `baseVersion` = the current version and `base` = the current versions of the existing cells it touches, its
 * state `pending`. A file that does not parse, or changes nothing, is skipped (with the reason).
 */
export async function numberNewSdcs(
  dir: string,
  diagramDir: string,
  files: readonly NewSdcFile[],
  defaults: { source: SdcSource; task?: string; team?: string },
): Promise<{ created: string[]; skipped: { name: string; reason: string }[] }> {
  const snap = await loadDiagram(dirSource(dir), diagramDir);
  const master = diagramMasterOf(diagramModelsOf(snap), snap.order);
  const created: string[] = [];
  const skipped: { name: string; reason: string }[] = [];
  const at = new Date().toISOString();
  for (const f of [...files].sort((a, b) => a.name.localeCompare(b.name))) {
    const { doc, errors } = parseSdcFile(f.content);
    if (!doc) {
      skipped.push({ name: f.name, reason: errors[0]?.message ?? "invalid" });
      continue;
    }
    const meta = { ...doc.meta, source: defaults.source, ...(defaults.task ? { task: defaults.task } : {}), ...(defaults.team && !doc.meta.team ? { team: defaults.team } : {}) };
    const patch = sdcPatch(master, { meta, cells: doc.cells });
    if (diagramPatchIsEmpty(patch)) {
      skipped.push({ name: f.name, reason: "changes nothing" });
      continue;
    }
    meta.baseVersion = snap.sidecar.version;
    meta.base = Object.fromEntries(diagramPatchCells(patch).filter((id) => master.byId.has(id)).map((id) => [id, snap.sidecar.cells[id]?.v ?? 0]));
    const id = nextSdcId({ changes: [...snap.changes, ...created.map((c) => ({ id: c, path: "", content: "" }))], sidecar: snap.sidecar });
    await writeFileInRoot(dir, join(dir, `${diagramDir}/changes/${id}.md`), serializeSdcFile(id, { meta, cells: doc.cells, rationale: doc.rationale }));
    snap.sidecar.changes[id] = { state: "pending", at };
    created.push(id);
  }
  if (created.length) await writeDiagramSidecar(dir, snap.sidecar);
  return { created, skipped };
}
